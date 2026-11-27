/**
 * P1 の完了条件（14章）を、本物の vm の箱（Gondolin の microVM）で端から端まで確かめる結合テスト。
 * 環境変数 `AICOOP_VM_E2E=1` があるときだけ動く（KVM の使える Linux。CI の vm-e2e のジョブ）。
 *
 * - 箱のイメージは、本物の `buildImage` で作る。ただし Claude Code の代わりに、偽の `claude`
 *   （シェルスクリプト `testing/fake-claude.sh`）を入れる。`buildImage` の `fetch` の差し込み口で、
 *   Claude Code の配布元の代わりに渡す（版・manifest.json の SHA-256 の確かめも本物のまま通る）
 * - 本物の `startDaemon`・`startRun`・`createGondolinDriver` で動かす。ドライバーは、渡された BoxSpec と
 *   exec を記録するだけの包みで包む（中身は変えない）
 * - 偽の claude は、箱の中から見えたもの（env・すべてのプロセスの環境変数・ファイル）と、curl で送った資格プロキシ・
 *   道具ゲートの応答を、作業フォルダの `e2e/<session_id>/` に書く。テストはそれをホストで読む
 * - forward したリクエストは、本当に GitHub に届く。偽のトークンなので GitHub が断る（401 など）。
 *   資格プロキシの拒否（403 + X-Aicoop-Decision: deny）とは、ヘッダーで区別できる
 *
 * 確かめたことは `[P1-x]` などを付けて標準出力に書く（CI のログを根拠にする）。
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildImage,
  CLAUDE_CODE_DOWNLOAD_BASE,
  createGondolinDriver,
  IMAGE_METADATA_FILE,
  imageDir,
} from "@aicoop/box-gondolin";
import type { Box, BoxDriver, BoxSpec } from "@aicoop/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DaemonInfo, GetTaskResponse, StatusResponse } from "./api/contract.ts";
import { type DaemonHandle, startDaemon } from "./daemon/start.ts";
import { verifyAuditLog } from "./db/audit.ts";
import { openStateDb, type StateDb } from "./db/open.ts";
import { type AicoopPaths, aicoopPaths } from "./paths.ts";
import { startRun } from "./run/execute.ts";
import { mcpConfig } from "./run/managed-settings.ts";
import type { TestCompany } from "./testing/company.ts";
import { apiRequest } from "./testing/http.ts";
import { manualClock } from "./testing/manual-clock.ts";
import {
  type Api,
  type AuditRow,
  auditRows,
  auditTrail,
  createE2eCompany,
  E2E_CRON_TRIGGER,
  E2E_ORG,
  E2E_OTHER_OWNER,
  type E2eSecrets,
  findLeaks,
  listFilesRecursive,
  registerE2eSecrets,
  waitForTask,
  waitForTaskEnd,
} from "./testing/p1-e2e.ts";
import { type TempDir, tempDir } from "./testing/state-db.ts";

const ENABLED = process.env.AICOOP_VM_E2E === "1";

/** 偽の claude の版（Claude Code の版の形にする） */
const FAKE_CLAUDE_VERSION = "0.0.0-aicoop-e2e";
/** 箱を起こしてから偽の claude が終わるまでを待つ長さ */
const RUN_TIMEOUT_MS = 240_000;

/** 偽の claude のスクリプト（org の名前を入れたもの） */
function fakeClaudeScript(): Buffer {
  const text = readFileSync(new URL("./testing/fake-claude.sh", import.meta.url), "utf8")
    .replaceAll("\r\n", "\n")
    .replaceAll("@E2E_ORG@", E2E_ORG)
    .replaceAll("@E2E_OTHER_OWNER@", E2E_OTHER_OWNER);
  if (text.includes("@E2E_")) throw new Error("偽の claude に置き換えていない印があります");
  return Buffer.from(text, "utf8");
}

