import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeClock, memoryDb } from "../testing/state-db.ts";
import type { StateDb } from "./open.ts";
import { getSession, saveSession, touchSession } from "./sessions.ts";
import { getUsageState, setUsageState, usageGate } from "./usage.ts";

describe("7.2：セッション（sessions。5.4.5）", () => {
  let db: StateDb;
  let clock: FakeClock;
  beforeEach(() => {
    ({ db, clock } = memoryDb());
  });
  afterEach(() => db.close());

  it("（社員, スレッド）ごとに1つ。なければ undefined", () => {
    expect(getSession(db, "dev-implementer", "issue-42")).toBeUndefined();
    const saved = saveSession(db, {
      memberId: "dev-implementer",
      thread: "issue-42",
      sessionId: "s-1",
    });
    expect(saved).toEqual({
      memberId: "dev-implementer",
      thread: "issue-42",
      sessionId: "s-1",
      createdAt: "2026-11-28T00:00:00.000Z",
      lastUsedAt: "2026-11-28T00:00:00.000Z",
    });
    expect(getSession(db, "dev-implementer", "issue-42")).toEqual(saved);
    expect(getSession(db, "dev-implementer", "issue-43")).toBeUndefined();
    expect(getSession(db, "dev-reviewer", "issue-42")).toBeUndefined();
  });

  it("同じセッションをもう一度書くと、最後に使った時刻だけが変わる", () => {
    saveSession(db, { memberId: "dev-implementer", thread: "issue-42", sessionId: "s-1" });
    clock.advance(60_000);
    expect(
      saveSession(db, { memberId: "dev-implementer", thread: "issue-42", sessionId: "s-1" }),
    ).toMatchObject({
      createdAt: "2026-11-28T00:00:00.000Z",
      lastUsedAt: "2026-11-28T00:01:00.000Z",
    });
  });

  it("5.4.5 の5：新しいセッションに替えたら、作った時刻も新しくする", () => {
    saveSession(db, { memberId: "dev-implementer", thread: "issue-42", sessionId: "s-1" });
    clock.advance(31 * 24 * 60 * 60 * 1000);
    expect(
      saveSession(db, { memberId: "dev-implementer", thread: "issue-42", sessionId: "s-2" }),
    ).toMatchObject({
      sessionId: "s-2",
      createdAt: "2026-12-29T00:00:00.000Z",
      lastUsedAt: "2026-12-29T00:00:00.000Z",
    });
  });

  it("使った時刻だけを進める", () => {
    saveSession(db, { memberId: "dev-implementer", thread: "t", sessionId: "s-1" });
    clock.advance(1000);
    expect(touchSession(db, "dev-implementer", "t")).toBe(true);
    expect(getSession(db, "dev-implementer", "t")?.lastUsedAt).toBe("2026-11-28T00:00:01.000Z");
    expect(touchSession(db, "dev-implementer", "none")).toBe(false);
  });

  it.each([
    ["社員IDの形が違う", { memberId: "A B", thread: "t", sessionId: "s" }],
    ["スレッドが空", { memberId: "a", thread: "", sessionId: "s" }],
    ["スレッドに改行", { memberId: "a", thread: "x\ny", sessionId: "s" }],
    ["セッション ID が空", { memberId: "a", thread: "t", sessionId: "" }],
    ["セッション ID に改行", { memberId: "a", thread: "t", sessionId: "s\n--resume x" }],
  ])("形の違う値は書かない（%s）", (_label, input) => {
    expect(() => saveSession(db, input)).toThrow(TypeError);
  });
});

describe("7.2：利用枠（usage_state。5.4.6）", () => {
  let db: StateDb;
  let clock: FakeClock;
  beforeEach(() => {
    ({ db, clock } = memoryDb());
  });
  afterEach(() => db.close());

  it("まだ記録がなければ undefined（止まっていない）", () => {
    expect(getUsageState(db)).toBeUndefined();
    expect(usageGate(undefined)).toBeNull();
  });

  it("最新の状態を、アカウント owner の1行に書く", () => {
    setUsageState(db, { status: "allowed_warning", utilization: 0.8 });
    clock.advance(1000);
    const state = setUsageState(db, {
      status: "rejected",
      resetsAt: "2026-11-28T05:00:00.000Z",
      rateLimitType: "five_hour",
    });
    expect(state).toEqual({
      accountId: "owner",
      status: "rejected",
      resetsAt: "2026-11-28T05:00:00.000Z",
      rateLimitType: "five_hour",
      utilization: null,
      updatedAt: "2026-11-28T00:00:01.000Z",
    });
    expect(getUsageState(db)).toEqual(state);
    expect(db.sqlite.prepare("SELECT COUNT(*) AS n FROM usage_state").get()).toEqual({ n: 1 });
    expect(usageGate(state)).toEqual({ status: "rejected", resetsAt: "2026-11-28T05:00:00.000Z" });
  });

  it.each([
    ["知らない状態", { status: "paused" }],
    ["使用率が1を超える", { status: "allowed", utilization: 1.2 }],
    ["使用率がマイナス", { status: "allowed", utilization: -0.1 }],
    ["使用率が数でない", { status: "allowed", utilization: Number.NaN }],
    ["再開予定時刻が読めない", { status: "rejected", resetsAt: "5時" }],
  ])("形の違う値は書かない（%s）", (_label, input) => {
    expect(() => setUsageState(db, input as never)).toThrow(TypeError);
    expect(getUsageState(db)).toBeUndefined();
  });
});
