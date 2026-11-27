import type { BoxDriver, CompanyConfig, CronTriggerConfig } from "@aicoop/shared";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStateDb, type StateDb } from "../db/open.ts";
import { listTasks } from "../db/tasks.ts";
import type { BoxDrivers } from "../run/types.ts";
import { createTestCompany, type TestCompany, withLaterPhaseMembers } from "../testing/company.ts";
import { type ManualClock, manualClock } from "../testing/manual-clock.ts";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import { checkRunnableMember } from "./runnable.ts";
import { createCronTask, startTriggers, type TriggerSet } from "./triggers.ts";

const logger = pino({ level: "silent" });
const vmDriver = {
  kind: "vm",
  create: async () => Promise.reject(new Error("使わない")),
} as BoxDriver;
const drivers: BoxDrivers = { vm: vmDriver };

let dir: TempDir;
let clock: ManualClock;
let sets: TriggerSet[];

beforeEach(() => {
  dir = tempDir();
  // 2026-11-29 07:59 JST
  clock = manualClock("2026-11-28T22:59:00.000Z");
  sets = [];
});

afterEach(() => {
  for (const s of sets) s.stop();
  dir.cleanup();
});

function company(triggersYaml: string, extra: Record<string, string> = {}): TestCompany {
  return createTestCompany(dir.path, { files: { "triggers.yaml": triggersYaml, ...extra } });
}

function start(config: CompanyConfig, fired: Array<{ id: string; at: string }>) {
  const set = startTriggers({
    config,
    timers: clock,
    now: clock.now,
    logger,
    canRun: (member) => checkRunnableMember(config, member, drivers),
    onCron: (trigger, at) => fired.push({ id: trigger.id, at: at.toISOString() }),
  });
  sets.push(set);
  return set;
}

const cron = (id: string, schedule: string, more = "") => `
  - id: "${id}"
    type: cron
    schedule: "${schedule}"
    member: "sales-researcher"${more}
    task:
      purpose: "調べる"
      done_when: "まとめた"
`;

