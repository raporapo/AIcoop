/**
 * 1つのタスクを1回実行する（8.1 の、順番が来てから箱を壊すまで）。
 *
 * 流れ：
 * 1. queued のタスクを読み、社員・箱の部署・役職・箱の種類を決める → `starting`
 * 2. 始められるかを確かめる（vm の箱のドライバー、Claude のログインの資格、箱のイメージ）
 * 3. 道具ゲートを開き（ポート）、実行を作る（run_id）
 * 4. 掃除（5.4.4）→ 資格を用意（5.2.8）→ ホームの CLAUDE.md・settings.json（5.4.3）→
 *    `runtime/<run_id>/`（mcp.json・管理設定・スキル。5.1.7、5.3.6、5.3.8）
 * 5. 箱を起こす（監査ログ `box.lifecycle` start）→ `running` → `claude -p`（5.4.2）
 * 6. stream-json を1行ずつ記録（伏せ字。11.5）し、セッション（5.4.5）と利用枠（5.4.6）を読む
 * 7. 終わったら結果を決める（5.5.6・5.5.5・5.4.6）
 * 8. 必ず（例外のときも）箱を壊す（`box.lifecycle` stop）・ゲートを閉じる・`runtime/<run_id>/` を消す・
 *    実行を終える。そのあとでタスクを終わりの状態にする（箱が残っているうちに、同じ部署の次の実行が
 *    始まらないように）
 *
 * `done` は拒否しない。失敗も、タスクの状態として返す。
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_METADATA_FILE, imageDir } from "@aicoop/box-gondolin";
import {
  type Box,
  type BoxKind,
  type BoxSpec,
  buildClaudeMd,
  buildTaskPrompt,
  buildToolsAndRules,
  type CompanyConfig,
  type EffectivePermission,
  effectivePermissionsFor,
  isTerminalTaskStatus,
  promptFilesFor,
  type ResolvedMember,
  resolveMember,
  type TaskStatus,
  USAGE_RETRY_DELAY_MS,
} from "@aicoop/shared";
import type { Logger } from "pino";
import { appendAudit } from "../db/audit.ts";
import { activeGrantsFor } from "../db/grants.ts";
import { createRun, finishRun, setRunSessionId } from "../db/runs.ts";
import type { RunEndReason } from "../db/schema.ts";
import { getSession, saveSession } from "../db/sessions.ts";
import {
  getTask,
  InvalidTaskTransitionError,
  recordTaskResult,
  type Task,
  TaskNotFoundError,
  TaskStateError,
  transitionTask,
} from "../db/tasks.ts";
import { setUsageState } from "../db/usage.ts";
import {
  type Gateway,
  openGateway,
  ReportRejectedError,
  type ReportResult,
} from "../gateway/server.ts";
import { createProxyHandler } from "../proxy/decide.ts";
import { CredentialError, prepareBoxSecrets, readAnthropicToken } from "../secrets/issue.ts";
import { BOX_ENV, claudeArgv, claudeExecEnv, isSafeSessionId } from "./claude-command.ts";
import { cleanupBeforeRun } from "./cleanup.ts";
import { GUEST_PATHS, vmMounts } from "./mounts.ts";
import { createRedactor, type Redactor } from "./redact.ts";
import { prepareRuntimeDir, removeRuntimeDir, writeHomeClaudeFiles } from "./runtime-files.ts";
import { parseStreamLine, usageLimitInResult } from "./stream-json.ts";
import type { CancelReason, RunEnvironment, RunHandle, RunOutcome, StartRun } from "./types.ts";

export interface StartRunOptions {
  /** 時間制限（ミリ秒）。既定はタスクの timeout_minutes（5.5.5）。テストで短くする */
  readonly timeoutMs?: (task: Task) => number;
  /** 止めたあと、Claude Code の終わりと出力の読み終わりを待つ時間（ミリ秒、既定 15000） */
  readonly stopWaitMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** 失敗の理由に入れる、Claude Code の結果の文の長さの上限 */
const MAX_REASON_CHARS = 200;

/** 順番が来た queued のタスクを1つ実行し始める。すぐに返る（箱の起動などは裏で進む） */
export const startRun: StartRun = createStartRun();

