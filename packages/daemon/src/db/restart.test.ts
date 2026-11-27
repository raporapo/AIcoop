import type { TaskStatus } from "@aicoop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeClock, memoryDb } from "../testing/state-db.ts";
import { listAuditLog, verifyAuditLog } from "./audit.ts";
import type { StateDb } from "./open.ts";
import { recoverAfterRestart } from "./restart.ts";
import { createRun, finishRun, getRun } from "./runs.ts";
import { getSession, saveSession } from "./sessions.ts";
import { createTask, getTask, transitionTask } from "./tasks.ts";

describe("8.6：制御サーバーの再起動", () => {
  let db: StateDb;
  let clock: FakeClock;
  beforeEach(() => {
    ({ db, clock } = memoryDb());
  });
  afterEach(() => db.close());

  function task(status: TaskStatus, groupId = "dev"): string {
    const t = createTask(db, {
      memberId: `${groupId}-member`,
      groupId,
      triggerKind: "cron",
      thread: `thread-${groupId}`,
      purpose: "p",
      doneWhen: "d",
      timeoutMinutes: 45,
    });
    const path: Partial<Record<TaskStatus, TaskStatus[]>> = {
      queued: [],
      starting: ["starting"],
      running: ["starting", "running"],
      done: ["starting", "running", "done"],
      waiting_limit: ["starting", "running", "waiting_limit"],
      blocked_host_tool: ["starting", "running", "blocked_host_tool"],
      cancelled: ["cancelled"],
    };
    for (const s of path[status] ?? []) {
      transitionTask(
        db,
        t.id,
        s,
        s === "waiting_limit" ? { retryAt: "2026-11-28T06:00:00.000Z" } : {},
      );
    }
    return t.id;
  }

  function run(taskId: string, groupId = "dev"): string {
    return createRun(db, {
      taskId,
      groupId,
      memberId: `${groupId}-member`,
      boxKind: "vm",
      gatewayPort: 50000,
      logDir: "logs",
    }).id;
  }

  it("8.6 の2：running のタスクは failed（error: daemon_restart）にし、実行の end_reason を daemon_restart にする", () => {
    const t = task("running");
    const r = run(t);
    clock.advance(5000);

    const result = recoverAfterRestart(db);

    expect(result.failed).toEqual([t]);
    expect(getTask(db, t)).toMatchObject({
      status: "failed",
      error: "daemon_restart",
      endedAt: "2026-11-28T00:00:05.000Z",
    });
    expect(getRun(db, r)).toMatchObject({
      endReason: "daemon_restart",
      endedAt: "2026-11-28T00:00:05.000Z",
      exitCode: null,
    });
  });

  it("8.6 の3：starting のタスクは queued に戻す（作りかけの実行も daemon_restart で閉じる）", () => {
    const t = task("starting", "sales");
    const r = run(t, "sales");

    const result = recoverAfterRestart(db);

    expect(result.requeued).toEqual([t]);
    expect(getTask(db, t)?.status).toBe("queued");
    expect(getRun(db, r)?.endReason).toBe("daemon_restart");
    expect(result.endedRuns).toEqual([r]);
  });

  it("8.6 の5：queued・waiting_limit・blocked_host_tool・終わったタスクは、そのまま引き継ぐ", () => {
    const kept = (
      ["queued", "waiting_limit", "blocked_host_tool", "done", "cancelled"] as const
    ).map((s) => [s, task(s)] as const);
    const done = kept.find(([s]) => s === "done")?.[1] as string;
    const finished = run(done);
    finishRun(db, finished, { exitCode: 0, endReason: "exited" });

    const result = recoverAfterRestart(db);

    expect(result).toEqual({ failed: [], requeued: [], endedRuns: [] });
    for (const [status, id] of kept) expect(getTask(db, id)?.status).toBe(status);
    expect(getRun(db, finished)?.endReason).toBe("exited");
  });

  it("8.6 の2：セッションは残すので、同じスレッドで頼み直せる", () => {
    const t = task("running");
    run(t);
    saveSession(db, { memberId: "dev-member", thread: "thread-dev", sessionId: "s-1" });
    recoverAfterRestart(db);
    expect(getSession(db, "dev-member", "thread-dev")?.sessionId).toBe("s-1");
  });

  it("監査ログにも残す（変化前と変化後、理由は daemon_restart）。つながりは保たれる", () => {
    const running = task("running");
    const starting = task("starting", "sales");
    const before = listAuditLog(db).length;

    recoverAfterRestart(db);

    const added = listAuditLog(db)
      .slice(before)
      .map((r) => ({ actor: r.actor, kind: r.kind, subject: r.subject, data: JSON.parse(r.data) }));
    expect(added).toEqual([
      {
        actor: "system",
        kind: "task.state",
        subject: running,
        data: { from: "running", to: "failed", reason: "daemon_restart" },
      },
      {
        actor: "system",
        kind: "task.state",
        subject: starting,
        data: { from: "starting", to: "queued", reason: "daemon_restart" },
      },
    ]);
    expect(verifyAuditLog(db)).toMatchObject({ ok: true });
  });

  it("もう一度呼んでも、何も変えない", () => {
    task("running");
    task("starting", "sales");
    recoverAfterRestart(db);
    const audit = listAuditLog(db).length;
    expect(recoverAfterRestart(db)).toEqual({ failed: [], requeued: [], endedRuns: [] });
    expect(listAuditLog(db).length).toBe(audit);
  });
});
