import type { CompanyConfig, TriggerKind } from "@aicoop/shared";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStateDb, type StateDb } from "../db/open.ts";
import { createTask, getTask, transitionTask } from "../db/tasks.ts";
import { setUsageState } from "../db/usage.ts";
import { aicoopPaths } from "../paths.ts";
import type { RunEnvironment, StartRun } from "../run/types.ts";
import { createTestCompany, manyGroupsFiles } from "../testing/company.ts";
import { fakeStartRun, flushMicrotasks } from "../testing/fake-start-run.ts";
import { type ManualClock, manualClock } from "../testing/manual-clock.ts";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import { createTaskScheduler, type TaskScheduler } from "./scheduler.ts";

let dir: TempDir;
let clock: ManualClock;
let db: StateDb;
let config: CompanyConfig;
let env: RunEnvironment;
let schedulers: TaskScheduler[];

beforeEach(() => {
  dir = tempDir();
  clock = manualClock("2026-11-28T00:00:00.000Z");
  config = createTestCompany(dir.path, { files: manyGroupsFiles(4) }).load();
  db = openStateDb(":memory:", { now: clock.now });
  env = { db, paths: aicoopPaths(dir.path), drivers: {}, logger: pino({ level: "silent" }) };
  schedulers = [];
});

afterEach(async () => {
  for (const s of schedulers) await s.stop();
  db.close();
  dir.cleanup();
});

function scheduler(startRun: StartRun, getConfig: () => CompanyConfig = () => config) {
  const s = createTaskScheduler({
    db,
    env,
    startRun,
    config: getConfig,
    timers: clock,
    now: clock.now,
    logger: env.logger,
  });
  schedulers.push(s);
  return s;
}

function task(member: string, triggerKind: TriggerKind = "manual") {
  const group = member.replace(/^m/, "g");
  return createTask(db, {
    memberId: member,
    groupId: group,
    triggerKind,
    purpose: `${member} の仕事`,
    doneWhen: "終わったら報告する",
    timeoutMinutes: 45,
  });
}

const statusOf = (id: string) => getTask(db, id)?.status;

describe("5.5.4：順番待ちのループ", () => {
  it("5.1.3 の受け入れ条件：同じ部署のタスクが2つ同時に来たら、2つ目は1つ目が終わってから始まる", async () => {
    const fake = fakeStartRun();
    const s = scheduler(fake.startRun);
    const first = task("m1");
    const second = task("m1");
    s.kick();
    await flushMicrotasks();

    expect(fake.running()).toEqual([first.id]);
    expect(statusOf(second.id)).toBe("queued");

    await fake.finish(first.id);
    expect(statusOf(first.id)).toBe("done");
    expect(fake.running()).toEqual([second.id]);
    expect(statusOf(second.id)).toBe("running");
  });

  it("5.1.5 の受け入れ条件：4つの部署に同時にタスクが来たら、3つが動き、1つは最初に終わった箱のあとに始まる", async () => {
    expect(config.aicoop.daemon.max_concurrent_boxes).toBe(3);
    const fake = fakeStartRun();
    const s = scheduler(fake.startRun);
    const tasks = ["m1", "m2", "m3", "m4"].map((m) => task(m));
    s.kick();
    await flushMicrotasks();

    expect(fake.running()).toEqual(tasks.slice(0, 3).map((t) => t.id));
    expect(statusOf(tasks[3]?.id ?? "")).toBe("queued");

    // 2番目に始まったものが最初に終わる
    await fake.finish(tasks[1]?.id ?? "");
    expect(fake.running()).toEqual([tasks[0], tasks[2], tasks[3]].map((t) => t?.id));
  });

  it("5.5.4 の1：優先度の小さい順に始める（manual は cron より先。作られたのが後でも）", async () => {
    const fake = fakeStartRun();
    const s = scheduler(fake.startRun);
    const cron = task("m1", "cron");
    clock.advance(1000);
    const manual = task("m1", "manual");
    s.kick();
    await flushMicrotasks();
    expect(fake.running()).toEqual([manual.id]);
    await fake.finish(manual.id);
    expect(fake.running()).toEqual([cron.id]);
  });

  it("5.5.4 の3：始められないタスクは飛ばして、後ろのタスクを先に始める", async () => {
    const fake = fakeStartRun();
    const s = scheduler(fake.startRun);
    const a = task("m1");
    const b = task("m1");
    const c = task("m2");
    s.kick();
    await flushMicrotasks();
    expect(fake.running()).toEqual([a.id, c.id]);
    expect(statusOf(b.id)).toBe("queued");
  });

  it("タスクが作られたとき（kick）に見直す。kick しなくても、数秒ごとに見直す", async () => {
    const fake = fakeStartRun();
    const s = scheduler(fake.startRun);
    s.start();
    const t = task("m1");
    expect(fake.running()).toEqual([]);
    clock.advance(5000);
    await flushMicrotasks();
    expect(fake.running()).toEqual([t.id]);
  });

  it("6.1：startRun には、そのときの設定を渡す。あとで設定が変わっても、動いているタスクの設定は変わらない", async () => {
    const fake = fakeStartRun();
    let current = config;
    const s = scheduler(fake.startRun, () => current);
    const first = task("m1");
    s.kick();
    await flushMicrotasks();
    const before = current;
    current = { ...config, aicoop: { ...config.aicoop } };
    const second = task("m2");
    s.kick();
    await flushMicrotasks();
    expect(fake.runs.find((r) => r.taskId === first.id)?.config).toBe(before);
    expect(fake.runs.find((r) => r.taskId === second.id)?.config).toBe(current);
  });

  it("5.1.5：読み直しで max_concurrent_boxes が変われば、次の見直しから新しい上限を使う", async () => {
    const fake = fakeStartRun();
    let current = config;
    const s = scheduler(fake.startRun, () => current);
    for (const m of ["m1", "m2", "m3", "m4"]) task(m);
    current = {
      ...config,
      aicoop: { ...config.aicoop, daemon: { ...config.aicoop.daemon, max_concurrent_boxes: 1 } },
    };
    s.kick();
    await flushMicrotasks();
    expect(fake.running()).toHaveLength(1);
  });
});

