/**
 * P1 の完了条件（14章）を、端から端まで確かめる結合テスト（この PC でも動く。箱は偽物）。
 *
 * 本物を使うもの：`aicoop init` の雛形から作った会社の設定、資格保管庫（secrets.json）、制御サーバー（startDaemon）、
 * 1件の実行（startRun）、道具ゲート（MCP の HTTP サーバー）、資格プロキシの判定、state.db と監査ログ、ログのファイル。
 * 偽物にするもの：箱（FakeBoxDriver。Gondolin の VM の代わりに、偽の Claude Code の台本を動かす）と、cron の時計。
 *
 * 流れ（8.1）：CLI と同じく runtime/ のファイルから daemon を見つけ、ローカルAPI で手動のタスクを作る →
 * 偽の Claude Code が、資格プロキシへのリクエスト（push・API・許可していないホスト）と、道具ゲートへの
 * report_result を送る → 箱が壊されて done。そのあと、triggers.yaml に足した cron の時刻まで時計を進め、同じことを確かめる。
 *
 * 本物の VM（Gondolin）で同じことを確かめるのは `p1.vm.e2e.test.ts`（CI の vm-e2e のジョブ）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_METADATA_FILE, imageDir } from "@aicoop/box-gondolin";
import type { ProxyDecision } from "@aicoop/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GetTaskResponse, StatusResponse } from "./api/contract.ts";
import { type DaemonHandle, startDaemon } from "./daemon/start.ts";
import { verifyAuditLog } from "./db/audit.ts";
import { openStateDb, type StateDb } from "./db/open.ts";
import { type AicoopPaths, aicoopPaths } from "./paths.ts";
import { startRun } from "./run/execute.ts";
import type { TestCompany } from "./testing/company.ts";
import { FakeBoxDriver, type FakeClaude, fakeEvents } from "./testing/fake-box.ts";
import { apiRequest, type TestResponse } from "./testing/http.ts";
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
  e2eApi,
  findLeaks,
  listFilesRecursive,
  registerE2eSecrets,
  waitForTask,
  waitForTaskEnd,
} from "./testing/p1-e2e.ts";
import { type TempDir, tempDir } from "./testing/state-db.ts";

/** 箱の中で見える仮の札の形（偽の箱は仮の札を作らないので、形だけ同じものを使う） */
const PLACEHOLDER = `GONDOLIN_SECRET_${"0123456789abcdef".repeat(3)}`;

/** 偽の Claude Code が、1回の実行の中で見たもの */
interface SeenInBox {
  /** 実行を始めたときに、前の実行の仕掛けが残っていたか（5.4.4） */
  readonly leftovers: Record<string, boolean>;
  /** ホームの .claude/CLAUDE.md（5.4.3） */
  claudeMd: string;
  /** 道具ゲートの道具の一覧（5.3.1） */
  tools: string[];
  /** 資格プロキシの判定 */
  readonly decisions: Record<string, ProxyDecision>;
  /** 道具ゲートへの MCP の JSON-RPC の応答 */
  readonly mcp: Record<string, TestResponse>;
  /** /etc/aicoop/mcp.json の Authorization（その実行の道具ゲートのトークン） */
  gatewayAuthorization: string;
}

const seen: SeenInBox[] = [];

/** 作業フォルダの直下とホームに置く仕掛け（次の実行の前に片付けられるはずのもの） */
const TRAPS = {
  workClaudeMd: "/work/CLAUDE.md",
  workMcpJson: "/work/.mcp.json",
  homeSettingsLocal: "/home/agent/.claude/settings.local.json",
  homeClaudeJson: "/home/agent/.claude.json",
} as const;

