import { describe, expect, it } from "vitest";
import type { BoxKind } from "./box.ts";
import {
  type ActiveBox,
  isUsageBlocked,
  pickTasksToStart,
  type SchedulableTask,
  TRIGGER_KINDS,
  TRIGGER_PRIORITY,
  type UsageGate,
} from "./scheduler.ts";

const NOW = new Date("2026-11-28T09:00:00.000Z");

let counter = 0;
function task(
  groupId: string,
  over: Partial<SchedulableTask> & { kind?: BoxKind } = {},
): SchedulableTask {
  counter++;
  const { kind, ...rest } = over;
  return {
    id: `t_${String(counter).padStart(26, "0")}`,
    groupId,
    boxKind: kind ?? "vm",
    priority: TRIGGER_PRIORITY.cron,
    createdAt: new Date(NOW.getTime() - 60_000 + counter).toISOString(),
    ...rest,
  };
}

function running(groupId: string, boxKind: BoxKind = "vm"): ActiveBox {
  return { groupId, boxKind };
}

function pick(
  queued: SchedulableTask[],
  active: ActiveBox[] = [],
  opts: { max?: number; usage?: UsageGate | null; now?: Date } = {},
): string[] {
  return pickTasksToStart({
    queued,
    active,
    maxConcurrentBoxes: opts.max ?? 3,
    usage: opts.usage ?? null,
    now: opts.now ?? NOW,
  }).map((t) => t.id);
}

describe("5.5.1：トリガーの種類ごとの優先度（小さいほど先）", () => {
  it("表のとおり", () => {
    expect(TRIGGER_PRIORITY).toEqual({
      manual: 0,
      ceo: 1,
      review: 1,
      ticket: 2,
      on_hold_resolved: 2,
      github: 3,
      cron: 4,
    });
    expect([...TRIGGER_KINDS].sort()).toEqual(Object.keys(TRIGGER_PRIORITY).sort());
  });
});

