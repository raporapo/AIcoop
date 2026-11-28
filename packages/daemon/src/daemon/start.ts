/**
 * 制御サーバー本体（`aicoop daemon`。4.3、6.1、8.6、9.2、11.5）。
 *
 * 起動の順：
 * 1. 設定を読む（エラーなら起動しない。`DaemonStartError` の `issues` に誤りを入れる。6.1・6.10）
 * 2. すでに同じ home で daemon が動いていれば起動しない（`runtime/daemon.json` の pid と `runtime/daemon.lock`）
 * 3. ログ（11.5）と state.db を開く → 監査ログ `config.load`（5.10）→ 再起動の後始末（8.6）
 *    → 保存期間を過ぎた監査ログ・ログ・決まった保留のファイルを消す（5.10 の5、11.5、`holds/prune.ts`。
 *    このあと1日1回）
 * 4. ローカルAPI のトークン（ランダム、`runtime/api_token`、0600、起動ごとに作り直す。9.2）
 * 5. API を `127.0.0.1:<daemon.port>` で待ち受ける（4.3 の2）→ `runtime/daemon.json`
 * 6. トリガー（cron）→ 順番待ちのループ
 *
 * 止めるとき（`stop`・`POST /shutdown`・`handleSignals` なら SIGINT・SIGTERM）：
 * 新しいタスクを始めず、トリガーを止め、動いている実行をすべて `cancel("daemon_stop")` して待ち、
 * API を閉じ、`daemon.json`・`api_token` を消し、state.db を閉じる。
 */
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createGondolinDriver } from "@aicoop/box-gondolin";
import {
  type AuditActor,
  type CompanyConfig,
  type ConfigIssue,
  type CronTriggerConfig,
  loadConfig,
} from "@aicoop/shared";
import type { Logger } from "pino";
import type { DaemonInfo, RunningBoxView, TriggerView } from "../api/contract.ts";
import { defaultApproverDir } from "../api/routes/app.ts";
import {
  type ApiControl,
  closeApiServer,
  createApiApp,
  createApiServer,
  listenApi,
} from "../api/server.ts";
import { createApprovalService } from "../approvals/service.ts";
import type { ApprovalTargets } from "../approvals/types.ts";
import { appendAudit, pruneAuditLog } from "../db/audit.ts";
import { openStateDb, type StateDb } from "../db/open.ts";
import { recoverAfterRestart } from "../db/restart.ts";
import type { HoldDeps } from "../holds/deps.ts";
import { expireDue } from "../holds/expire.ts";
import { pruneResolvedHoldFiles } from "../holds/prune.ts";
import { recoverReplays } from "../holds/replay.ts";
import { createHoldTargets } from "../holds/targets.ts";
import { createDaemonLogger, type LineStream, pruneOldLogs } from "../log.ts";
import { aicoopPaths } from "../paths.ts";
import { removeStaleRuntimeDirs } from "../run/runtime-files.ts";
import type { BoxDrivers, RunEnvironment, StartRun } from "../run/types.ts";
import { createTaskScheduler, type TaskScheduler } from "../scheduler/scheduler.ts";
import { createSettings } from "../settings/service.ts";
import { createClaudeLogin } from "../setup/claude-login.ts";
import { defaultReadinessHost } from "../setup/host.ts";
import { createImageBuilds, type ImageBuildRunner } from "../setup/image-build.ts";
import type { SpawnPty } from "../setup/pty.ts";
import type { ReadinessHost } from "../setup/readiness.ts";
import { createSetup } from "../setup/service.ts";
import { systemTimers, type TimerHandle, type Timers } from "../timers.ts";
import { checkRunnableMember } from "../triggers/runnable.ts";
import { createCronTask, startTriggers, type TriggerSet } from "../triggers/triggers.ts";
import {
  acquireDaemonLock,
  type DaemonLock,
  isProcessAlive,
  readDaemonInfo,
  writePrivateFile,
} from "./runtime-files.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_FILE = "daemon.lock";
/** 保留・一時権限の期限を見る間隔 */
const HOLD_EXPIRY_INTERVAL_MS = 60 * 1000;