/** 偽の Claude Code：箱の中の本物の Claude Code がしうることを、順にする */
const e2eClaude: FakeClaude = async (claude) => {
  const n = seen.length + 1;
  const record: SeenInBox = {
    leftovers: Object.fromEntries(
      Object.entries(TRAPS).map(([name, path]) => [name, existsSync(claude.hostPath(path))]),
    ),
    claudeMd: readFileSync(claude.hostPath("/home/agent/.claude/CLAUDE.md"), "utf8"),
    tools: [],
    decisions: {},
    mcp: {},
    gatewayAuthorization: "",
  };
  seen.push(record);
  claude.emit(fakeEvents.init(`e2e-session-${n}`));

  // 11.5：箱の中の Claude Code が、見えた値をそのまま出力してしまっても、記録には残らない
  claude.emit(fakeEvents.text(`環境変数：${JSON.stringify(claude.env)}`));
  claude.emitStderr(`CLAUDE_CODE_OAUTH_TOKEN=${claude.env.CLAUDE_CODE_OAUTH_TOKEN ?? ""}`);
  claude.emit(`GITHUB_TOKEN=${PLACEHOLDER}`);
  // 本物の資格は箱の中に無いはずだが、仮に漏れて出力されても伏せ字になることも確かめる
  for (const secret of claude.spec.secrets) claude.emit(fakeEvents.text(`値：${secret.value}`));

  // P1 完了条件2：git の push（smart HTTP）。git は資格ヘルパーの仮の札を Basic 認証で送る（5.1.8 の3）
  const basic = `Basic ${Buffer.from(`x-access-token:${PLACEHOLDER}`).toString("base64")}`;
  const push = (repo: string) =>
    claude.request({
      method: "POST",
      host: "github.com",
      path: `/${repo}.git/git-receive-pack`,
      headers: { authorization: basic, "content-type": "application/x-git-receive-pack-request" },
      body: "0000",
    });
  record.decisions.pushDenied = await push(`${E2E_OTHER_OWNER}/app`);
  record.decisions.pushAllowed = await push(`${E2E_ORG}/app`);
  record.decisions.apiAllowed = await claude.request({
    host: "api.github.com",
    path: `/repos/${E2E_ORG}/app`,
    headers: { authorization: `Bearer ${PLACEHOLDER}` },
  });
  // P1 完了条件3：許可していないホスト
  record.decisions.hostDenied = await claude.request({ host: "example.com", path: "/" });

  // 5.3.1：道具ゲート。MCP のクライアントで一覧を見たあと、箱の中の curl と同じく
  // Host: aicoop.internal で JSON-RPC を1つずつ送る（道具ゲートはセッションを持たない）。
  // ゲートのトークンは、本物の Claude Code と同じく /etc/aicoop/mcp.json の headers から読む
  record.tools = await claude.listTools();
  const mcpJson = JSON.parse(readFileSync(claude.hostPath("/etc/aicoop/mcp.json"), "utf8")) as {
    mcpServers: { aicoop: { headers: { Authorization: string } } };
  };
  record.gatewayAuthorization = mcpJson.mcpServers.aicoop.headers.Authorization;
  const mcp = (body: unknown, authorization: string | null) =>
    apiRequest(claude.spec.network.gatewayPort, {
      raw: true,
      method: "POST",
      path: "/mcp",
      host: "aicoop.internal",
      token: null,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        ...(authorization === null ? {} : { authorization }),
      },
      rawBody: JSON.stringify(body),
    });
  const report = claude.hostPath("/work/e2e/report.md");
  mkdirSync(join(report, ".."), { recursive: true });
  writeFileSync(report, `${n}回目の報告\n`);
  const reportCall = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "report_result",
      arguments: { summary: `${n}回目：確かめました`, files: ["/work/e2e/report.md"] },
    },
  };
  // トークンなし・違うトークンは 401（記録されない）
  record.mcp.noToken = await mcp(reportCall, null);
  record.mcp.wrongToken = await mcp(reportCall, "Bearer wrong-token");
  record.mcp.report = await mcp(reportCall, record.gatewayAuthorization);

  // 5.4.4：次の実行に仕掛けを残そうとする
  for (const path of Object.values(TRAPS)) writeFileSync(claude.hostPath(path), "{}\n");

  claude.emit(fakeEvents.result());
  return 0;
};

