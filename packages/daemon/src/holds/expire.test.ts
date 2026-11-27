import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAuditLog } from "../db/audit.ts";
import { createGrant, getGrant, transitionGrant } from "../db/grants.ts";
import { getHold, transitionHold } from "../db/holds.ts";
import { createTask, getTask, listTasks } from "../db/tasks.ts";
import { P2_FILES } from "../testing/company-config.ts";
import { createHoldTestEnv, type HoldTestEnv } from "../testing/holds.ts";
import { expireDue } from "./expire.ts";

const HOUR = 3600_000;
let t: HoldTestEnv;
beforeEach(() => {
  t = createHoldTestEnv();
});
afterEach(() => t.cleanup());

describe("5.2.6 の5・5.7.1 の6：保留の期限（holds.ttl_hours）", () => {
  it("決まらないまま期限を過ぎた保留は expired（却下と同じ扱い、決めたのは system）。期限の前は変えない", () => {
    const hold = t.hold();
    t.clock.advance(72 * HOUR - 1);
    expect(expireDue(t.deps).holds).toEqual([]);
    t.clock.advance(1);
    expect(expireDue(t.deps).holds).toEqual([hold.id]);
    expect(getHold(t.db, hold.id)).toMatchObject({
      status: "expired",
      decidedBy: "system",
      resolvedAt: "2026-12-01T00:00:00.000Z",
    });
    const audit = listAuditLog(t.db).at(-1);
    expect(audit?.kind).toBe("hold.state");
    expect(JSON.parse(audit?.data ?? "null")).toEqual({
      from: "pending_manager",
      to: "expired",
      by: "system",
    });
  });

  it("期限切れも結果：on_hold_resolved のタスクを作り、まだ始まっていないレビューのタスクは取り消す", () => {
    t.reload({
      ...P2_FILES,
      triggers: [{ id: "r", type: "on_hold_resolved", member: "sales-mailer" }],
    });
    const hold = t.hold();
    const review = createTask(t.db, {
      memberId: "mgr-sales",
      groupId: "executives",
      triggerKind: "review",
      purpose: "レビュー",
      doneWhen: "決めた",
      reviewSubject: hold.id,
      timeoutMinutes: 45,
    });
    t.clock.advance(72 * HOUR);
    expireDue(t.deps);
    expect(getTask(t.db, review.id)?.status).toBe("cancelled");
    expect(listTasks(t.db).filter((x) => x.triggerKind === "on_hold_resolved")).toHaveLength(1);
    expect(t.kicks).toBe(1);
  });

  it("オーナーの承認待ち（pending_owner）も期限で expired。決まったもの（approved・rejected）は変えない", () => {
    const owner = t.hold({ status: "pending_owner" });
    const decided = (to: "approved" | "rejected") => {
      const h = t.hold({ status: "pending_owner" });
      transitionHold(t.db, h.id, { from: ["pending_owner"], to, by: "system", actor: "system" });
      return h.id;
    };
    const approved = decided("approved");
    const rejected = decided("rejected");
    t.clock.advance(100 * HOUR);
    expect(expireDue(t.deps).holds).toEqual([owner.id]);
    expect(getHold(t.db, approved)?.status).toBe("approved");
    expect(getHold(t.db, rejected)?.status).toBe("rejected");
    expect(expireDue(t.deps)).toEqual({ holds: [], grants: [] });
  });
});

describe("5.7.3 の3：一時権限の期限", () => {
  const grant = () =>
    createGrant(t.db, {
      memberId: "dev-implementer",
      service: "github",
      operation: "git.push",
      params: { repo: ["myorg/new"] },
      mode: "allow",
      reason: "r",
      durationHours: 24,
      status: "pending_owner",
    });

  it("active で expires_at を過ぎたら expired", () => {
    const g = grant();
    transitionGrant(t.db, g.id, {
      from: ["pending_owner"],
      to: "active",
      by: "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
      actor: "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
      decide: true,
      startsAt: "2026-11-28T00:00:00.000Z",
      expiresAt: "2026-11-29T00:00:00.000Z",
    });
    t.clock.advance(24 * HOUR - 1);
    expect(expireDue(t.deps).grants).toEqual([]);
    t.clock.advance(1);
    expect(expireDue(t.deps).grants).toEqual([g.id]);
    expect(getGrant(t.db, g.id)?.status).toBe("expired");
  });

  it("申請のまま holds.ttl_hours を過ぎたら expired（決まらない申請を残さない）", () => {
    const g = grant();
    t.clock.advance(72 * HOUR);
    expect(expireDue(t.deps).grants).toEqual([g.id]);
    expect(getGrant(t.db, g.id)).toMatchObject({ status: "expired", decidedBy: "system" });
  });
});
