import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAuditLog } from "../db/audit.ts";
import { createGrant, getGrant } from "../db/grants.ts";
import { getHold } from "../db/holds.ts";
import { listTasks } from "../db/tasks.ts";
import { P2_FILES } from "../testing/company-config.ts";
import { createHoldTestEnv, type HoldTestEnv } from "../testing/holds.ts";
import { reviewDecision } from "./review.ts";

let t: HoldTestEnv;
beforeEach(() => {
  t = createHoldTestEnv();
});
afterEach(() => t.cleanup());

const decide = (
  managerId: string,
  itemId: string,
  decision: "pass" | "reject" = "pass",
  comment = "問題ありません",
) => reviewDecision(t.deps, { managerId, itemId, decision, comment });

const withTrigger = () =>
  t.reload({
    ...P2_FILES,
    triggers: [{ id: "mailer-hold-result", type: "on_hold_resolved", member: "sales-mailer" }],
  });

describe("5.7.1 の3・5.3.3：部長の review_decision（保留）", () => {
  it("pass は pending_owner（承認ではない）。部長のコメントを manager_comment に残し、監査ログに部長を書く", () => {
    const hold = t.hold();
    expect(decide("mgr-sales", hold.id, "pass", "宛先と本文を確かめました")).toEqual({
      ok: true,
      itemId: hold.id,
      status: "pending_owner",
    });
    expect(getHold(t.db, hold.id)).toMatchObject({
      status: "pending_owner",
      managerComment: "宛先と本文を確かめました",
      decidedBy: null,
    });
    const last = listAuditLog(t.db).at(-1);
    expect(last?.actor).toBe("member:mgr-sales");
    expect(JSON.parse(last?.data ?? "null")).toEqual({
      from: "pending_manager",
      to: "pending_owner",
      by: "manager:mgr-sales",
    });
  });

  it("reject は rejected で終わる（decided_by は部長）。結果なので on_hold_resolved のタスクを作る", () => {
    withTrigger();
    const hold = t.hold();
    expect(decide("mgr-sales", hold.id, "reject", "宛先が違う")).toMatchObject({
      ok: true,
      status: "rejected",
    });
    expect(getHold(t.db, hold.id)).toMatchObject({
      status: "rejected",
      decidedBy: "manager:mgr-sales",
      managerComment: "宛先が違う",
      resolvedAt: "2026-11-28T00:00:00.000Z",
    });
    const tasks = listTasks(t.db).filter((x) => x.triggerKind === "on_hold_resolved");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      memberId: "sales-mailer",
      triggerId: "mailer-hold-result",
      holdId: hold.id,
      thread: "mail-thread",
      priority: 2,
      purpose: `保留 ${hold.id} の結果が出た。結果を確かめて作業を続ける`,
    });
    expect(t.kicks).toBe(1);
  });

  it("拒否：担当でない部署の項目は決められない（not_allowed）。状態も変えない", () => {
    const hold = t.hold();
    const result = decide("mgr-dev", hold.id);
    expect(result).toMatchObject({ ok: false, code: "not_allowed" });
    expect(getHold(t.db, hold.id)?.status).toBe("pending_manager");
  });

  it("拒否：部長でない者は決められない", () => {
    const hold = t.hold();
    expect(decide("sales-mailer", hold.id)).toMatchObject({ ok: false, code: "not_allowed" });
    expect(decide("dev-implementer", hold.id)).toMatchObject({ ok: false, code: "not_allowed" });
    expect(decide("no-such-member", hold.id)).toMatchObject({ ok: false, code: "not_allowed" });
    expect(getHold(t.db, hold.id)?.status).toBe("pending_manager");
  });

  it("拒否：部長のレビューを待っていない項目（pending_owner・決まったもの）は決められない。二度は決められない", () => {
    const hold = t.hold();
    expect(decide("mgr-sales", hold.id).ok).toBe(true);
    expect(decide("mgr-sales", hold.id, "reject")).toMatchObject({
      ok: false,
      code: "not_allowed",
    });
    expect(getHold(t.db, hold.id)?.status).toBe("pending_owner");
    const owner = t.hold({ status: "pending_owner" });
    expect(decide("mgr-sales", owner.id)).toMatchObject({ ok: false, code: "not_allowed" });
  });

  it("拒否：期限を過ぎた保留は決められず、その場で expired にする", () => {
    const hold = t.hold();
    t.clock.advance(72 * 3600_000);
    expect(decide("mgr-sales", hold.id)).toMatchObject({ ok: false, code: "not_allowed" });
    expect(getHold(t.db, hold.id)).toMatchObject({ status: "expired", decidedBy: "system" });
  });

  it("拒否：無い項目・依頼票（P4）・ID でない値", () => {
    expect(decide("mgr-sales", "h_01JD6V8X3S0Q5W7KQ9M2T4R6YB")).toMatchObject({
      ok: false,
      code: "not_allowed",
    });
    expect(decide("mgr-sales", "k_01JD6V8X3S0Q5W7KQ9M2T4R6YB")).toMatchObject({
      ok: false,
      code: "not_allowed",
    });
    expect(decide("mgr-sales", "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB")).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });
});

describe("5.7.3 の2：部長の review_decision（一時権限の申請）", () => {
  const request = (memberId = "dev-implementer") =>
    createGrant(t.db, {
      memberId,
      service: "github",
      operation: "git.push",
      params: { repo: ["myorg/new"] },
      mode: "allow",
      reason: "新しいリポジトリ",
      durationHours: 24,
      status: "pending_manager",
    });

  it("担当の部長の pass で pending_owner、reject で rejected", () => {
    const a = request();
    expect(decide("mgr-dev", a.id, "pass", "必要")).toMatchObject({
      ok: true,
      status: "pending_owner",
    });
    expect(getGrant(t.db, a.id)).toMatchObject({ status: "pending_owner", managerComment: "必要" });
    const b = request();
    expect(decide("mgr-dev", b.id, "reject", "広すぎる")).toMatchObject({
      ok: true,
      status: "rejected",
    });
    expect(getGrant(t.db, b.id)).toMatchObject({
      status: "rejected",
      decidedBy: "manager:mgr-dev",
    });
  });

  it("拒否：ほかの部署の部長は決められない", () => {
    const a = request();
    expect(decide("mgr-sales", a.id)).toMatchObject({ ok: false, code: "not_allowed" });
    expect(getGrant(t.db, a.id)?.status).toBe("pending_manager");
  });

  it("拒否：申請から holds.ttl_hours を過ぎた申請は決められず、expired にする", () => {
    const a = request();
    t.clock.advance(72 * 3600_000);
    expect(decide("mgr-dev", a.id)).toMatchObject({ ok: false, code: "not_allowed" });
    expect(getGrant(t.db, a.id)?.status).toBe("expired");
  });
});