/** Claude Code の配布元の代わり（buildImage の fetch）。偽の claude を、その版の実行ファイルとして渡す */
function fakeClaudeDownloads(script: Buffer): (url: string) => Promise<Response> {
  const checksum = createHash("sha256").update(script).digest("hex");
  const base = `${CLAUDE_CODE_DOWNLOAD_BASE}/${FAKE_CLAUDE_VERSION}`;
  return async (url) => {
    if (url === `${base}/manifest.json`) {
      return Response.json({
        version: FAKE_CLAUDE_VERSION,
        platforms: {
          "linux-x64-musl": { checksum },
          "linux-arm64-musl": { checksum },
        },
      });
    }
    if (url === `${base}/linux-x64-musl/claude` || url === `${base}/linux-arm64-musl/claude`) {
      return new Response(new Uint8Array(script));
    }
    return new Response("not found", { status: 404 });
  };
}

interface RecordedBox {
  readonly spec: BoxSpec;
  readonly execs: {
    readonly cmd: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  }[];
  destroyed: number;
}

/** 渡された BoxSpec・exec・destroy を記録するだけの包み（中身は本物のドライバーのまま） */
function recordingDriver(inner: BoxDriver): { driver: BoxDriver; boxes: RecordedBox[] } {
  const boxes: RecordedBox[] = [];
  const driver: BoxDriver = {
    kind: inner.kind,
    async create(spec) {
      const record: RecordedBox = { spec, execs: [], destroyed: 0 };
      boxes.push(record);
      const box = await inner.create(spec);
      const wrapped: Box = {
        exec(cmd, opts) {
          record.execs.push({ cmd: [...cmd], cwd: opts.cwd, env: { ...(opts.env ?? {}) } });
          return box.exec(cmd, opts);
        },
        kill: () => box.kill(),
        async destroy() {
          record.destroyed += 1;
          await box.destroy();
        },
      };
      return wrapped;
    },
  };
  return { driver, boxes };
}

/** ホストで動いている QEMU のプロセス（箱が壊されたかの確かめ） */
function qemuProcesses(): string[] {
  const found: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0");
      if (cmdline[0]?.includes("qemu-system")) found.push(entry);
    } catch {
      // 終わったプロセス
    }
  }
  return found;
}