describe("P1 の完了条件（14章）：雛形の会社・本物の daemon と実行・偽の箱で、端から端まで", () => {
  let dir: TempDir | undefined;
  let company: TestCompany;
  let paths: AicoopPaths;
  let secrets: E2eSecrets;
  let driver: FakeBoxDriver;
  let daemon: DaemonHandle | undefined;
  let token = "";
  let api: Api;
  let manual: GetTaskResponse;
  let cron: GetTaskResponse;
  let statusBeforeCron: StatusResponse;
  const runDirLeft: Record<string, boolean> = {};
  let db: StateDb | undefined;
  let audit: AuditRow[] = [];

  beforeAll(async () => {
    dir = tempDir();
    company = createE2eCompany(dir.path);
    paths = aicoopPaths(company.home);
    // aicoop secret set anthropic --kind anthropic_oauth / github --kind static_token と同じ
    secrets = registerE2eSecrets(paths);
    // aicoop image build --group dev で作った箱のイメージ（開発部は packages を持つので要る。偽の箱は中身を見ない）
    const devImage = imageDir(company.home, "dev");
    mkdirSync(devImage, { recursive: true });
    writeFileSync(join(devImage, IMAGE_METADATA_FILE), '{"claudeCodeVersion":"0.0.0-e2e"}\n');

    driver = new FakeBoxDriver(e2eClaude);
    // 2026-12-01（火）02:29 JST。足した cron（毎日 2:30）の1分前
    const clock = manualClock("2026-11-30T17:29:00.000Z");
    daemon = await startDaemon({
      home: company.home,
      startRun,
      drivers: { vm: driver },
      port: 0,
      now: clock.now,
      timers: clock,
    });

    // CLI と同じく、runtime/ のファイルから daemon を見つける
    ({ api, token } = e2eApi(paths));

    // 手動のタスク（aicoop run と同じ API）
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
    manual = await waitForTaskEnd(api, created.json.task.id, 20_000);
    for (const run of manual.runs) runDirLeft[run.id] = existsSync(paths.runDir(run.id));

    // cron：足したトリガーの時刻まで時計を進める
    statusBeforeCron = (await api({ path: "/status" })).json as StatusResponse;
    clock.advance(60_000);
    const cronTask = await waitForTask(api, (t) => t.trigger_kind === "cron", 5000);
    cron = await waitForTaskEnd(api, cronTask.id, 20_000);
    for (const run of cron.runs) runDirLeft[run.id] = existsSync(paths.runDir(run.id));

    // aicoop stop と同じく API で止め、state.db を開き直す
    expect((await api({ method: "POST", path: "/shutdown" })).status).toBe(200);
    await daemon.stopped;
    db = openStateDb(paths.stateDb);
    audit = auditRows(db);
  }, 60_000);

  afterAll(async () => {
    db?.close();
    await daemon?.stop();
    dir?.cleanup();
  });

  it("前提：手動と cron の2つのタスクが、それぞれ偽の箱で1回ずつ実行された（偽の Claude Code は最後まで動いた）", () => {
    expect(driver.boxes).toHaveLength(2);
    expect(seen).toHaveLength(2);
    for (const box of driver.boxes) {
      expect(box.claudeErrors).toEqual([]);
      expect(box.execCalls).toHaveLength(1);
    }
    expect(manual.runs).toHaveLength(1);
    expect(cron.runs).toHaveLength(1);
  });

  it("P1 完了条件1：箱の環境変数（BoxSpec.env と exec の env）に本物の GitHub トークンが無い。Claude のログインのトークンは 5.4.1 の例外として claude の実行にだけ渡る", () => {
    for (const box of driver.boxes) {
      const { spec } = box;
      const call = box.execCalls[0];
      expect(JSON.stringify(spec.env)).not.toContain(secrets.github);
      expect(JSON.stringify(spec.env)).not.toContain(secrets.anthropic);
      expect(spec.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(spec.env).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(JSON.stringify(call?.env)).not.toContain(secrets.github);
      expect(call?.env).not.toHaveProperty("GITHUB_TOKEN");
      // 5.4.1 の2：本物を渡す唯一の例外
      expect(call?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(secrets.anthropic);
      expect(call?.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
      // 箱の中の claude は root で動くので、--dangerously-skip-permissions を通すために要る
      expect(call?.env.IS_SANDBOX).toBe("1");
      // 本物の GitHub トークンは、ドライバーが仮の札にする secrets にだけある（宛先は github のサービスの hosts）
      expect(spec.secrets).toEqual([
        { env: "GITHUB_TOKEN", hosts: ["api.github.com", "github.com"], value: secrets.github },
      ]);
      // 5.4.2：道具ゲートだけを MCP に渡して起動する
      expect(call?.cmd.slice(0, 2)).toEqual(["claude", "-p"]);
      expect(call?.cmd).toEqual(
        expect.arrayContaining([
          "--mcp-config",
          "/etc/aicoop/mcp.json",
          "--strict-mcp-config",
          "--dangerously-skip-permissions",
        ]),
      );
      expect(call?.cwd).toBe("/work");
      // 部署 dev は packages を持つので、部署のイメージで起こす（5.1.8 の2）
      expect(spec.image).toBe(imageDir(company.home, "dev"));
    }
  });

  it("P1 完了条件2：許可していないリポジトリ（別の owner）への push は 403 + X-Aicoop-Decision: deny、許可したリポジトリへの push は forward", () => {
    for (const record of seen) {
      const denied = record.decisions.pushDenied;
      expect(denied).toMatchObject({
        action: "respond",
        status: 403,
        headers: { "X-Aicoop-Decision": "deny" },
      });
      expect(JSON.parse((denied as { body: string }).body)).toEqual({
        aicoop: "deny",
        operation: "github.git.push",
        reason: "not_allowed",
      });
      expect(record.decisions.pushAllowed).toEqual({ action: "forward" });
      expect(record.decisions.apiAllowed).toEqual({ action: "forward" });
    }
  });

  it("P1 完了条件3：許可していないホスト（example.com）への接続は 403 + X-Aicoop-Decision: deny（開発部は web.read を許していない）", () => {
    for (const record of seen) {
      const denied = record.decisions.hostDenied;
      expect(denied).toMatchObject({
        action: "respond",
        status: 403,
        headers: { "X-Aicoop-Decision": "deny" },
      });
      expect(JSON.parse((denied as { body: string }).body)).toEqual({
        aicoop: "deny",
        operation: "web.read",
        reason: "not_allowed",
      });
    }
  });

  it("P1 完了条件4（手動）：report_result で報告すると done になり、要約とファイルが API で見え、箱が壊され、runtime/<run_id>/ が消える", () => {
    const first = seen[0] as SeenInBox;
    // 5.3.1：道具ゲートの道具は report_result だけ。セッションなしの JSON-RPC で呼べる
    expect(first.tools).toEqual(["report_result"]);
    // 道具ゲートは、その実行のトークン（mcp.json の headers）のないリクエストに答えない
    expect(first.gatewayAuthorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
    expect(first.mcp.noToken?.status).toBe(401);
    expect(first.mcp.wrongToken?.status).toBe(401);
    expect(seen[1]?.gatewayAuthorization).not.toBe(first.gatewayAuthorization);
    expect(first.mcp.report?.status).toBe(200);
    expect(first.mcp.report?.json).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(first.mcp.report?.json.result.isError).toBeUndefined();
    expect(JSON.parse(first.mcp.report?.json.result.content[0].text)).toMatchObject({ ok: true });

    expect(manual.task).toMatchObject({
      member_id: "dev-implementer",
      group_id: "dev",
      trigger_kind: "manual",
      status: "done",
      result_summary: "1回目：確かめました",
      result_files: ["e2e/report.md"],
      error: null,
    });
    expect(manual.runs[0]).toMatchObject({
      box_kind: "vm",
      session_id: "e2e-session-1",
      exit_code: 0,
      end_reason: "exited",
    });
    expect(manual.runs[0]?.ended_at).not.toBeNull();
    const box = driver.boxes[0];
    expect(box?.destroyed).toBe(1);
    expect(box?.killed).toBe(0);
    expect(runDirLeft[manual.runs[0]?.id as string]).toBe(false);
    // 5.4.3：方針と使える道具とルールを重ねた CLAUDE.md を、箱の中のホームから読める
    expect(first.claudeMd).toContain("# 会社の方針");
    expect(first.claudeMd).toContain("# 使える道具とルール");
    expect(first.claudeMd).toContain("github.git.push");
    expect(first.claudeMd).toContain(`${E2E_ORG}/*`);
  });

  it("P1 完了条件4（cron）：triggers.yaml に足した cron の時刻にタスクができ、実行されて done になり、箱が壊される", () => {
    expect(statusBeforeCron.triggers).toContainEqual({
      id: E2E_CRON_TRIGGER,
      type: "cron",
      member: "dev-implementer",
      enabled: true,
      next_run_at: "2026-11-30T17:30:00.000Z",
    });
    expect(cron.task).toMatchObject({
      member_id: "dev-implementer",
      group_id: "dev",
      trigger_kind: "cron",
      trigger_id: E2E_CRON_TRIGGER,
      status: "done",
      timeout_minutes: 20,
      result_summary: "2回目：確かめました",
      result_files: ["e2e/report.md"],
    });
    expect(cron.task.created_at).toBe("2026-11-30T17:30:00.000Z");
    expect(cron.runs[0]).toMatchObject({ session_id: "e2e-session-2", exit_code: 0 });
    expect(driver.boxes[1]?.destroyed).toBe(1);
    expect(runDirLeft[cron.runs[0]?.id as string]).toBe(false);
    // 止めたあと、runtime/ には何も残らない（daemon.json・api_token・実行のフォルダ）
    expect(listFilesRecursive(paths.runtimeDir)).toEqual([]);
  });

  it("5.4.4：1回目の実行が作業フォルダの直下とホームに残した仕掛けは、2回目の実行の前に片付いている", () => {
    expect(Object.values(seen[0]?.leftovers ?? {})).toEqual([false, false, false, false]);
    expect(seen[1]?.leftovers).toEqual({
      workClaudeMd: false,
      workMcpJson: false,
      homeSettingsLocal: false,
      homeClaudeJson: false,
    });
    const quarantined = audit.filter((r) => r.kind === "quarantine");
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]?.subject).toBe(cron.runs[0]?.id);
    expect(quarantined[0]?.data.paths).toEqual(expect.arrayContaining(["CLAUDE.md", ".mcp.json"]));
  });

  it("P1 完了条件5：監査ログのつながりが確かめられ（aicoop audit verify と同じ）、config.load・task.state・box.lifecycle・proxy.decision・gateway.call が順に並ぶ", () => {
    expect(verifyAuditLog(db as StateDb)).toMatchObject({ ok: true });
    const kinds = new Set(audit.map((r) => r.kind));
    for (const kind of [
      "config.load",
      "task.state",
      "box.lifecycle",
      "proxy.decision",
      "gateway.call",
    ]) {
      expect(kinds).toContain(kind);
    }
    expect(audit[0]?.kind).toBe("config.load");
    expect(Object.keys(audit[0]?.data.files as object)).toEqual(
      expect.arrayContaining([
        "aicoop.yaml",
        "groups.yaml",
        "roles.yaml",
        "members.yaml",
        "triggers.yaml",
      ]),
    );
    const requests = [
      "proxy.decision deny github.git.push",
      "proxy.decision allow github.git.push",
      "proxy.decision allow github.repo.read",
      "proxy.decision deny web.read",
      "gateway.call report_result ok",
    ];
    expect(auditTrail(audit, manual.task.id, manual.runs[0]?.id as string)).toEqual([
      "task.state null→queued",
      "task.state queued→starting",
      "box.lifecycle start",
      "task.state starting→running",
      ...requests,
      "box.lifecycle stop",
      "task.state running→done",
    ]);
    expect(auditTrail(audit, cron.task.id, cron.runs[0]?.id as string)).toEqual([
      "task.state null→queued",
      "task.state queued→starting",
      "quarantine",
      "box.lifecycle start",
      "task.state starting→running",
      ...requests,
      "box.lifecycle stop",
      "task.state running→done",
    ]);
    // 判定の記録に、宛先のホストとパス（クエリなし）と社員が残る
    expect(audit.find((r) => r.kind === "proxy.decision")?.data).toMatchObject({
      member: "dev-implementer",
      host: "github.com",
      path: `/${E2E_OTHER_OWNER}/app.git/git-receive-pack`,
      decision: "deny",
      reason: "not_allowed",
    });
  });

  it("11.5：logs/ の下のどのファイルにも、本物の資格（と仮の札・ローカルAPI のトークン）が出ていない。箱の中から出力されたものは伏せ字になる", () => {
    const files = listFilesRecursive(paths.logsDir);
    const runLogs = [...manual.runs, ...cron.runs].map((r) => paths.runLog(r.id));
    expect(files).toEqual(expect.arrayContaining(runLogs));
    expect(files.some((f) => /daemon-\d{4}-\d{2}-\d{2}\.log$/.test(f))).toBe(true);
    expect(
      findLeaks(files, {
        anthropic: secrets.anthropic,
        github: secrets.github,
        placeholder: PLACEHOLDER,
        api_token: token,
        ...Object.fromEntries(
          seen.map((r, i) => [`gateway_token_${i + 1}`, r.gatewayAuthorization.slice(7)]),
        ),
      }),
    ).toEqual([]);
    // 漏らそうとした行は、伏せ字にして記録してある
    for (const log of runLogs) {
      const text = readFileSync(log, "utf8");
      expect(text).toContain("GONDOLIN_SECRET_****");
      expect(text).toContain("CLAUDE_CODE_OAUTH_TOKEN=****");
    }
    // 監査ログにも出ていない
    expect(JSON.stringify(audit)).not.toContain(secrets.github);
    expect(JSON.stringify(audit)).not.toContain(secrets.anthropic);
  });
});
