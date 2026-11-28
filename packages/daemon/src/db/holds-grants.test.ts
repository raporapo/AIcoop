import { newId } from "@aicoop/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type FakeClock, memoryDb } from "../testing/state-db.ts";
import { listAuditLog, verifyAuditLog } from "./audit.ts";
import {
  activeGrantsFor,
  createGrant,
  GrantStateError,
  getGrant,
  listGrants,
  transitionGrant,
} from "./grants.ts";
import {
  claimHoldReplay,
  createHold,
  getHold,
  HoldStateError,
  listHolds,
  transitionHold,
} from "./holds.ts";
import type { StateDb } from "./open.ts";
import { grants } from "./schema.ts";

let db: StateDb;
let clock: FakeClock;
beforeEach(() => {
  ({ db, clock } = memoryDb());
});

function insertGrant(over: Partial<typeof grants.$inferInsert> = {}): string {
  const id = newId("grant");
  db.orm
    .insert(grants)
    .values({
      id,
      memberId: "dev-implementer",
      service: "github",
      operation: "issue.comment",
      params: JSON.stringify({ repo: ["myorg/app"] }),
      mode: "allow",
      reason: "Issue に返事をする",
      durationHours: 24,
      status: "active",
      createdAt: "2026-11-27T00:00:00.000Z",
      startsAt: "2026-11-27T00:00:00.000Z",
      expiresAt: "2026-11-29T00:00:00.000Z",
      decidedBy: "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
      managerComment: null,
      ...over,
    })
    .run();
  return id;
}

describe("5.2.4 の2：一時権限は grants 表の active を読む", () => {
  it("その社員の active の一時権限を、判定に使う形で返す", () => {
    const id = insertGrant();
    expect(activeGrantsFor(db, "dev-implementer")).toEqual([
      {
        id,
        op: "github.issue.comment",
        params: { repo: ["myorg/app"] },
        mode: "allow",
        status: "active",
        startsAt: "2026-11-27T00:00:00.000Z",
        expiresAt: "2026-11-29T00:00:00.000Z",
      },
    ]);
  });

  it("ほかの社員のもの・active でないもの（申請中・却下・期限切れ）は返さない", () => {
    insertGrant({ memberId: "dev-reviewer" });
    insertGrant({ status: "pending_owner" });
    insertGrant({ status: "rejected" });
    insertGrant({ status: "expired" });
    expect(activeGrantsFor(db, "dev-implementer")).toEqual([]);
  });

  it("params が読めない一時権限は使わない（拒否側に倒す）", () => {
    insertGrant({ params: "not json" });
    insertGrant({ params: JSON.stringify({ repo: "myorg/app" }) });
    insertGrant({ params: JSON.stringify([1]) });
    insertGrant({ mode: "weird" as "allow" });
    expect(activeGrantsFor(db, "dev-implementer")).toEqual([]);
  });
});

