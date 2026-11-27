import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonInfo } from "../api/contract.ts";
import { appendAudit, listAuditLog, verifyAuditLog } from "../db/audit.ts";
import { openStateDb } from "../db/open.ts";
import { createTask, getTask, listTasks, transitionTask } from "../db/tasks.ts";
import { aicoopPaths } from "../paths.ts";
import { createTestCompany, enableTemplateCron } from "../testing/company.ts";
import { startTestDaemon, type TestDaemon } from "../testing/daemon.ts";
import { fakeStartRun, flushMicrotasks } from "../testing/fake-start-run.ts";
import { manualClock } from "../testing/manual-clock.ts";
import { tempDir } from "../testing/state-db.ts";
import { DaemonStartError } from "./start.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function started(opts: Parameters<typeof startTestDaemon>[0] = {}): Promise<TestDaemon> {
  const t = await startTestDaemon(opts);
  cleanups.push(() => t.cleanup());
  return t;
}

function newCompany(opts: Parameters<typeof createTestCompany>[1] = {}) {
  const dir = tempDir();
  cleanups.push(() => dir.cleanup());
  return { dir, company: createTestCompany(dir.path, opts) };
}

async function expectStartError(p: Promise<unknown>): Promise<DaemonStartError> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DaemonStartError);
  return error as DaemonStartError;
}