export type DaemonStartErrorCode =
  /** 設定にエラーがある（issues に誤り） */
  | "config_invalid"
  /** 同じ home で daemon が動いている */
  | "already_running"
  /** daemon.port が使われている */
  | "port_in_use"
  /** そのほか（state.db が開けないなど） */
  | "start_failed";

/** daemon を起動できなかった。`message` は利用者に見せる日本語 */
export class DaemonStartError extends Error {
  override name = "DaemonStartError";
  readonly code: DaemonStartErrorCode;
  /** 設定の誤り（config_invalid のとき。CLI が並べて見せる） */
  readonly issues: readonly ConfigIssue[];
  constructor(
    code: DaemonStartErrorCode,
    message: string,
    issues: readonly ConfigIssue[] = [],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.issues = issues;
  }
}

export interface StartDaemonOptions {
  /** 会社の設定の置き場所（`~/.aicoop`） */
  readonly home: string;
  /** 1件の実行（8.1）。順番が来たタスクごとに呼ぶ */
  readonly startRun: StartRun;
  /** 箱の種類ごとのドライバー。既定は `{ vm: createGondolinDriver() }` */
  readonly drivers?: BoxDrivers;
  /** 待ち受けるポート。なければ aicoop.yaml の daemon.port（0 なら空いているポート。テスト用） */
  readonly port?: number;
  /** 標準出力にも、人が読める形でログを出す（`aicoop daemon` を前面で動かすとき） */
  readonly logToStdout?: boolean | LineStream;
  /** 時刻の元（テスト用） */
  readonly now?: () => Date;
  /** 実行が外へ HTTP を送るときの fetch（テスト用。RunEnvironment に渡す） */
  readonly fetch?: typeof fetch;
  /** SIGINT・SIGTERM を受けたら止める（`aicoop daemon` は true にする） */
  readonly handleSignals?: boolean;
  /** タイマー（テスト用。cron・見直し・1日1回の片付け） */
  readonly timers?: Timers;
  /** 止めるときに、実行が終わるのを待つ長さの上限（ミリ秒。既定 60000） */
  readonly stopTimeoutMs?: number;
  /** オーナーの承認を待つ対象（保留・一時権限など。5.8 の3）。なければ、どの種類も承認できない */
  readonly approvalTargets?: ApprovalTargets;
  /** 承認アプリの静的ファイルの場所（既定：packages/approver/dist。テスト用） */
  readonly approverDir?: string;
  /** 準備の画面（5.14 の3）が使う、この PC の部品 */
  readonly setup?: SetupOptions;
}

/** 準備の画面（5.14 の3）が使う、この PC の部品。どれも、なければ daemon のプロセスのもの */
export interface SetupOptions {
  /** 準備の確認が見る OS・PATH（テスト用） */
  readonly host?: Partial<ReadinessHost>;
  /** `script … claude setup-token` を動かす（テスト用） */
  readonly spawnPty?: SpawnPty;
  /** setup-token に渡す環境変数のもと（テスト用） */
  readonly env?: NodeJS.ProcessEnv;
  /** OS のホーム（`~/.local/bin/claude` を探す。テスト用） */
  readonly userHome?: string;
  /**
   * 箱のイメージを作る（`aicoop image build` と同じこと。5.14 の3の4）。Gondolin は daemon から直接呼ばない
   * （4.4）ので、CLI の `aicoop daemon` が差し込む。なければ、準備の画面からはイメージを作れない
   */
  readonly runImageBuild?: ImageBuildRunner;
}

export interface DaemonHandle {
  /** 待ち受けているポート */
  readonly port: number;
  /** `runtime/daemon.json` に書いたもの */
  readonly info: DaemonInfo;
  /** ローカルAPI のトークン（`runtime/api_token` と同じ） */
  readonly token: string;
  /** 止める。何度呼んでもよい（同じものを返す） */
  stop(): Promise<void>;
  /** 止まったら解決する（stop・POST /shutdown・シグナルのどれでも） */
  readonly stopped: Promise<void>;
  /**
   * オーナーの承認の対象（P2：保留 hold・一時権限 grant。`holds/targets.ts`）。
   * 承認の署名を確かめる側（approvals/）に渡す。startDaemon は必ず入れる（偽の daemon では無くてよい）
   */
  readonly approvalTargets?: ApprovalTargets;
}

function daemonVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function errorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;
}

function alreadyRunning(pid: number, port: number | null, runtimeDir: string): DaemonStartError {
  const where = port === null ? "" : `、ポート ${port}`;
  return new DaemonStartError(
    "already_running",
    `制御サーバーは、すでに動いています（pid ${Number.isNaN(pid) ? "不明" : pid}${where}）。止めるときは aicoop stop を使ってください。動いていないのにこう出るときは、${runtimeDir} の daemon.json と ${LOCK_FILE} を消してください`,
  );
}
export async function startDaemon(options: StartDaemonOptions): Promise<DaemonHandle> {
  const home = resolve(options.home);
  const now = options.now ?? (() => new Date());
  const timers = options.timers ?? systemTimers;
  const paths = aicoopPaths(home);
  const lockPath = resolve(paths.runtimeDir, LOCK_FILE);

  // 1. 設定
  const loaded = loadConfig(home, { now: now() });
  if (!loaded.ok) {
    throw new DaemonStartError(
      "config_invalid",
      `設定にエラーがあるので、制御サーバーを起動しません（${loaded.issues.length}件。aicoop check で確かめられます）`,
      loaded.issues,
    );
  }
  let config: CompanyConfig = loaded.config;
  let warnings: readonly ConfigIssue[] = loaded.warnings;
  let configLoadedAt = now().toISOString();

  // 2. 二重起動
  const previous = readDaemonInfo(paths.daemonInfo);
  if (previous !== null && isProcessAlive(previous.pid)) {
    throw alreadyRunning(previous.pid, previous.port, paths.runtimeDir);
  }
  const acquired = acquireDaemonLock(lockPath);
  if (!acquired.ok) throw alreadyRunning(acquired.pid, null, paths.runtimeDir);
  const lock: DaemonLock = acquired.lock;

  // ここから先で失敗したら、作ったものを片付けてから投げる
  const undo: Array<() => void> = [() => lock.release()];
  const cleanup = () => {
    for (const fn of undo.splice(0).reverse()) {
      try {
        fn();
      } catch {
        // 片付けの失敗は、もとの失敗を隠さない
      }
    }
  };

  let logger: Logger;
  let db: StateDb;
  let token: string;
  let server: Server;
  let port: number;
  let scheduler: TaskScheduler;
  let triggers: TriggerSet;
  let maintenanceTimer: TimerHandle | undefined;
  let holdTimer: TimerHandle | undefined;
  let info: DaemonInfo;
  let drivers: BoxDrivers;
  let approvalTargets: ApprovalTargets;
  let stopSetup: () => Promise<void> = async () => {};

  try {
    // 3. ログ・state.db
    rmSync(paths.daemonInfo, { force: true });
    const log = createDaemonLogger({
      logsDir: paths.logsDir,
      timezone: config.aicoop.timezone,
      now,
      ...(options.logToStdout !== undefined && { stdout: options.logToStdout }),
    });
    undo.push(() => log.close());
    logger = log.logger;
    logger.info({ home }, "制御サーバーを起動します");
    for (const w of warnings) {
      logger.warn({ code: w.code, source: w.source, path: w.path }, w.message);
    }

    db = openStateDb(paths.stateDb, { now });
    undo.push(() => db.close());
    appendAudit(db, {
      actor: "system",
      kind: "config.load",
      subject: config.aicoop.company.id,
      data: { files: config.fileHashes },
    });

    // 8.6：再起動の後始末（箱そのものを壊すのは、実行の側の仕事）
    const recovery = recoverAfterRestart(db);
    if (recovery.failed.length + recovery.requeued.length + recovery.endedRuns.length > 0) {
      logger.warn(
        { failed: recovery.failed, requeued: recovery.requeued, ended_runs: recovery.endedRuns },
        "前回の制御サーバーが止まったときに動いていたタスクを片付けました（8.6）",
      );
    }
    // 前の制御サーバーが落ちて残した runtime/<run_id>/（mcp.json のゲートのトークンなど）を消す
    const staleRuns = removeStaleRuntimeDirs(paths);
    if (staleRuns.length > 0) {
      logger.warn({ runs: staleRuns }, "残っていた実行のフォルダ（runtime/<run_id>/）を消しました");
    }

    const maintenance = () => {
      try {
        const result = pruneAuditLog(db, { retentionDays: config.aicoop.audit.retention_days });
        if (result.deleted > 0) {
          logger.info({ deleted: result.deleted }, "保存期間を過ぎた監査ログを消しました（5.10）");
        }
      } catch (error) {
        logger.error(
          { err: error },
          "監査ログの古い行を消せませんでした（aicoop audit verify で確かめてください）",
        );
      }
      try {
        const result = pruneOldLogs({
          logsDir: paths.logsDir,
          runLogsDir: paths.runLogsDir,
          timezone: config.aicoop.timezone,
          now: now(),
        });
        if (result.deleted.length > 0) {
          logger.info({ count: result.deleted.length }, "30日を過ぎたログを消しました（11.5）");
        }
      } catch (error) {
        logger.error({ err: error }, "古いログを消せませんでした");
      }
      // 決まった保留の state/holds/<id>.bin・再送の結果のファイル（state.db の記録は残す）
      try {
        pruneResolvedHoldFiles({ db, paths, now, logger });
      } catch (error) {
        logger.error({ err: error }, "決まった保留のファイルを消せませんでした");
      }
    };
    maintenance();
    const scheduleMaintenance = () => {
      maintenanceTimer = timers.setTimeout(() => {
        maintenance();
        scheduleMaintenance();
      }, DAY_MS);
    };

    // 4. トークン
    token = randomBytes(32).toString("base64url");
    log.addSecret(token);
    writePrivateFile(paths.apiToken, token);
    undo.push(() => rmSync(paths.apiToken, { force: true }));

    drivers =
      options.drivers ??
      ({
        vm: createGondolinDriver({
          onProxyError: (error) =>
            logger.error({ err: error }, "資格プロキシの判定で例外が起きました"),
        }),
      } satisfies BoxDrivers);
    const env: RunEnvironment = {
      db,
      paths,
      drivers,
      logger,
      now,
      ...(options.fetch !== undefined && { fetch: options.fetch }),
      // 実行の中で作ったタスク（部長のレビュー・on_hold_resolved）を、すぐ順番待ちに乗せる
      onTaskCreated: () => scheduler.kick(),
    };
    // 保留・一時権限（P2）：オーナーの承認の対象・再送・期限
    const holdDeps: HoldDeps = {
      db,
      paths,
      config: () => config,
      fetch: options.fetch ?? globalThis.fetch,
      now,
      logger,
      onTaskCreated: () => scheduler.kick(),
      canRun: (cfg, memberId) => checkRunnableMember(cfg, memberId, drivers).ok,
    };
    // 承認の対象：保留・一時権限（holds/targets.ts）。options で渡したものが同じ種類なら、そちらを使う
    approvalTargets = { ...createHoldTargets(holdDeps), ...options.approvalTargets };
    scheduler = createTaskScheduler({
      db,
      env,
      startRun: options.startRun,
      config: () => config,
      timers,
      now,
      logger,
    });

    // 端末の登録・ログイン・承認の署名（5.8）。状態はこのプロセスのメモリの中だけ
    const approvals = createApprovalService({
      db,
      logger,
      now,
      port: () => port,
      company: () => config.aicoop.company,
      targets: () => approvalTargets,
    });

    const canRun = (memberId: string) => checkRunnableMember(config, memberId, drivers);
    const buildTriggers = (): TriggerSet =>
      startTriggers({
        config,
        timers,
        now,
        logger,
        canRun,
        onCron: (trigger: CronTriggerConfig) => {
          const check = canRun(trigger.member);
          if (!check.ok) {
            logger.warn({ trigger: trigger.id }, check.message);
            return;
          }
          const task = createCronTask(db, config, trigger, check.member);
          logger.info({ task_id: task.id, trigger: trigger.id }, "cron のタスクを作りました");
          scheduler.kick();
        },
      });
    triggers = { views: () => [], stop: () => {} };

    // 5. API
    let stopPromise: Promise<void> | undefined;
    let resolveStopped: () => void = () => {};
    const stopped = new Promise<void>((r) => {
      resolveStopped = r;
    });
    const stop = (): Promise<void> => {
      stopPromise ??= (async () => {
        try {
          logger.info("制御サーバーを止めます");
          if (options.handleSignals) {
            process.off("SIGINT", signalHandler);
            process.off("SIGTERM", signalHandler);
          }
          if (maintenanceTimer !== undefined) timers.clearTimeout(maintenanceTimer);
          if (holdTimer !== undefined) timers.clearTimeout(holdTimer);
          triggers.stop();
          await scheduler.stop(
            options.stopTimeoutMs === undefined ? {} : { timeoutMs: options.stopTimeoutMs },
          );
          await closeApiServer(server);
          // 準備の画面の Claude へのログイン（setup-token）と、イメージを作るのを止める
          await stopSetup();
          // 承認のあとの処理（保留の再送など）を待ってから state.db を閉じる
          await approvals.drain();
        } catch (error) {
          logger.error({ err: error }, "止める途中でエラーが起きました");
        } finally {
          logger.info("制御サーバーを止めました");
          // daemon.json・api_token を消し、state.db を閉じ、鍵を外す（作った順の逆）

          cleanup();
          resolveStopped();
        }
      })();
      return stopPromise;
    };
    const signalHandler = () => {
      logger.info("シグナルを受けたので止めます");
      void stop();
    };

    // 設定を読み直す（aicoop reload・設定の画面の保存。actor は監査ログ config.load の者）
    const reloadConfig = (actor: AuditActor): ReturnType<ApiControl["reload"]> => {
      const result = loadConfig(home, { now: now() });
      if (!result.ok) {
        logger.warn(
          { count: result.issues.length },
          "設定にエラーがあるので、読み直しませんでした",
        );
        return { ok: false, issues: result.issues };
      }
      const next = result.config;
      if (next.aicoop.company.id !== config.aicoop.company.id) {
        const issue: ConfigIssue = {
          code: "E-013",
          source: "aicoop.yaml",
          path: "company.id",
          message: `company.id は変えられません（起動したときは ${config.aicoop.company.id}）。もとに戻してください`,
        };
        logger.warn("company.id が変わっているので、読み直しませんでした");
        return { ok: false, issues: [issue] };
      }
      if (next.aicoop.daemon.port !== config.aicoop.daemon.port) {
        logger.warn(
          { port, configured: next.aicoop.daemon.port },
          "daemon.port の変更は、制御サーバーを起動し直すまで効きません",
        );
      }
      config = next;
      warnings = result.warnings;
      configLoadedAt = now().toISOString();
      appendAudit(db, {
        actor,
        kind: "config.load",
        subject: config.aicoop.company.id,
        data: { files: config.fileHashes },
      });
      for (const w of warnings) {
        logger.warn({ code: w.code, source: w.source, path: w.path }, w.message);
      }
      triggers.stop();
      triggers = buildTriggers();
      scheduler.kick();
      logger.info("設定を読み直しました");
      return { ok: true, warnings, files: config.fileHashes };
    };

    // 設定の画面と資格の画面（5.14 の4・5）。署名を待つ変更は、このプロセスのメモリの中だけ
    const settings = createSettings({
      home,
      secretsPath: paths.secrets,
      db,
      logger,
      now,
      companyId: () => config.aicoop.company.id,
      validate: (overrides) => loadConfig(home, { now: now(), overrides }),
      reload: (actor) => reloadConfig(actor),
    });
    approvalTargets = { ...approvalTargets, ...settings.targets(), ...options.approvalTargets };

    // 準備の画面（5.14 の3）。ログインの状態・イメージの進み具合は、このプロセスのメモリの中だけ
    const host: ReadinessHost = { ...defaultReadinessHost(now), ...options.setup?.host };
    const setup = createSetup({
      home,
      secretsPath: paths.secrets,
      host,
      settings,
      config: () => config,
      login: createClaudeLogin({
        platform: host.platform,
        userHome: options.setup?.userHome ?? homedir(),
        which: (command) => host.which(command),
        ...(options.setup?.spawnPty !== undefined && { spawn: options.setup.spawnPty }),
        ...(options.setup?.env !== undefined && { env: options.setup.env }),
        timers,
        now,
        logger,
        propose: (token) =>
          settings.proposeSecretChange({ id: "anthropic", kind: "anthropic_oauth", value: token }),
      }),
      images: createImageBuilds({
        home,
        platform: host.platform,
        ...(options.setup?.runImageBuild !== undefined && {
          runner: options.setup.runImageBuild,
        }),
        now,
        logger,
      }),
    });
    stopSetup = async () => {
      setup.login.stop();
      await setup.images.stop();
    };

    const control: ApiControl = {
      db,
      paths,
      logger,
      token,
      port: () => port,
      config: () => config,
      warnings: () => warnings,
      daemon: () => ({ ...info, config_loaded_at: configLoadedAt }),
      runningBoxes: (): RunningBoxView[] =>
        scheduler.active().map((h) => ({
          group_id: h.groupId,
          member_id: h.memberId,
          task_id: h.taskId,
          run_id: h.runId(),
          box_kind: h.boxKind,
          started_at: h.startedAt,
        })),
      triggers: (): TriggerView[] => triggers.views(),
      canRun,
      taskCreated: () => scheduler.kick(),
      handleFor: (taskId) => scheduler.handleFor(taskId),
      reload: () => reloadConfig("owner:cli"),
      shutdown() {
        // 応答を返し終えてから止め始める
        setTimeout(() => void stop(), 0);
      },
      approvals,
      approverDir: options.approverDir ?? defaultApproverDir(),
      settings,
      setup,
    };

    server = createApiServer(createApiApp(control));
    const wanted = options.port ?? config.aicoop.daemon.port;
    try {
      port = await listenApi(server, wanted);
    } catch (error) {
      const code = errorCode(error);
      if (code === "EADDRINUSE") {
        throw new DaemonStartError(
          "port_in_use",
          `ポート ${wanted}（127.0.0.1）は、ほかのソフトが使っています。そのソフトを止めるか、aicoop.yaml の daemon.port を変えてください`,
          [],
          error,
        );
      }
      if (code === "EACCES") {
        throw new DaemonStartError(
          "start_failed",
          `ポート ${wanted} で待ち受ける権限がありません。aicoop.yaml の daemon.port を 1024 以上にしてください`,
          [],
          error,
        );
      }
      throw error;
    }
    undo.push(() => {
      server.close();
      server.closeAllConnections();
    });
    server.on("error", (error) =>
      logger.error({ err: error }, "API のサーバーでエラーが起きました"),
    );

    info = {
      pid: process.pid,
      port,
      started_at: now().toISOString(),
      home,
      version: daemonVersion(),
    };
    writePrivateFile(paths.daemonInfo, `${JSON.stringify(info, null, 2)}\n`);
    undo.push(() => rmSync(paths.daemonInfo, { force: true }));

    // 6. トリガー・順番待ち
    triggers = buildTriggers();
    scheduler.start();
    scheduler.kick();
    scheduleMaintenance();
    // 保留：送っている途中で落ちたものの後始末と、承認の直後に落ちたものの再送（5.2.6 の2）。
    // 期限（5.2.6 の5・5.7.3 の3）は、いま1回と、そのあと1分ごとに見る
    void recoverReplays(holdDeps).catch((error: unknown) =>
      logger.error({ err: error }, "保留の再送の後始末に失敗しました"),
    );
    const checkHoldExpiry = () => {
      try {
        expireDue(holdDeps);
      } catch (error) {
        logger.error({ err: error }, "保留・一時権限の期限を確かめられませんでした");
      }
      holdTimer = timers.setTimeout(checkHoldExpiry, HOLD_EXPIRY_INTERVAL_MS);
    };
    checkHoldExpiry();
    if (options.handleSignals) {
      process.on("SIGINT", signalHandler);
      process.on("SIGTERM", signalHandler);
    }
    logger.info(
      { port, pid: process.pid },
      `制御サーバーを起動しました（http://127.0.0.1:${port}/）`,
    );

    return {
      port,
      info,
      token,
      stop,
      stopped,
      approvalTargets,
    };
  } catch (error) {
    cleanup();
    if (error instanceof DaemonStartError) throw error;
    throw new DaemonStartError(
      "start_failed",
      `制御サーバーを起動できませんでした：${error instanceof Error ? error.message : String(error)}`,
      [],
      error,
    );
  }
}