describe("5.5.1・6.6：cron トリガー", () => {
  it("P1 完了条件4：決まった時刻（aicoop.yaml の timezone）に起きる。それまでは起きない", () => {
    const config = company(`triggers:${cron("morning", "0 8 * * *")}`).load();
    expect(config.aicoop.timezone).toBe("Asia/Tokyo");
    const fired: Array<{ id: string; at: string }> = [];
    start(config, fired);

    clock.advanceTo("2026-11-28T22:59:59.000Z");
    expect(fired).toEqual([]);
    clock.advanceTo("2026-11-28T23:00:00.000Z");
    expect(fired).toEqual([{ id: "morning", at: "2026-11-28T23:00:00.000Z" }]);
  });

  it("次の回も起きる。同じ回で2度は起きない", () => {
    const config = company(`triggers:${cron("morning", "0 8 * * *")}`).load();
    const fired: Array<{ id: string; at: string }> = [];
    start(config, fired);
    clock.advanceTo("2026-11-30T23:30:00.000Z");
    expect(fired.map((f) => f.at)).toEqual([
      "2026-11-28T23:00:00.000Z",
      "2026-11-29T23:00:00.000Z",
      "2026-11-30T23:00:00.000Z",
    ]);
  });

  it("setTimeout で待てる長さ（約24.8日）より先の回も、その時刻に起きる", () => {
    // 毎年1月1日 9:00（JST）
    const config = company(`triggers:${cron("yearly", "0 9 1 1 *")}`).load();
    const fired: Array<{ id: string; at: string }> = [];
    start(config, fired);
    clock.advanceTo("2026-12-31T23:59:59.000Z");
    expect(fired).toEqual([]);
    clock.advanceTo("2027-01-01T00:00:00.000Z");
    expect(fired).toEqual([{ id: "yearly", at: "2027-01-01T00:00:00.000Z" }]);
  });

  it("6.6：enabled: false のトリガーは動かさない（/status には enabled: false で見せる）", () => {
    const config = company(
      `triggers:${cron("off", "* * * * *", "\n    enabled: false")}${cron("on", "* * * * *")}`,
    ).load();
    const fired: Array<{ id: string; at: string }> = [];
    const set = start(config, fired);
    clock.advance(3 * 60_000);
    expect(new Set(fired.map((f) => f.id))).toEqual(new Set(["on"]));
    expect(set.views()).toEqual([
      { id: "off", type: "cron", member: "sales-researcher", enabled: false, next_run_at: null },
      {
        id: "on",
        type: "cron",
        member: "sales-researcher",
        enabled: true,
        next_run_at: "2026-11-28T23:03:00.000Z",
      },
    ]);
  });

  it("5.5.1：github・on_hold_resolved は P1 では動かさず、/status では enabled: false にする", () => {
    const config = company(
      `triggers:
  - id: "dev-issue"
    type: github
    events: ["issues.labeled"]
    member: "dev-implementer"
    task:
      purpose: "Issue #{{issue.number}} を実装する"
      done_when: "PR を出した"
  - id: "hold-result"
    type: on_hold_resolved
    member: "dev-implementer"
`,
    ).load();
    const fired: Array<{ id: string; at: string }> = [];
    const set = start(config, fired);
    clock.advance(24 * 3600_000);
    expect(fired).toEqual([]);
    expect(set.views()).toEqual([
      {
        id: "dev-issue",
        type: "github",
        member: "dev-implementer",
        enabled: false,
        next_run_at: null,
      },
      {
        id: "hold-result",
        type: "on_hold_resolved",
        member: "dev-implementer",
        enabled: false,
        next_run_at: null,
      },
    ]);
  });

  it("P1 で動かせない社員（箱のドライバーがない部署）の cron は動かさない", () => {
    const config = company(`triggers:${cron("morning", "* * * * *")}`).load();
    const fired: Array<{ id: string; at: string }> = [];
    const set = startTriggers({
      config,
      timers: clock,
      now: clock.now,
      logger,
      canRun: (member) => checkRunnableMember(config, member, {}),
      onCron: (trigger, at) => fired.push({ id: trigger.id, at: at.toISOString() }),
    });
    sets.push(set);
    clock.advance(5 * 60_000);
    expect(fired).toEqual([]);
    expect(set.views()[0]?.enabled).toBe(false);
  });

  it("止めたら、もう起きない", () => {
    const config = company(`triggers:${cron("minutely", "* * * * *")}`).load();
    const fired: Array<{ id: string; at: string }> = [];
    const set = start(config, fired);
    clock.advance(60_000);
    expect(fired).toHaveLength(1);
    set.stop();
    clock.advance(10 * 60_000);
    expect(fired).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  it("起きる処理が例外を投げても、次の回は起きる", () => {
    const config = company(`triggers:${cron("minutely", "* * * * *")}`).load();
    let count = 0;
    const set = startTriggers({
      config,
      timers: clock,
      now: clock.now,
      logger,
      canRun: (member) => checkRunnableMember(config, member, drivers),
      onCron: () => {
        count++;
        throw new Error("失敗");
      },
    });
    sets.push(set);
    clock.advance(3 * 60_000);
    expect(count).toBe(3);
  });
});

describe("5.5.1・6.6・5.5.5：cron が起きたときに作るタスク", () => {
  let db: StateDb;
  beforeEach(() => {
    db = openStateDb(":memory:", { now: clock.now });
  });
  afterEach(() => db.close());

  function fire(config: CompanyConfig) {
    const trigger = config.triggers[0] as CronTriggerConfig;
    const check = checkRunnableMember(config, trigger.member, drivers);
    if (!check.ok) throw new Error(check.message);
    return createCronTask(db, config, trigger, check.member);
  }

  it("トリガーの社員・部署で、trigger_kind cron・trigger_id・優先度4 の queued のタスクを作る", () => {
    const config = company(`triggers:${cron("morning", "0 8 * * *")}`).load();
    const task = fire(config);
    expect(task).toMatchObject({
      memberId: "sales-researcher",
      groupId: "sales",
      triggerKind: "cron",
      triggerId: "morning",
      priority: 4,
      status: "queued",
      purpose: "調べる",
      doneWhen: "まとめた",
      context: "",
      contextUntrusted: false,
      replyAs: "file",
    });
    expect(listTasks(db)).toHaveLength(1);
  });

  it("6.6：スレッドは、トリガーの thread があればそれ、なければ task-<task_id>", () => {
    const withThread = company(
      `triggers:${cron("morning", "0 8 * * *", '\n    thread: "morning-news"')}`,
    ).load();
    expect(fire(withThread).thread).toBe("morning-news");
    const without = company(`triggers:${cron("morning", "0 8 * * *")}`).load();
    const task = fire(without);
    expect(task.thread).toBe(`task-${task.id}`);
  });

  it("5.5.5：時間制限は、トリガーの timeout_minutes、なければ aicoop.yaml の task.timeout_minutes", () => {
    const own = company(
      `triggers:${cron("morning", "0 8 * * *", "\n    timeout_minutes: 20")}`,
    ).load();
    expect(fire(own).timeoutMinutes).toBe(20);
    const fallback = company(`triggers:${cron("morning", "0 8 * * *")}`).load();
    expect(fire(fallback).timeoutMinutes).toBe(45);
  });
});

describe("P1 で動かせる社員か", () => {
  it("vm の部署の AI の社員は動かせる。部長は役員室（executives）の箱で動く", () => {
    const config = createTestCompany(dir.path, { transform: withLaterPhaseMembers }).load();
    const dev = checkRunnableMember(config, "dev-implementer", drivers);
    expect(dev.ok && dev.member.group.id).toBe("dev");
    const manager = checkRunnableMember(config, "mgr-dev", drivers);
    expect(manager.ok && manager.member.group.id).toBe("executives");
  });

  it("拒否：設定にいない社員・CEO（box: none）・ドライバーのない箱（srt）の社員は動かせない（日本語の理由つき）", () => {
    const config = createTestCompany(dir.path, { transform: withLaterPhaseMembers }).load();
    for (const member of ["nobody", "ceo", "design-image", "constructor", "__proto__"]) {
      const check = checkRunnableMember(config, member, drivers);
      expect(check.ok, member).toBe(false);
      if (!check.ok) expect(check.message).toMatch(/[ぁ-ん]/);
    }
  });

  it("拒否：人間の社員はタスクを作れない", () => {
    const config = createTestCompany(dir.path).load();
    const withHuman: CompanyConfig = {
      ...config,
      members: {
        ...config.members,
        "a-san": {
          kind: "human",
          name: "Aさん",
          company_id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
          public_key: "pk",
        },
      },
    };
    const check = checkRunnableMember(withHuman, "a-san", drivers);
    expect(check).toMatchObject({ ok: false });
    if (!check.ok) expect(check.message).toContain("人間の社員");
  });
});