describe("aicoop daemon の起動（startDaemon）", () => {
  it("6.1・6.10：設定にエラーがあれば起動せず、DaemonStartError の issues に誤りを入れる。何も作らない", async () => {
    const existing = newCompany({
      transform: (target, text) =>
        target === "aicoop.yaml" ? text.replace("port: 7070", "port: 99999") : text,
    });
    const error = await expectStartError(startTestDaemon({ existing }));
    expect(error.code).toBe("config_invalid");
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues[0]).toMatchObject({ code: "E-013", source: "aicoop.yaml" });
    expect(error.message).toMatch(/設定/);
    const paths = aicoopPaths(existing.company.home);
    expect(existsSync(paths.stateDb)).toBe(false);
    expect(existsSync(paths.runtimeDir)).toBe(false);
  });

  it("起動すると runtime/daemon.json（pid・ポート・起動時刻・home・版）を書き、127.0.0.1 で待ち受ける", async () => {
    const t = await started();
    const paths = aicoopPaths(t.company.home);
    const info = JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo;
    expect(info).toEqual({
      pid: process.pid,
      port: t.daemon.port,
      started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      home: t.company.home,
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });
    expect(t.daemon.info).toEqual(info);
    expect(t.daemon.port).toBeGreaterThan(0);
    const status = await t.api({ path: "/status" });
    expect(status.status).toBe(200);
  });

  it("9.2：runtime/api_token にランダムなトークンを書く（Linux・macOS では 0600）。起動ごとに作り直す", async () => {
    const existing = newCompany();
    const paths = aicoopPaths(existing.company.home);
    const first = await startTestDaemon({ existing });
    const token1 = readFileSync(paths.apiToken, "utf8");
    expect(token1).toBe(first.daemon.token);
    expect(token1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    if (process.platform !== "win32") {
      expect(statSync(paths.apiToken).mode & 0o777).toBe(0o600);
    }
    await first.daemon.stop();

    const second = await startTestDaemon({ existing });
    cleanups.push(() => second.daemon.stop());
    const token2 = readFileSync(paths.apiToken, "utf8");
    expect(token2).not.toBe(token1);
    // 前のトークンは、もう通らない
    const old = await second.api({ path: "/status", token: token1 });
    expect(old.status).toBe(401);
  });

  it("止めると daemon.json・api_token を消し、state.db を閉じ、stopped が解決する。何度止めてもよい", async () => {
    const existing = newCompany();
    const paths = aicoopPaths(existing.company.home);
    const t = await startTestDaemon({ existing });
    await t.daemon.stop();
    await t.daemon.stop();
    await t.daemon.stopped;
    expect(existsSync(paths.daemonInfo)).toBe(false);
    expect(existsSync(paths.apiToken)).toBe(false);
    expect(readdirSync(paths.runtimeDir)).toEqual([]);
    // 閉じた state.db は、ほかの接続から開ける
    const db = openStateDb(paths.stateDb);
    expect(verifyAuditLog(db).ok).toBe(true);
    db.close();
    // もう待ち受けていない
    await expect(t.api({ path: "/status" })).rejects.toThrow();
  });

  it("拒否：すでに同じ home で daemon が動いていれば起動しない（already_running）。動いている方は止めない", async () => {
    const t = await started();
    const error = await expectStartError(
      startTestDaemon({ existing: { dir: t.dir, company: t.company } }),
    );
    expect(error.code).toBe("already_running");
    expect(error.message).toContain(String(process.pid));
    expect((await t.api({ path: "/status" })).status).toBe(200);
    expect(existsSync(aicoopPaths(t.company.home).daemonInfo)).toBe(true);
  });

  it("daemon.json が残っていても、その pid が動いていなければ起動する", async () => {
    const existing = newCompany();
    const paths = aicoopPaths(existing.company.home);
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(paths.runtimeDir, { recursive: true });
    writeFileSync(
      paths.daemonInfo,
      JSON.stringify({
        pid: dead,
        port: 1,
        started_at: "",
        home: existing.company.home,
        version: "0",
      }),
    );
    writeFileSync(join(paths.runtimeDir, "daemon.lock"), String(dead));
    const t = await startTestDaemon({ existing });
    cleanups.push(() => t.daemon.stop());
    expect(t.daemon.info.pid).toBe(process.pid);
  });

  it("拒否：ポートが使われていれば、分かりやすいエラー（port_in_use）で起動せず、あとに何も残さない", async () => {
    const blocker: Server = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    const address = blocker.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    const existing = newCompany();
    const error = await expectStartError(startTestDaemon({ existing, daemon: { port } }));
    expect(error.code).toBe("port_in_use");
    expect(error.message).toContain(String(port));
    expect(error.message).toContain("daemon.port");
    const paths = aicoopPaths(existing.company.home);
    expect(existsSync(paths.daemonInfo)).toBe(false);
    expect(existsSync(paths.apiToken)).toBe(false);
    // 片付いているので、別のポートなら起動できる
    const t = await startTestDaemon({ existing });
    cleanups.push(() => t.daemon.stop());
  });

  it("8.6：起動したら、running のタスクは failed（error: daemon_restart）、starting のタスクは queued に戻してから順番待ちに入れる", async () => {
    const existing = newCompany();
    const paths = aicoopPaths(existing.company.home);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(existing.company.home, { recursive: true });
    const db = openStateDb(paths.stateDb);
    const base = {
      groupId: "dev",
      triggerKind: "manual" as const,
      purpose: "p",
      doneWhen: "d",
      timeoutMinutes: 45,
    };
    const running = createTask(db, { ...base, memberId: "dev-implementer" });
    transitionTask(db, running.id, "starting");
    transitionTask(db, running.id, "running");
    const starting = createTask(db, { ...base, memberId: "dev-reviewer" });
    transitionTask(db, starting.id, "starting");
    db.close();

    const fake = fakeStartRun();
    const t = await startTestDaemon({ existing, fake });
    cleanups.push(() => t.daemon.stop());
    await flushMicrotasks();
    const view = await t.api({ path: `/tasks/${running.id}` });
    expect(view.json.task).toMatchObject({ status: "failed", error: "daemon_restart" });
    // starting だったものは queued に戻り、順番が来て始まる
    expect(fake.runs.map((r) => r.taskId)).toEqual([starting.id]);
  });

  it("8.6・6.1：前の制御サーバーが落ちて残った runtime/<run_id>/（mcp.json のゲートのトークンなど）を消す", async () => {
    const existing = newCompany();
    const paths = aicoopPaths(existing.company.home);
    const { mkdirSync } = await import("node:fs");
    const { newId } = await import("@aicoop/shared");
    const stale = newId("run");
    mkdirSync(paths.runEtc(stale), { recursive: true });
    writeFileSync(join(paths.runEtc(stale), "mcp.json"), "{}");

    const t = await startTestDaemon({ existing, fake: fakeStartRun() });
    cleanups.push(() => t.daemon.stop());
    expect(existsSync(paths.runDir(stale))).toBe(false);
  });

  it("5.10：起動時に監査ログ config.load（読み込んだ設定ファイルごとの SHA-256）を書く", async () => {
    const t = await started();
    const entries = (await t.api({ path: "/audit" })).json.entries as Array<{
      kind: string;
      actor: string;
      data: { files: Record<string, string> };
    }>;
    const load = entries.find((e) => e.kind === "config.load");
    expect(load?.actor).toBe("system");
    expect(Object.keys(load?.data.files ?? {})).toEqual(
      expect.arrayContaining([
        "aicoop.yaml",
        "groups.yaml",
        "members.yaml",
        "roles.yaml",
        "triggers.yaml",
      ]),
    );
    for (const hash of Object.values(load?.data.files ?? {}))
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("5.10 の5：起動時と1日1回、audit.retention_days を過ぎた監査ログを消し、checkpoint を書く。つながりは保たれる", async () => {
    const clock = manualClock("2026-11-28T00:00:00.000Z");
    const existing = newCompany({
      transform: (target, text) =>
        target === "aicoop.yaml" ? text.replace("retention_days: 365", "retention_days: 30") : text,
    });
    const paths = aicoopPaths(existing.company.home);
    // 40日前の行
    const oldClock = manualClock("2026-10-19T00:00:00.000Z");
    const db = openStateDb(paths.stateDb, { now: oldClock.now });
    appendAudit(db, {
      actor: "system",
      kind: "secret.change",
      subject: "github",
      data: { secret_id: "github", change: "set" },
    });
    db.close();

    const t = await startTestDaemon({ existing, daemon: { now: clock.now, timers: clock } });
    cleanups.push(() => t.daemon.stop());
    const after = (await t.api({ path: "/audit" })).json.entries as Array<{
      kind: string;
      ts: string;
    }>;
    expect(after.map((e) => e.kind)).not.toContain("secret.change");
    expect(after.map((e) => e.kind)).toContain("checkpoint");

    // 31日たつと、起動したときの行も保存期間を過ぎ、1日1回の片付けで消える
    clock.jump(31 * 24 * 3600_000);
    const later = (await t.api({ path: "/audit?limit=1000" })).json.entries as Array<{
      kind: string;
      ts: string;
    }>;
    expect(later.some((e) => e.ts.startsWith("2026-11-28"))).toBe(false);
    expect(later.at(-1)).toMatchObject({ kind: "checkpoint", ts: "2026-12-29T00:00:00.000Z" });
    await t.daemon.stop();
    const check = openStateDb(paths.stateDb);
    expect(verifyAuditLog(check).ok).toBe(true);
    expect(listAuditLog(check).length).toBeGreaterThan(0);
    check.close();
  });

  it("11.5：起動時に、30日を過ぎたログ（logs/daemon-*.log・logs/runs/*.jsonl）を消す", async () => {
    const existing = newCompany();
    const paths = aicoopPaths(existing.company.home);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(paths.runLogsDir, { recursive: true });
    writeFileSync(join(paths.logsDir, "daemon-2020-01-01.log"), "{}\n");
    const t = await startTestDaemon({ existing });
    cleanups.push(() => t.daemon.stop());
    expect(existsSync(join(paths.logsDir, "daemon-2020-01-01.log"))).toBe(false);
    // 今日のログは書かれている
    expect(readdirSync(paths.logsDir).some((f) => /^daemon-\d{4}-\d{2}-\d{2}\.log$/.test(f))).toBe(
      true,
    );
  });

  it("handleSignals: true なら SIGINT・SIGTERM で止まり、止まったら登録を外す", async () => {
    const before = process.listenerCount("SIGTERM");
    const t = await startTestDaemon({ daemon: { handleSignals: true } });
    cleanups.push(() => t.dir.cleanup());
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
    const listener = process.listeners("SIGTERM").at(-1) as () => void;
    listener();
    await t.daemon.stopped;
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("P1 完了条件4：cron で起きて、仕事をして報告し、終わる", () => {
  it("雛形の cron（平日 8:00）を有効にすると、その時刻にタスクができ、実行されて done になる", async () => {
    // 2026-11-30（月）07:59 JST
    const clock = manualClock("2026-11-29T22:59:00.000Z");
    const t = await started({
      company: { transform: enableTemplateCron },
      daemon: { now: clock.now, timers: clock },
    });
    const status = await t.api({ path: "/status" });
    expect(status.json.triggers).toEqual([
      {
        id: "sales-morning-news",
        type: "cron",
        member: "sales-researcher",
        enabled: true,
        next_run_at: "2026-11-29T23:00:00.000Z",
      },
    ]);
    expect((await t.api({ path: "/tasks" })).json.tasks).toEqual([]);

    clock.advance(60_000);
    await flushMicrotasks();
    const tasks = (await t.api({ path: "/tasks" })).json.tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      member_id: "sales-researcher",
      group_id: "sales",
      trigger_kind: "cron",
      trigger_id: "sales-morning-news",
      status: "done",
      result_summary: "できました",
      timeout_minutes: 30,
    });
    expect(t.fake.runs.map((r) => r.taskId)).toEqual([tasks[0].id]);
  });
});

describe("止めるとき", () => {
  it("動いている実行を daemon_stop で取り消し、終わるのを待ってから閉じる", async () => {
    const fake = fakeStartRun();
    const t = await startTestDaemon({ fake });
    cleanups.push(() => t.dir.cleanup());
    const created = await t.api({
      method: "POST",
      path: "/tasks",
      body: { member: "dev-implementer", purpose: "実装する", done_when: "PR を出した" },
    });
    await flushMicrotasks();
    expect(fake.running()).toEqual([created.json.task.id]);
    await t.daemon.stop();
    expect(fake.runs[0]?.cancelledWith).toBe("daemon_stop");
    const db = openStateDb(aicoopPaths(t.company.home).stateDb);
    expect(getTask(db, created.json.task.id)).toMatchObject({
      status: "failed",
      error: "daemon_stopped",
    });
    expect(listTasks(db)).toHaveLength(1);
    db.close();
  });
});