describe("5.2.6 の1：保留の記録", () => {
  it("保留を作り、同じトランザクションで監査ログ hold.state を書く", () => {
    const id = newId("hold");
    const hold = createHold(db, {
      id,
      runId: newId("run"),
      taskId: newId("task"),
      memberId: "sales-mailer",
      groupId: "sales",
      thread: "task-1",
      service: "gmail",
      operation: "message.send",
      params: {},
      requestPath: "/tmp/h.bin",
      requestBytes: 123,
      summary: { kind: "gmail_message" },
      status: "pending_manager",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    expect(hold.status).toBe("pending_manager");
    expect(getHold(db, id)).toEqual(hold);
    expect(hold.createdAt).toBe("2026-11-28T00:00:00.000Z");
    const rows = listAuditLog(db).filter((r) => r.kind === "hold.state");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe("member:sales-mailer");
    expect(JSON.parse(rows[0]?.data ?? "null")).toEqual({
      from: null,
      to: "pending_manager",
      by: "system",
    });
    expect(verifyAuditLog(db).ok).toBe(true);
  });

  it("保留の ID でない値は受け付けない", () => {
    expect(() =>
      createHold(db, {
        id: "h_bad",
        runId: newId("run"),
        taskId: newId("task"),
        memberId: "m",
        groupId: "g",
        thread: "t",
        service: "gmail",
        operation: "message.send",
        params: {},
        requestPath: "/x",
        requestBytes: 0,
        summary: {},
        status: "pending_owner",
        expiresAt: "2026-12-01T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

function newHold(over: Partial<Parameters<typeof createHold>[1]> = {}) {
  return createHold(db, {
    id: newId("hold"),
    runId: newId("run"),
    taskId: newId("task"),
    memberId: "sales-mailer",
    groupId: "sales",
    thread: "task-1",
    service: "gmail",
    operation: "message.send",
    params: {},
    requestPath: "/tmp/h.bin",
    requestBytes: 1,
    summary: { kind: "default" },
    status: "pending_manager",
    expiresAt: "2026-12-01T00:00:00.000Z",
    ...over,
  });
}

const OWNER = "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB" as const;

describe("5.7.1：保留の状態の変化", () => {
  it("from にある状態のときだけ変え、監査ログ hold.state（変化前・変化後・決めた者）を書く", () => {
    const hold = newHold();
    const passed = transitionHold(db, hold.id, {
      from: ["pending_manager"],
      to: "pending_owner",
      by: "manager:mgr-sales",
      actor: "member:mgr-sales",
      managerComment: "宛先と本文に問題なし",
    });
    expect(passed).toMatchObject({
      status: "pending_owner",
      managerComment: "宛先と本文に問題なし",
      decidedAt: null,
      decidedBy: null,
      resolvedAt: null,
    });
    const rows = listAuditLog(db).filter((r) => r.kind === "hold.state");
    expect(rows.at(-1)?.actor).toBe("member:mgr-sales");
    expect(JSON.parse(rows.at(-1)?.data ?? "null")).toEqual({
      from: "pending_manager",
      to: "pending_owner",
      by: "manager:mgr-sales",
    });
  });

  it("結果の状態（rejected など）になったら decided_at・decided_by・resolved_at を書く", () => {
    const hold = newHold();
    const rejected = transitionHold(db, hold.id, {
      from: ["pending_manager"],
      to: "rejected",
      by: "manager:mgr-sales",
      actor: "member:mgr-sales",
      decide: true,
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      decidedAt: "2026-11-28T00:00:00.000Z",
      decidedBy: "manager:mgr-sales",
      resolvedAt: "2026-11-28T00:00:00.000Z",
    });
  });

  it("拒否：いまの状態が from になければ HoldStateError で、状態も監査ログも変えない", () => {
    const hold = newHold();
    const before = listAuditLog(db).length;
    expect(() =>
      transitionHold(db, hold.id, {
        from: ["pending_owner"],
        to: "approved",
        by: OWNER,
        actor: OWNER,
        decide: true,
      }),
    ).toThrow(HoldStateError);
    expect(getHold(db, hold.id)?.status).toBe("pending_manager");
    expect(listAuditLog(db)).toHaveLength(before);
    expect(() =>
      transitionHold(db, newId("hold"), {
        from: ["pending_manager"],
        to: "rejected",
        by: "system",
        actor: "system",
      }),
    ).toThrow(HoldStateError);
  });

  it("5.2.6 の2：再送の印は approved で、まだ送り始めていないときに1回だけ付けられる（二重に送らない）", () => {
    const hold = newHold({ status: "pending_owner" });
    expect(claimHoldReplay(db, hold.id, "/tmp/r.bin")).toBe(false);
    transitionHold(db, hold.id, {
      from: ["pending_owner"],
      to: "approved",
      by: OWNER,
      actor: OWNER,
      decide: true,
    });
    expect(claimHoldReplay(db, hold.id, "/tmp/r.bin")).toBe(true);
    expect(claimHoldReplay(db, hold.id, "/tmp/r.bin")).toBe(false);
    expect(getHold(db, hold.id)?.responsePath).toBe("/tmp/r.bin");
  });

  it("一覧は新しい順。状態と社員で絞れる", () => {
    const a = newHold();
    clock.advance(1000);
    const b = newHold({ memberId: "dev-implementer", status: "pending_owner" });
    expect(listHolds(db).map((h) => h.id)).toEqual([b.id, a.id]);
    expect(listHolds(db, { statuses: ["pending_owner"] }).map((h) => h.id)).toEqual([b.id]);
    expect(listHolds(db, { memberId: "sales-mailer" }).map((h) => h.id)).toEqual([a.id]);
    expect(listHolds(db, { statuses: [] })).toEqual([]);
  });
});

describe("5.7.3：一時権限の申請と状態の変化", () => {
  const input = {
    memberId: "dev-implementer",
    service: "github",
    operation: "git.push",
    params: { repo: ["myorg/new"] },
    mode: "allow" as const,
    reason: "新しいリポジトリに push する",
    durationHours: 24,
    status: "pending_manager" as const,
  };

  it("申請を作り、監査ログ grant.state（null → pending_manager）を書く。active にしたときだけ判定に入る", () => {
    const grant = createGrant(db, input);
    expect(grant).toMatchObject({
      status: "pending_manager",
      startsAt: null,
      expiresAt: null,
      managerComment: null,
      createdAt: "2026-11-28T00:00:00.000Z",
    });
    expect(getGrant(db, grant.id)).toEqual(grant);
    expect(activeGrantsFor(db, "dev-implementer")).toEqual([]);

    transitionGrant(db, grant.id, {
      from: ["pending_manager"],
      to: "pending_owner",
      by: "manager:mgr-dev",
      actor: "member:mgr-dev",
      managerComment: "必要",
    });
    const active = transitionGrant(db, grant.id, {
      from: ["pending_owner"],
      to: "active",
      by: OWNER,
      actor: OWNER,
      decide: true,
      startsAt: "2026-11-28T00:00:00.000Z",
      expiresAt: "2026-11-29T00:00:00.000Z",
    });
    expect(active).toMatchObject({ status: "active", managerComment: "必要", decidedBy: OWNER });
    expect(activeGrantsFor(db, "dev-implementer").map((g) => g.op)).toEqual(["github.git.push"]);
    expect(
      listAuditLog(db)
        .filter((r) => r.kind === "grant.state")
        .map((r) => JSON.parse(r.data).to),
    ).toEqual(["pending_manager", "pending_owner", "active"]);
    expect(verifyAuditLog(db).ok).toBe(true);
  });

  it("拒否：from にない状態からは変えない。active にするのに期限がなければ TypeError", () => {
    const grant = createGrant(db, input);
    expect(() =>
      transitionGrant(db, grant.id, {
        from: ["pending_owner"],
        to: "active",
        by: OWNER,
        actor: OWNER,
        startsAt: "2026-11-28T00:00:00.000Z",
        expiresAt: "2026-11-29T00:00:00.000Z",
      }),
    ).toThrow(GrantStateError);
    expect(() =>
      transitionGrant(db, grant.id, {
        from: ["pending_manager"],
        to: "active",
        by: "system",
        actor: "system",
      }),
    ).toThrow(TypeError);
    expect(getGrant(db, grant.id)?.status).toBe("pending_manager");
    expect(getGrant(db, "h_01JD6V8X3S0Q5W7KQ9M2T4R6YB")).toBeUndefined();
  });

  it("一覧は新しい順で、状態と社員で絞れる", () => {
    const a = createGrant(db, input);
    clock.advance(1000);
    const b = createGrant(db, { ...input, memberId: "dev-reviewer", status: "pending_owner" });
    expect(listGrants(db).map((g) => g.id)).toEqual([b.id, a.id]);
    expect(listGrants(db, { statuses: ["pending_manager"] }).map((g) => g.id)).toEqual([a.id]);
    expect(listGrants(db, { memberId: "dev-reviewer" }).map((g) => g.id)).toEqual([b.id]);
  });
});