/** QEMU のプロセスがなくなるまで少し待ち、残っているものを返す（なくなっていれば空） */
async function qemuLeftAfterRun(): Promise<string[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const left = qemuProcesses();
    if (left.length === 0 || Date.now() > deadline) return left;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** 失敗したときに、何が起きたかを CI のログで見られるようにする */
function dumpLogs(paths: AicoopPaths): void {
  for (const file of listFilesRecursive(paths.logsDir)) {
    console.log(`[診断] ${file}:`);
    console.log(readFileSync(file, "utf8").slice(0, 20_000));
  }
}

/** 偽の claude が箱の中で書いたもの（作業フォルダの e2e/<session_id>/） */
interface BoxReport {
  readonly dir: string;
  read(name: string): string;
  /** ステータス（curl の %{http_code}） */
  status(name: string): string;
  /** 応答のヘッダー（小文字の名前 → 値。最後の応答のもの） */
  headers(name: string): Record<string, string>;
  json(name: string): Record<string, unknown>;
}

function boxReport(workDir: string, sessionId: string): BoxReport {
  const dir = join(workDir, "e2e", sessionId);
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  return {
    dir,
    read,
    status: (name) => read(`${name}.status`).trim(),
    headers(name) {
      const blocks = read(`${name}.headers`).replaceAll("\r\n", "\n").trim().split(/\n\n+/);
      const out: Record<string, string> = {};
      for (const line of (blocks.at(-1) ?? "").split("\n").slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      return out;
    },
    json: (name) => JSON.parse(read(name)) as Record<string, unknown>,
  };
}

describe.skipIf(!ENABLED)(
  "P1 の完了条件（14章）：本物の vm の箱（Gondolin）で、端から端まで",
  () => {
    let dir: TempDir | undefined;
    let company: TestCompany;
    let paths: AicoopPaths;
    let secrets: E2eSecrets;
    let recorded: { driver: BoxDriver; boxes: RecordedBox[] };
    let daemon: DaemonHandle | undefined;
    let token = "";
    let api: Api;
    let manual: GetTaskResponse;
    let cron: GetTaskResponse;
    let statusBeforeCron: StatusResponse;
    const runDirLeft: Record<string, boolean> = {};
    const qemuAfter: Record<string, string[]> = {};
    let manualBox: BoxReport;
    let cronBox: BoxReport;
    let db: StateDb | undefined;
    let audit: AuditRow[] = [];

    const scenario = async () => {
      dir = tempDir();
      company = createE2eCompany(dir.path);
      paths = aicoopPaths(company.home);
      secrets = registerE2eSecrets(paths);

      // aicoop image build --group dev と同じ（Claude Code の代わりに偽の claude を入れる）
      const packages = company.load().groups.dev?.packages ?? [];
      const started = Date.now();
      const image = await buildImage({
        outputDir: imageDir(company.home, "dev"),
        packages,
        claudeCodeVersion: FAKE_CLAUDE_VERSION,
        fetch: fakeClaudeDownloads(fakeClaudeScript()),
        verbose: true,
      });
      console.log(
        `[5.1.8] 部署 dev の箱のイメージを組み立てた（${Math.round((Date.now() - started) / 1000)} 秒、claude は偽物 ${image.claudeCodeVersion}、packages ${packages.join(",")}）`,
      );
      expect(existsSync(join(image.outputDir, IMAGE_METADATA_FILE))).toBe(true);

      recorded = recordingDriver(
        createGondolinDriver({
          onProxyError: (error) => console.error("[資格プロキシの例外]", error),
        }),
      );
      // 2026-12-01（火）02:29 JST。足した cron（毎日 2:30）の1分前
      const clock = manualClock("2026-11-30T17:29:00.000Z");
      daemon = await startDaemon({
        home: company.home,
        startRun,
        drivers: { vm: recorded.driver },
        port: 0,
        now: clock.now,
        timers: clock,
      });
      const info = JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo;
      token = readFileSync(paths.apiToken, "utf8").trim();
      api = (req) => apiRequest(info.port, { token, timeoutMs: 10_000, ...req });

      // 手動のタスク
      const runStarted = Date.now();
      const created = await api({
        method: "POST",
        path: "/tasks",
        body: {
          member: "dev-implementer",
          purpose: "README の誤字を直して push する",
          done_when: "push して、report_result で報告した",
        },
      });
      expect(created.status).toBe(201);
      manual = await waitForTaskEnd(api, created.json.task.id, RUN_TIMEOUT_MS);
      console.log(
        `[8.1] 手動のタスク：${manual.task.status}（箱の起動から片付けまで ${Date.now() - runStarted} ms）`,
      );
      for (const run of manual.runs) {
        runDirLeft[run.id] = existsSync(paths.runDir(run.id));
        qemuAfter[run.id] = await qemuLeftAfterRun();
      }
      manualBox = boxReport(paths.groupWork("dev"), manual.runs[0]?.session_id ?? "（なし）");

      // cron
      statusBeforeCron = (await api({ path: "/status" })).json as StatusResponse;
      clock.advance(60_000);
      const cronTask = await waitForTask(api, (t) => t.trigger_kind === "cron", 10_000);
      cron = await waitForTaskEnd(api, cronTask.id, RUN_TIMEOUT_MS);
      console.log(`[8.1] cron のタスク：${cron.task.status}`);
      for (const run of cron.runs) {
        runDirLeft[run.id] = existsSync(paths.runDir(run.id));
        qemuAfter[run.id] = await qemuLeftAfterRun();
      }
      cronBox = boxReport(paths.groupWork("dev"), cron.runs[0]?.session_id ?? "（なし）");

      expect((await api({ method: "POST", path: "/shutdown" })).status).toBe(200);
      await daemon.stopped;
      db = openStateDb(paths.stateDb);
      audit = auditRows(db);
    };

    beforeAll(async () => {
      try {
        await scenario();
      } catch (error) {
        if (paths !== undefined) dumpLogs(paths);
        throw error;
      }
    }, 1_200_000);

    afterAll(async () => {
      db?.close();
      await daemon?.stop();
      dir?.cleanup();
    }, 120_000);

    it("前提：手動と cron のタスクが、それぞれ本物の箱で1回ずつ実行され、偽の claude が最後まで動いた", () => {
      if (manual.task.status !== "done" || cron.task.status !== "done") {
        console.log(`[診断] 手動: ${JSON.stringify(manual)}`);
        console.log(`[診断] cron: ${JSON.stringify(cron)}`);
        dumpLogs(paths);
      }
      expect(recorded.boxes).toHaveLength(2);
      expect(manual.task.status).toBe("done");
      expect(cron.task.status).toBe("done");
      for (const box of [manualBox, cronBox]) {
        expect(box.read("files").split("\n")).toEqual(
          expect.arrayContaining(["ok /usr/local/bin/claude"]),
        );
      }
    });

    it("P1 完了条件1：箱の中で env を表示しても、本物の GitHub トークンは出てこない（BoxSpec.env にも、exec の env にも、どのプロセスの環境変数にもない）", () => {
      for (const box of recorded.boxes) {
        expect(JSON.stringify(box.spec.env)).not.toContain(secrets.github);
        expect(JSON.stringify(box.spec.env)).not.toContain(secrets.anthropic);
        expect(box.spec.secrets.map((s) => s.env)).toEqual(["GITHUB_TOKEN"]);
        for (const exec of box.execs)
          expect(JSON.stringify(exec.env)).not.toContain(secrets.github);
      }
      for (const box of [manualBox, cronBox]) {
        const env = box.read("env");
        expect(env).toMatch(/^GITHUB_TOKEN=GONDOLIN_SECRET_[0-9a-f]{48}$/m);
        expect(env).not.toContain(secrets.github);
        expect(box.read("environ-all")).not.toContain(secrets.github);
        // 5.4.1 の2：Claude のログインのトークンだけは、例外として claude の実行に本物を渡す
        expect(env).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${secrets.anthropic}`);
        expect(env).toMatch(/^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1$/m);
        expect(env).toMatch(/^HOME=\/home\/agent$/m);
        // 仮の札は実行ごとに作り直す（5.1.3 の2）
      }
      const placeholder = (box: BoxReport) => /^GITHUB_TOKEN=(.*)$/m.exec(box.read("env"))?.[1];
      expect(placeholder(manualBox)).not.toBe(placeholder(cronBox));
      console.log(
        "[P1-1] 箱の中の env・/proc/*/environ に本物の GitHub トークンはない。GITHUB_TOKEN は仮の札で、実行ごとに違う",
      );
    });

    it("P1 完了条件2：許可していないリポジトリへの push は 403 + X-Aicoop-Decision: deny。許可したリポジトリへは forward され、GitHub まで届く", () => {
      for (const box of [manualBox, cronBox]) {
        expect(box.status("push-denied")).toBe("403");
        expect(box.headers("push-denied")["x-aicoop-decision"]).toBe("deny");
        expect(box.json("push-denied.body")).toEqual({
          aicoop: "deny",
          operation: "github.git.push",
          reason: "not_allowed",
        });
        // 本物の git でも push できない
        expect(box.read("git-push-denied.status").trim()).not.toBe("0");
        expect(box.read("git-push-denied.out")).toContain("403");

        // forward：資格プロキシの拒否のヘッダーがなく、GitHub が答えている（偽のトークンなので断られる）
        expect(box.headers("push-allowed")).not.toHaveProperty("x-aicoop-decision");
        expect(box.status("push-allowed")).toMatch(/^[1-5]\d\d$/);
        expect(box.headers("api-allowed")).not.toHaveProperty("x-aicoop-decision");
        expect(box.status("api-allowed")).toBe("401");
      }
      console.log(
        `[P1-2] 許可していないリポジトリへの push は 403（X-Aicoop-Decision: deny、git push も失敗：${manualBox
          .read("git-push-denied.out")
          .replace(/\s+/g, " ")
          .slice(
            0,
            200,
          )}）。許可したリポジトリへの push は forward され GitHub が ${manualBox.status("push-allowed")}、API は ${manualBox.status("api-allowed")}（偽のトークン）`,
      );
    });

    it("P1 完了条件3：許可していないホストに接続できない（403 + X-Aicoop-Decision: deny）", () => {
      for (const box of [manualBox, cronBox]) {
        expect(box.status("host-denied")).toBe("403");
        expect(box.headers("host-denied")["x-aicoop-decision"]).toBe("deny");
        expect(box.json("host-denied.body")).toEqual({
          aicoop: "deny",
          operation: "web.read",
          reason: "not_allowed",
        });
      }
      console.log("[P1-3] 許可していないホスト（example.com）は 403、X-Aicoop-Decision: deny");
    });

    it("5.3.1：道具ゲートに http://aicoop.internal/mcp で届き、セッションなしの JSON-RPC で initialize・tools/list・tools/call ができる。道具は report_result だけ", () => {
      for (const box of [manualBox, cronBox]) {
        expect(box.status("mcp-initialize")).toBe("200");
        expect(box.json("mcp-initialize.body")).toMatchObject({
          jsonrpc: "2.0",
          id: 1,
          result: { serverInfo: { name: "aicoop" } },
        });
        expect(box.status("mcp-initialized")).toBe("202");
        expect(box.status("mcp-list")).toBe("200");
        const list = box.json("mcp-list.body") as { result: { tools: { name: string }[] } };
        expect(list.result.tools.map((t) => t.name)).toEqual(["report_result"]);
        expect(box.status("mcp-report")).toBe("200");
        const report = box.json("mcp-report.body") as {
          result: { isError?: boolean; content: { text: string }[] };
        };
        expect(report.result.isError).toBeUndefined();
        expect(JSON.parse(report.result.content[0]?.text ?? "{}")).toMatchObject({ ok: true });
        // 5.3.1 の5・5.1.7：MCP の設定と管理設定は、箱の中で読み取り専用
        expect(box.json("mcp.json")).toEqual(mcpConfig());
        expect(box.read("etc-aicoop-write").trim()).toBe("readonly");
        expect(box.read("files").split("\n")).toEqual(
          expect.arrayContaining([
            "ok /etc/aicoop/mcp.json",
            "ok /etc/claude-code/managed-settings.json",
            "ok /home/agent/.claude/CLAUDE.md",
            "ok /home/agent/.claude/settings.json",
          ]),
        );
        expect(box.read("cwd").trim()).toBe("/work");
      }
      const argv = manualBox.read("argv").split("\0");
      expect(argv[0]).toBe("-p");
      expect(argv).toEqual(
        expect.arrayContaining(["--mcp-config", "/etc/aicoop/mcp.json", "--strict-mcp-config"]),
      );
      console.log(
        "[5.3.1] 箱の中の curl から道具ゲートに届き、セッションなしで initialize・tools/list・tools/call（report_result）ができた",
      );
    });

    it("P1 完了条件4（手動）：report_result で報告すると done になり、要約とファイルが API で見え、箱が壊され、runtime/<run_id>/ が消える", () => {
      const run = manual.runs[0];
      const sessionId = run?.session_id as string;
      expect(manual.task).toMatchObject({
        trigger_kind: "manual",
        status: "done",
        result_summary: `箱の中から確かめました（${sessionId}）`,
        result_files: [`e2e/${sessionId}/report.md`],
        error: null,
      });
      expect(run).toMatchObject({ box_kind: "vm", exit_code: 0, end_reason: "exited" });
      expect(sessionId).toMatch(/^e2e-/);
      expect(recorded.boxes[0]?.destroyed).toBe(1);
      expect(qemuAfter[run?.id as string]).toEqual([]);
      expect(runDirLeft[run?.id as string]).toBe(false);
      expect(readFileSync(join(manualBox.dir, "report.md"), "utf8")).toContain(sessionId);
      console.log(
        `[P1-4] 手動のタスクは report_result で done（要約「${manual.task.result_summary}」、ファイル ${JSON.stringify(manual.task.result_files)}）。箱は壊され（QEMU のプロセスなし）、runtime/<run_id>/ も消えた`,
      );
    });

    it("P1 完了条件4（cron）：cron で起き、仕事をして report_result で報告し、箱が壊される", () => {
      expect(statusBeforeCron.triggers).toContainEqual(
        expect.objectContaining({ id: E2E_CRON_TRIGGER, enabled: true }),
      );
      const run = cron.runs[0];
      const sessionId = run?.session_id as string;
      expect(cron.task).toMatchObject({
        trigger_kind: "cron",
        trigger_id: E2E_CRON_TRIGGER,
        status: "done",
        result_summary: `箱の中から確かめました（${sessionId}）`,
        result_files: [`e2e/${sessionId}/report.md`],
      });
      expect(run).toMatchObject({ exit_code: 0, end_reason: "exited" });
      expect(recorded.boxes[1]?.destroyed).toBe(1);
      expect(qemuAfter[run?.id as string]).toEqual([]);
      expect(runDirLeft[run?.id as string]).toBe(false);
      expect(listFilesRecursive(paths.runtimeDir)).toEqual([]);
      console.log(
        `[P1-4] cron（${E2E_CRON_TRIGGER}）で起きたタスクも report_result で done。箱は壊された`,
      );
    });

    it("P1 完了条件5：監査ログのつながりが確かめられ、config.load・task.state・box.lifecycle・proxy.decision・gateway.call が並ぶ", () => {
      const verified = verifyAuditLog(db as StateDb);
      expect(verified).toMatchObject({ ok: true });
      expect(audit[0]?.kind).toBe("config.load");
      for (const [task, run] of [
        [manual.task.id, manual.runs[0]?.id as string],
        [cron.task.id, cron.runs[0]?.id as string],
      ] as const) {
        const trail = auditTrail(audit, task, run);
        expect(trail.slice(0, 2)).toEqual(["task.state null→queued", "task.state queued→starting"]);
        expect(trail.slice(-2)).toEqual(["box.lifecycle stop", "task.state running→done"]);
        expect(trail).toEqual(
          expect.arrayContaining([
            "box.lifecycle start",
            "task.state starting→running",
            "proxy.decision deny github.git.push",
            "proxy.decision allow github.git.push",
            "proxy.decision allow github.repo.read",
            "proxy.decision deny web.read",
            "gateway.call report_result ok",
          ]),
        );
        // 素通し（api.anthropic.com）と道具ゲートは、資格プロキシを通らない
        expect(
          audit.filter(
            (r) =>
              r.kind === "proxy.decision" &&
              r.subject === run &&
              ["api.anthropic.com", "aicoop.internal"].includes(String(r.data.host)),
          ),
        ).toEqual([]);
        console.log(`[P1-5] ${task} の監査ログ: ${trail.join(" / ")}`);
      }
      console.log(`[P1-5] 監査ログのつながりを確かめた（${audit.length} 行）`);
    });

    it("11.5：logs/ の下のどのファイルにも、本物の資格（と仮の札）が出ていない。箱の中から出力されたものは伏せ字になる", () => {
      const files = listFilesRecursive(paths.logsDir);
      const runLogs = [...manual.runs, ...cron.runs].map((r) => paths.runLog(r.id));
      expect(files).toEqual(expect.arrayContaining(runLogs));
      const placeholders = [manualBox, cronBox].map(
        (box) => /^GITHUB_TOKEN=(.*)$/m.exec(box.read("env"))?.[1] ?? "",
      );
      expect(
        findLeaks(files, {
          anthropic: secrets.anthropic,
          github: secrets.github,
          placeholder_1: placeholders[0] as string,
          placeholder_2: placeholders[1] as string,
          api_token: token,
        }),
      ).toEqual([]);
      for (const log of runLogs) {
        const text = readFileSync(log, "utf8");
        expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN=****");
        expect(text).toContain("GITHUB_TOKEN=GONDOLIN_SECRET_****");
      }
      expect(JSON.stringify(audit)).not.toContain(secrets.github);
      expect(JSON.stringify(audit)).not.toContain(secrets.anthropic);
      console.log(
        `[11.5] logs/ の ${files.length} ファイルに、本物の資格・仮の札は出ていない（箱の中から出力したものは伏せ字）`,
      );
    });
  },
);