export function createStartRun(options: StartRunOptions = {}): StartRun {
  return (env, request) => {
    const task = getTask(env.db, request.taskId);
    if (task === undefined) throw new TaskNotFoundError(request.taskId);
    const resolved = resolveMember(request.config, task.memberId) ?? null;
    const groupId = resolved?.group.id ?? task.groupId;
    const boxKind: BoxKind =
      resolved?.group.box ?? request.config.groups[task.groupId]?.box ?? "vm";
    const startedAt = (env.now ?? env.db.now)().toISOString();

    const execution = new RunExecution(env, request.config, task, resolved, groupId, options);
    const done: Promise<RunOutcome> =
      task.status === "queued"
        ? execution.start()
        : Promise.resolve({ taskId: task.id, status: task.status, runId: null });

    return {
      taskId: task.id,
      groupId,
      memberId: task.memberId,
      boxKind,
      startedAt,
      runId: () => execution.runId,
      done,
      async cancel(reason) {
        execution.requestStop(reason);
        await done;
      },
    } satisfies RunHandle;
  };
}

/** 始められない・続けられない（利用者に見せる日本語の理由） */
class RunFailure extends Error {
  override name = "RunFailure";
}

/** 取り消し・停止で、途中でやめる */
class Stopped extends Error {
  override name = "Stopped";
}

interface Outcome {
  readonly status: TaskStatus;
  readonly error?: string;
  readonly retryAt?: string;
}

type Phase = "queued" | "starting" | "running" | "finished";

class RunExecution {
  runId: string | null = null;

  readonly #env: RunEnvironment;
  readonly #config: CompanyConfig;
  readonly #task: Task;
  readonly #member: ResolvedMember | null;
  readonly #groupId: string;
  readonly #options: StartRunOptions;
  readonly #now: () => Date;
  #log: Logger;

  #phase: Phase = "queued";
  #cancel: CancelReason | null = null;
  #timedOut = false;
  #onStop: (() => void) | null = null;
  #reported = false;
  #redact: Redactor = createRedactor([]);

  #gateway: Gateway | null = null;
  #box: Box | null = null;
  #exitCode: number | null = null;
  #endReason: RunEndReason = "exited";
  #logPath: string | null = null;
  #sessionSaved = false;
  #lastRateLimit: Extract<ReturnType<typeof parseStreamLine>, { kind: "rate_limit" }> | null = null;
  #lastResult: Extract<ReturnType<typeof parseStreamLine>, { kind: "result" }> | null = null;

  constructor(
    env: RunEnvironment,
    config: CompanyConfig,
    task: Task,
    member: ResolvedMember | null,
    groupId: string,
    options: StartRunOptions,
  ) {
    this.#env = env;
    this.#config = config;
    this.#task = task;
    this.#member = member;
    this.#groupId = groupId;
    this.#options = options;
    this.#now = env.now ?? env.db.now;
    this.#log = env.logger.child({ task: task.id, member: task.memberId, group: groupId });
  }