describe("5.4.6・5.5.3：利用枠", () => {
  it("5.5.4 の4：利用枠で止まっているあいだは始めない。再開予定時刻 + 60秒を過ぎたら始める", async () => {
    const fake = fakeStartRun();
    const s = scheduler(fake.startRun);
    s.start();
    setUsageState(db, { status: "rejected", resetsAt: "2026-11-28T01:00:00.000Z" });
    const t = task("m1");
    s.kick();
    await flushMicrotasks();
    expect(fake.running()).toEqual([]);

    clock.advanceTo("2026-11-28T01:00:55.000Z");
    await flushMicrotasks();
    expect(fake.running()).toEqual([]);

    clock.advanceTo("2026-11-28T01:01:05.000Z");
    await flushMicrotasks();
    expect(fake.running()).toEqual([t.id]);
  });

  it("5.5.3：waiting_limit のタスクは、retry_at を過ぎたら queued に戻り、また始まる（過ぎる前は戻さない）", async () => {
    const fake = fakeStartRun();
    const s = scheduler(fake.startRun);
    s.start();
    const t = task("m1");
    s.kick();
    await flushMicrotasks();
    await fake.finish(t.id, "waiting_limit", { retryAt: "2026-11-28T00:10:00.000Z" });
    expect(statusOf(t.id)).toBe("waiting_limit");

    clock.advanceTo("2026-11-28T00:09:58.000Z");
    await flushMicrotasks();
    expect(statusOf(t.id)).toBe("waiting_limit");

    clock.advanceTo("2026-11-28T00:10:05.000Z");
    await flushMicrotasks();
    expect(statusOf(t.id)).toBe("running");
    expect(fake.runs.filter((r) => r.taskId === t.id)).toHaveLength(2);
  });
});

describe("止めるとき・失敗したとき", () => {
  it("stop：新しいタスクを始めず、動いている実行をすべて daemon_stop で取り消して、終わるまで待つ", async () => {
    const fake = fakeStartRun();
    const s = scheduler(fake.startRun);
    const a = task("m1");
    const b = task("m2");
    s.kick();
    await flushMicrotasks();
    expect(fake.running()).toEqual([a.id, b.id]);

    await s.stop();
    expect(fake.runs.map((r) => r.cancelledWith)).toEqual(["daemon_stop", "daemon_stop"]);
    expect(statusOf(a.id)).toBe("failed");
    expect(s.active()).toEqual([]);

    const c = task("m3");
    s.kick();
    s.runPass();
    await flushMicrotasks();
    expect(statusOf(c.id)).toBe("queued");
  });

  it("startRun が例外を投げたら、そのタスクを failed（start_failed）にし、ほかのタスクは始める", async () => {
    const fake = fakeStartRun();
    const broken = task("m1");
    const fine = task("m2");
    const startRun: StartRun = (e, req) => {
      if (req.taskId === broken.id) throw new Error("箱のドライバーがない");
      return fake.startRun(e, req);
    };
    const s = scheduler(startRun);
    s.kick();
    await flushMicrotasks();
    expect(getTask(db, broken.id)).toMatchObject({ status: "failed", error: "start_failed" });
    expect(fake.running()).toEqual([fine.id]);
  });

  it("5.1.3：starting・running なのに実行の記録がないタスクの部署にも、次のタスクを入れない（拒否側）", async () => {
    const fake = fakeStartRun();
    const s = scheduler(fake.startRun);
    const orphan = task("m1");
    transitionTask(db, orphan.id, "starting");
    const next = task("m1");
    s.kick();
    await flushMicrotasks();
    expect(statusOf(next.id)).toBe("queued");
  });
});