describe("5.5.4：順番待ちから、いま始めるタスクを選ぶ", () => {
  it("5.1.3 の受け入れ条件：同じ部署のタスクが2つ同時に来たら、2つ目は1つ目が終わってから始まる", () => {
    const a = task("dev");
    const b = task("dev");
    expect(pick([a, b])).toEqual([a.id]);
    // 1つ目が動いているあいだは、2つ目を始めない
    expect(pick([b], [running("dev")])).toEqual([]);
    // 1つ目が終わったら始まる
    expect(pick([b], [])).toEqual([b.id]);
  });

  it("5.1.5 の受け入れ条件：4つの部署に同時にタスクが来たら3つが動き、1つは最初に終わった箱のあとに始まる", () => {
    const tasks = [task("dev"), task("sales"), task("marketing"), task("executives")];
    const first = pick(tasks);
    expect(first).toEqual(tasks.slice(0, 3).map((t) => t.id));

    const waiting = tasks[3] as SchedulableTask;
    // 3つが動いているあいだは始まらない
    expect(pick([waiting], [running("dev"), running("sales"), running("marketing")])).toEqual([]);
    // 1つ（sales）が終わったら始まる
    expect(pick([waiting], [running("dev"), running("marketing")])).toEqual([waiting.id]);
  });

  it("5.1.5 の1：none（CEO）の箱は上限に数えない", () => {
    const ceo = task("ceo", { kind: "none" });
    const active = [running("dev"), running("sales"), running("marketing")];
    expect(pick([ceo], active)).toEqual([ceo.id]);

    // 動いている CEO も数えない
    const dev = task("design");
    expect(pick([dev], [running("ceo", "none"), running("sales"), running("marketing")])).toEqual([
      dev.id,
    ]);
  });

  it("none（CEO）でも、同じ部署で同時に動くのは1つだけ", () => {
    const a = task("ceo", { kind: "none" });
    expect(pick([a], [running("ceo", "none")])).toEqual([]);
    const b = task("ceo", { kind: "none" });
    expect(pick([a, b])).toEqual([a.id]);
  });

  it("5.5.4 の1：優先度の小さい順（あとから来た manual が、先に来た cron より先）", () => {
    const cron = task("dev", { priority: TRIGGER_PRIORITY.cron });
    const manual = task("dev", { priority: TRIGGER_PRIORITY.manual });
    expect(pick([cron, manual])).toEqual([manual.id]);
  });

  it("5.5.4 の1：同じ優先度なら作られた順", () => {
    const later = task("dev", { createdAt: "2026-11-28T08:00:00.002Z" });
    const earlier = task("dev", { createdAt: "2026-11-28T08:00:00.001Z" });
    expect(pick([later, earlier])).toEqual([earlier.id]);
  });

  it("作られた時刻まで同じなら、ID の順（同じミリ秒でも作った順に並ぶ）", () => {
    const at = "2026-11-28T08:00:00.000Z";
    const b = task("dev", { id: "t_01JD6V8X3S0Q5W7KQ9M2T4R6YC", createdAt: at });
    const a = task("dev", { id: "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB", createdAt: at });
    expect(pick([b, a])).toEqual([a.id]);
  });

  it("5.5.4 の2・3：先頭が始められなければ飛ばして次を見る（後ろのタスクが先に始まる）", () => {
    const devHigh = task("dev", { priority: TRIGGER_PRIORITY.manual });
    const devLow = task("dev");
    const sales = task("sales");
    expect(pick([devHigh, devLow, sales], [running("dev")])).toEqual([sales.id]);
  });

  it("5.5.4 の2：起動中の箱が上限に達していたら、vm の箱は始めない", () => {
    const t = task("design");
    expect(pick([t], [running("dev"), running("sales"), running("marketing")])).toEqual([]);
    expect(pick([t], [running("dev")], { max: 1 })).toEqual([]);
  });

  it("1回で選ぶものにも上限と部署の決まりを当てはめる", () => {
    const tasks = [task("dev"), task("dev"), task("sales"), task("marketing"), task("design")];
    expect(pick(tasks, [], { max: 2 })).toEqual([tasks[0]?.id, tasks[2]?.id]);
  });

  it("渡した順番待ちを書き換えない", () => {
    const queued = [task("dev"), task("dev", { priority: 0 })];
    const copy = [...queued];
    pick(queued);
    expect(queued).toEqual(copy);
  });

  it("上限が 1 以上の整数でなければ例外（設定の検証をすり抜けた値で動かない）", () => {
    for (const max of [0, -1, 1.5, Number.NaN]) {
      expect(() => pick([task("dev")], [], { max })).toThrow(RangeError);
    }
  });

  describe("5.5.4 の4：利用枠で止まっているあいだは、どのタスクも始めない", () => {
    const rejected = (resetsAt: string | null): UsageGate => ({ status: "rejected", resetsAt });

    it("再開予定時刻の前は始めない（CEO も同じアカウントなので始めない）", () => {
      const usage = rejected("2026-11-28T10:00:00.000Z");
      expect(pick([task("dev"), task("ceo", { kind: "none" })], [], { usage })).toEqual([]);
    });

    it("5.4.6 の2：再開予定時刻 + 60秒までは始めない", () => {
      const usage = rejected("2026-11-28T08:59:30.000Z");
      expect(pick([task("dev")], [], { usage })).toEqual([]);
      expect(isUsageBlocked(usage, new Date("2026-11-28T09:00:29.999Z"))).toBe(true);
      expect(isUsageBlocked(usage, new Date("2026-11-28T09:00:30.000Z"))).toBe(false);
    });

    it("再開予定時刻 + 60秒を過ぎたら始める", () => {
      const t = task("dev");
      const usage = rejected("2026-11-28T08:58:00.000Z");
      expect(pick([t], [], { usage })).toEqual([t.id]);
    });

    it.each([
      ["再開予定時刻が分からない", null],
      ["再開予定時刻が読めない", "そのうち"],
    ])("%sときは始めない（拒否側に倒す）", (_label, resetsAt) => {
      expect(pick([task("dev")], [], { usage: rejected(resetsAt) })).toEqual([]);
    });

    it.each(["allowed", "allowed_warning"] as const)("状態が %s なら止めない", (status) => {
      const t = task("dev");
      expect(pick([t], [], { usage: { status, resetsAt: null } })).toEqual([t.id]);
    });
  });
});