  /** 取り消し・停止を頼む（すぐに返る。終わりは done で待つ） */
  requestStop(reason: CancelReason): void {
    if (this.#phase === "finished") return;
    this.#cancel ??= reason;
    this.#onStop?.();
  }

  start(): Promise<RunOutcome> {
    return this.#execute().catch((error: unknown) => {
      // ここまで来るのは、片付けやタスクの状態の書き込みにも失敗したときだけ
      this.#log.error({ err: this.#safeError(error) }, "実行の後始末に失敗しました");
      let status: TaskStatus = "failed";
      try {
        status = getTask(this.#env.db, this.#task.id)?.status ?? "failed";
      } catch {
        // state.db も読めない。failed として返す
      }
      return { taskId: this.#task.id, status, runId: this.runId };
    });
  }

  async #execute(): Promise<RunOutcome> {
    // 箱を起こす前に取り消された
    await Promise.resolve();
    if (this.#cancel !== null) return this.#settle(this.#stoppedOutcome());

    try {
      transitionTask(this.#env.db, this.#task.id, "starting");
    } catch {
      // ほかの者が先に状態を変えた（取り消しなど）。何もしない
      this.#phase = "finished";
      const current = getTask(this.#env.db, this.#task.id);
      return { taskId: this.#task.id, status: current?.status ?? "failed", runId: null };
    }
    this.#phase = "starting";

    let outcome: Outcome;
    try {
      outcome = await this.#body();
    } catch (error) {
      if (error instanceof Stopped) outcome = this.#stoppedOutcome();
      else if (error instanceof RunFailure) outcome = { status: "failed", error: error.message };
      else {
        this.#log.error({ err: this.#safeError(error) }, "実行の途中で予期しないエラー");
        outcome = {
          status: "failed",
          error: this.#redact(`実行の途中で予期しないエラーが起きました（${shortMessage(error)}）`),
        };
      }
    }
    await this.#teardown();
    return this.#settle(outcome);
  }

  // ---- 本体 ----

  async #body(): Promise<Outcome> {
    const db = this.#env.db;
    const member = this.#member;
    if (member === null) {
      throw new RunFailure(
        `社員「${this.#task.memberId}」が設定（members.yaml）にいないか、AI の社員ではありません。設定を直して aicoop reload してから、頼み直してください`,
      );
    }
    const kind = member.group.box;
    if (kind !== "vm") {
      throw new RunFailure(
        kind === "srt"
          ? `部署「${this.#groupId}」の箱の種類 srt は、まだ使えません（P4 で対応します）。groups.yaml でこの部署の box を vm にしてください`
          : `箱の種類 none（CEO）の実行は、まだ使えません（P4 で対応します）`,
      );
    }
    const driver = this.#env.drivers.vm;
    if (driver === undefined) {
      throw new RunFailure(
        "この PC では vm の箱を動かせません（vm の箱のドライバーがありません）。Gondolin は Linux（KVM が使えること）と macOS で動きます。Windows では WSL2 の中で aicoop daemon を動かしてください",
      );
    }
    const anthropic = readAnthropicToken(this.#env.paths.secrets);
    if (!anthropic.ok) throw new RunFailure(anthropic.error);
    this.#redact = createRedactor([anthropic.token]);
    const image = this.#image(member);
    const prompts = this.#prompts();
    this.#checkStop();

    // 道具ゲートを開いてから実行を作る（実行にはゲートのポートを書く）
    this.#gateway = await openGateway({
      db,
      memberId: member.id,
      taskId: this.#task.id,
      workDir: this.#env.paths.groupWork(this.#groupId),
      onReport: (result) => this.#onReport(result),
      logger: this.#log,
    });
    const resume = this.#resumeSessionId();
    const run = createRun(db, {
      taskId: this.#task.id,
      groupId: this.#groupId,
      memberId: member.id,
      boxKind: "vm",
      gatewayPort: this.#gateway.port,
      logDir: this.#env.paths.runLogsDir,
      sessionId: resume,
    });
    this.runId = run.id;
    this.#logPath = run.logPath;
    this.#log = this.#log.child({ run: run.id });
    this.#log.info({ resume: resume !== null }, "実行を始めます");
    this.#checkStop();

    // 5.4.4：掃除（箱を起こす前に、ホスト側で）
    const cleaned = cleanupBeforeRun({
      db,
      paths: this.#env.paths,
      runId: run.id,
      groupId: this.#groupId,
      memberId: member.id,
    });
    if (cleaned.quarantined.length > 0) {
      this.#log.warn(
        { quarantined: cleaned.quarantined },
        "作業フォルダの直下の設定ファイルを隔離しました",
      );
    }

    // 5.2.8：資格を用意する
    const effective = effectivePermissionsFor(this.#config, member.id, {
      grants: activeGrantsFor(db, member.id),
      now: this.#now(),
    });
    const prepared = await this.#prepareSecrets(effective);
    this.#redact = createRedactor([anthropic.token, ...prepared.realValues]);
    for (const service of prepared.missing) {
      this.#log.warn({ service }, `資格 ${service} が登録されていないので、箱に渡しません`);
    }
    this.#checkStop();

    // 5.4.3・5.1.7：ファイルを書く
    const toolsAndRules =
      buildToolsAndRules({
        catalog: this.#config.catalog,
        effective,
        tools: [],
        workDir: GUEST_PATHS.work,
      }) + missingSecretsNote(prepared.missing);
    writeHomeClaudeFiles(
      this.#env.paths.memberHome(member.id),
      buildClaudeMd({ ...prompts, toolsAndRules }),
    );
    const skills = prepareRuntimeDir(this.#env.paths, run.id, member.role.skills);
    for (const skill of skills.missing) {
      this.#log.warn({ skill }, `スキル ${skill} が ~/.aicoop/skills/ にないので、渡しません`);
    }

    // 5.1.7・5.1.4：箱を起こす
    const spec: BoxSpec = {
      groupId: this.#groupId,
      memberId: member.id,
      runId: run.id,
      kind: "vm",
      memoryMiB: member.group.memory_mib,
      cpus: member.group.cpus,
      ...(image === undefined ? {} : { image }),
      mounts: vmMounts(this.#env.paths, {
        runId: run.id,
        groupId: this.#groupId,
        memberId: member.id,
      }),
      env: { ...BOX_ENV },
      secrets: prepared.secrets,
      network: {
        passthroughHosts: [...this.#config.aicoop.anthropic_passthrough_hosts],
        gatewayPort: this.#gateway.port,
        onRequest: createProxyHandler({
          db,
          paths: this.#env.paths,
          config: this.#config,
          runId: run.id,
          taskId: this.#task.id,
          memberId: member.id,
          thread: this.#task.thread,
          logger: this.#log,
          now: this.#now,
        }),
      },
    };
    try {
      this.#box = await driver.create(spec);
    } catch (error) {
      this.#log.error({ err: this.#safeError(error) }, "箱を起動できませんでした");
      throw new RunFailure(
        this.#redact(
          `箱（vm）を起動できませんでした（${shortMessage(error)}）。aicoop image build で箱のイメージを作ったか、この PC で KVM（Linux）・仮想化（macOS）が使えるかを確かめてください`,
        ),
      );
    }
    this.#audit("start");
    this.#checkStop();

    try {
      transitionTask(db, this.#task.id, "running");
    } catch (error) {
      // 箱を起こしているあいだに、ほかの者がタスクを取り消した（cancelTask）
      if (!(error instanceof InvalidTaskTransitionError)) throw error;
      this.#cancel ??= "cancelled";
      throw new Stopped();
    }
    this.#phase = "running";
    // 取り消しが transition のあいだに来ていたら、すぐ止める
    this.#checkStop();

    // 5.4.2：claude -p を起動する
    const argv = claudeArgv({
      prompt: buildTaskPrompt({
        purpose: this.#task.purpose,
        doneWhen: this.#task.doneWhen,
        replyAs: this.#task.replyAs,
        context: this.#task.context,
        contextUntrusted: this.#task.contextUntrusted,
      }),
      model: member.role.model,
      maxTurns: member.role.max_turns,
      resume,
    });
    await this.#runClaude(this.#box, argv, claudeExecEnv(anthropic.token));
    return this.#decide();
  }

  /** Claude Code を動かし、終わる（か、止める）まで待つ */
  async #runClaude(box: Box, argv: string[], env: Record<string, string>): Promise<void> {
    mkdirSync(this.#env.paths.runLogsDir, { recursive: true });
    if (this.#logPath !== null) appendFileSync(this.#logPath, "", { mode: 0o600 });

    let handle: ReturnType<Box["exec"]>;
    try {
      handle = box.exec(argv, { cwd: GUEST_PATHS.work, env });
    } catch (error) {
      throw new RunFailure(
        this.#redact(`Claude Code を起動できませんでした（${shortMessage(error)}）`),
      );
    }
    const reading = (async () => {
      for await (const line of handle) this.#onLine(line.stream, line.line);
    })().catch((error: unknown) => {
      this.#log.warn({ err: this.#safeError(error) }, "Claude Code の出力を読めませんでした");
    });
    const exited = handle.exitCode.then(
      (code) => ({ kind: "exit" as const, code }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const stopped = new Promise<{ kind: "stop" }>((resolve) => {
      this.#onStop = () => resolve({ kind: "stop" });
      if (this.#cancel !== null) resolve({ kind: "stop" });
    });
    const timeoutMs = this.#options.timeoutMs?.(this.#task) ?? this.#task.timeoutMinutes * 60_000;
    const timer = setTimeout(() => {
      this.#timedOut = true;
      this.#onStop?.();
    }, timeoutMs);

    try {
      const first = await Promise.race([exited, stopped]);
      if (first.kind === "stop") {
        this.#log.info({ reason: this.#cancel ?? "timeout" }, "Claude Code を止めます");
        await box.kill().catch((error: unknown) => {
          this.#log.warn({ err: this.#safeError(error) }, "Claude Code を止められませんでした");
        });
        const late = await withTimeout(exited, this.#stopWaitMs());
        this.#exitCode = late?.kind === "exit" ? late.code : null;
        this.#endReason = this.#cancel !== null ? "killed" : "timeout";
      } else if (first.kind === "exit") {
        this.#exitCode = first.code;
      } else {
        this.#log.warn(
          { err: this.#safeError(first.error) },
          "Claude Code の終わり方が分かりません",
        );
      }
    } finally {
      clearTimeout(timer);
      this.#onStop = null;
    }
    await withTimeout(reading, this.#stopWaitMs());
  }

  /** 7. 結果を決める */
  #decide(): Outcome {
    if (this.#cancel !== null) return this.#stoppedOutcome();
    if (this.#timedOut) return { status: "timeout" };
    if (this.#reported) return { status: "done" };

    const limited = this.#usageLimit();
    if (limited !== null) return limited;
    if (this.#exitCode === 0) return { status: "done_without_report" };
    return { status: "failed", error: this.#failureReason() };
  }

  /** 5.4.6 の2：利用枠のために止まったなら waiting_limit */
  #usageLimit(): Outcome | null {
    const rate = this.#lastRateLimit;
    const result = this.#lastResult;
    let resetsAt: string | null;
    let rateLimitType: string | null = null;
    if (rate?.status === "rejected") {
      resetsAt = rate.resetsAt;
      rateLimitType = rate.rateLimitType;
    } else {
      const errored = result?.isError === true || this.#exitCode !== 0;
      const text = errored ? usageLimitInResult(result?.text ?? null) : null;
      if (text === null) return null;
      resetsAt = text.resetsAt;
    }
    // 再開予定時刻が分からないときは1時間後とみなす（止まりっぱなしにしない）
    const resets = resetsAt ?? new Date(this.#now().getTime() + HOUR_MS).toISOString();
    setUsageState(this.#env.db, {
      status: "rejected",
      resetsAt: resets,
      rateLimitType,
      utilization: rate?.status === "rejected" ? rate.utilization : null,
    });
    const retryAt = new Date(Date.parse(resets) + USAGE_RETRY_DELAY_MS).toISOString();
    this.#log.warn({ resetsAt: resets }, "利用枠の上限で止まりました");
    return { status: "waiting_limit", retryAt };
  }

  #failureReason(): string {
    const code = this.#exitCode;
    const head =
      code === null
        ? "Claude Code の終わり方が分かりません"
        : `Claude Code が終了コード ${code} で終わりました`;
    const result = this.#lastResult;
    if (result === null) {
      const hint =
        code === 127
          ? "。箱の中に claude がありません。aicoop image build で箱のイメージを作り直してください"
          : "";
      return `${head}（stream-json に result がありません）${hint}`;
    }
    const text = result.text === null ? "" : oneLine(this.#redact(result.text));
    const detail = [result.subtype, text].filter((s) => s !== null && s !== "").join("：");
    return detail === "" ? head : `${head}（${detail}）`;
  }

  // ---- stream-json ----

  #onLine(stream: "stdout" | "stderr", raw: string): void {
    const redacted = this.#redact(raw);
    let record: string;
    if (stream === "stderr") {
      record = JSON.stringify({ type: "aicoop_stderr", text: redacted });
    } else if (isJsonObject(redacted)) {
      record = redacted;
    } else {
      record = JSON.stringify({ type: "aicoop_stdout_text", text: redacted });
    }
    if (this.#logPath !== null) appendFileSync(this.#logPath, `${record}\n`, { mode: 0o600 });
    if (stream !== "stdout") return;

    const event = parseStreamLine(raw);
    try {
      switch (event.kind) {
        case "init":
          this.#onInit(event.sessionId);
          break;
        case "rate_limit":
          this.#lastRateLimit = event;
          setUsageState(this.#env.db, {
            status: event.status,
            resetsAt: event.resetsAt,
            rateLimitType: event.rateLimitType,
            utilization: event.utilization,
          });
          break;
        case "result":
          this.#lastResult = event;
          break;
        case "other":
          break;
      }
    } catch (error) {
      this.#log.warn({ err: this.#safeError(error) }, "stream-json の行を記録できませんでした");
    }
  }

  /** 5.4.5 の3：最初の init の session_id を、実行とセッション（社員, スレッド）に記録する */
  #onInit(sessionId: string): void {
    if (this.#sessionSaved || this.runId === null) return;
    if (!isSafeSessionId(sessionId)) {
      this.#log.warn("形の不正なセッションIDなので、記録しません");
      return;
    }
    this.#sessionSaved = true;
    setRunSessionId(this.#env.db, this.runId, sessionId);
    saveSession(this.#env.db, {
      memberId: this.#task.memberId,
      thread: this.#task.thread,
      sessionId,
    });
  }

  /** 5.5.6 の1：report_result を記録する（2回目以降は、あとのもので上書きする） */
  #onReport(result: ReportResult): void {
    if (this.#phase !== "running" || this.#cancel !== null || this.#timedOut) {
      throw new ReportRejectedError("このタスクはもう動いていないので、結果を記録できません");
    }
    try {
      recordTaskResult(this.#env.db, this.#task.id, result);
    } catch (error) {
      if (error instanceof TaskStateError) {
        throw new ReportRejectedError("このタスクはもう動いていないので、結果を記録できません");
      }
      throw error;
    }
    this.#reported = true;
  }

  // ---- 始める前の確かめ ----

  /** 部署のイメージ（packages があれば必須）、なければベースのイメージ、どちらもなければドライバーの既定 */
  #image(member: ResolvedMember): string | undefined {
    const home = this.#env.paths.home;
    const built = (dir: string) => existsSync(join(dir, IMAGE_METADATA_FILE));
    if (member.group.packages.length > 0) {
      const dir = imageDir(home, this.#groupId);
      if (!built(dir)) {
        throw new RunFailure(
          `部署「${this.#groupId}」の箱のイメージ（packages を入れたもの）がありません。aicoop image build --group ${this.#groupId} で作ってください`,
        );
      }
      return dir;
    }
    const base = imageDir(home);
    return built(base) ? base : undefined;
  }

  #prompts(): { company: string; group: string | null; role: string; member: string | null } {
    const files = promptFilesFor(this.#config, this.#task.memberId);
    const read = (path: string | undefined) =>
      path === undefined ? null : (this.#config.prompts.get(path) ?? null);
    const company = read(files?.company);
    const role = read(files?.role);
    if (files === undefined || company === null || role === null) {
      throw new RunFailure(
        "プロンプトのファイル（prompts/company.md か、役職のやり方の md）が読めません。aicoop check で確かめてください",
      );
    }
    return { company, group: read(files.group), role, member: read(files.member) };
  }

  /** 5.4.5：同じ（社員, スレッド）のセッションがあり、max_idle_days を過ぎていなければ、その ID */
  #resumeSessionId(): string | null {
    const session = getSession(this.#env.db, this.#task.memberId, this.#task.thread);
    if (session === undefined || !isSafeSessionId(session.sessionId)) return null;
    const idle = this.#now().getTime() - Date.parse(session.lastUsedAt);
    const maxIdle = this.#config.aicoop.sessions.max_idle_days * DAY_MS;
    return Number.isFinite(idle) && idle <= maxIdle ? session.sessionId : null;
  }

  async #prepareSecrets(effective: readonly EffectivePermission[]) {
    try {
      return await prepareBoxSecrets({
        config: this.#config,
        effective,
        secretsPath: this.#env.paths.secrets,
        fetch: this.#env.fetch ?? globalThis.fetch,
        now: this.#now(),
      });
    } catch (error) {
      if (error instanceof CredentialError) throw new RunFailure(error.message);
      throw error;
    }
  }

  // ---- 止める・片付ける ----

  #checkStop(): void {
    if (this.#cancel !== null) throw new Stopped();
  }

  #stoppedOutcome(): Outcome {
    const reason = this.#cancel ?? "cancelled";
    if (reason === "cancelled") return { status: "cancelled" };
    // daemon_stop：Claude Code が動き出していれば failed、まだなら順番待ちに戻す（8.6 の3 と同じ）
    return this.#phase === "running"
      ? { status: "failed", error: "daemon_stopped" }
      : { status: "queued" };
  }

  /** 8. 必ず：箱を壊す・ゲートを閉じる・runtime/<run_id>/ を消す・実行を終える */
  async #teardown(): Promise<void> {
    const box = this.#box;
    this.#box = null;
    if (box !== null) {
      try {
        await box.destroy();
        this.#audit("stop");
      } catch (error) {
        this.#log.error({ err: this.#safeError(error) }, "箱を壊せませんでした");
      }
    }
    if (this.#gateway !== null) {
      await this.#gateway.close().catch(() => {});
      this.#gateway = null;
    }
    if (this.runId !== null) {
      try {
        removeRuntimeDir(this.#env.paths, this.runId);
      } catch (error) {
        this.#log.error(
          { err: this.#safeError(error) },
          "runtime の実行のフォルダを消せませんでした",
        );
      }
      try {
        finishRun(this.#env.db, this.runId, {
          exitCode: this.#exitCode,
          endReason: this.#endReason,
        });
      } catch (error) {
        this.#log.error({ err: this.#safeError(error) }, "実行を終えられませんでした");
      }
    }
  }

  /** タスクを終わりの状態にする。ほかの者が先に終わらせていたら、そのままにする */
  #settle(outcome: Outcome): RunOutcome {
    this.#phase = "finished";
    const db = this.#env.db;
    const current = getTask(db, this.#task.id);
    if (current === undefined) {
      return { taskId: this.#task.id, status: outcome.status, runId: this.runId };
    }
    if (isTerminalTaskStatus(current.status) || current.status === outcome.status) {
      return { taskId: this.#task.id, status: current.status, runId: this.runId };
    }
    try {
      const after = transitionTask(db, this.#task.id, outcome.status, {
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.retryAt === undefined ? {} : { retryAt: outcome.retryAt }),
      });
      this.#log.info({ status: after.status }, "実行が終わりました");
      return { taskId: this.#task.id, status: after.status, runId: this.runId };
    } catch (error) {
      this.#log.error(
        { err: this.#safeError(error), to: outcome.status },
        "タスクの状態を変えられませんでした",
      );
      const fallback = getTask(db, this.#task.id);
      return {
        taskId: this.#task.id,
        status: fallback?.status ?? outcome.status,
        runId: this.runId,
      };
    }
  }

  #audit(event: "start" | "stop"): void {
    if (this.runId === null) return;
    appendAudit(this.#env.db, {
      actor: "system",
      kind: "box.lifecycle",
      subject: this.runId,
      data: { group: this.#groupId, box_kind: "vm", event },
    });
  }

  #stopWaitMs(): number {
    return this.#options.stopWaitMs ?? 15_000;
  }

  /** ログに書いてよい形のエラー（伏せ字にした名前とメッセージだけ。スタックは書かない） */
  #safeError(error: unknown): { name: string; message: string } {
    return {
      name: error instanceof Error ? error.name : typeof error,
      message: this.#redact(shortMessage(error)),
    };
  }
}

/** 未登録の資格を「使える道具とルール」に書き足す */
function missingSecretsNote(missing: readonly string[]): string {
  if (missing.length === 0) return "";
  const lines = [
    "",
    "## 登録されていない資格",
    "",
    ...missing.map(
      (s) =>
        `- サービス \`${s}\` の資格が、まだ登録されていません。\`${s}\` の操作は、上の一覧で許可されていても、外のサービスで認証エラーになります。できなかったことは報告に書いてください。`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function shortMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return oneLine(message);
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_REASON_CHARS ? `${flat.slice(0, MAX_REASON_CHARS)}…` : flat;
}

function isJsonObject(line: string): boolean {
  if (!line.startsWith("{")) return false;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
