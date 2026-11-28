import { readFileSync } from "node:fs";
import { canonicalJson } from "@aicoop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAuditLog } from "../db/audit.ts";
import { activeGrantsFor, createGrant, getGrant } from "../db/grants.ts";
import { getHold, transitionHold } from "../db/holds.ts";
import { listTasks } from "../db/tasks.ts";
import { P2_FILES } from "../testing/company-config.ts";
import { createHoldTestEnv, type HoldTestEnv } from "../testing/holds.ts";
import { createHoldTargets, NotAwaitingOwnerError } from "./targets.ts";

const OWNER = "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB" as const;

let t: HoldTestEnv;
beforeEach(() => {
  t = createHoldTestEnv();
});
afterEach(() => t.cleanup());

const targets = () => {
  const all = createHoldTargets(t.deps);
  if (all.hold === undefined || all.grant === undefined) throw new Error("対象がない");
  return { hold: all.hold, grant: all.grant };
};

function passToOwner(id: string, comment = "問題なし") {
  transitionHold(t.db, id, {
    from: ["pending_manager"],
    to: "pending_owner",
    by: "manager:mgr-sales",
    actor: "member:mgr-sales",
    managerComment: comment,
  });
}

describe("承認の対象 hold（ApprovalTarget）", () => {
  it("describe：要約に部長のコメントを添えたものと、pending_owner かどうか", () => {
    const hold = t.hold();
    const { hold: target } = targets();
    expect(target.describe(hold.id)).toEqual({
      type: "hold",
      id: hold.id,
      status: "pending_manager",
      awaitingOwner: false,
      summary: {
        kind: "default",
        operation: "gmail.message.send",
        member_id: "sales-mailer",
        manager_comment: null,
      },
    });
    passToOwner(hold.id, "宛先を確かめた");
    expect(target.describe(hold.id)).toMatchObject({
      status: "pending_owner",
      awaitingOwner: true,
      summary: { manager_comment: "宛先を確かめた" },
    });
    expect(target.describe("h_01JD6V8X3S0Q5W7KQ9M2T4R6YB")).toBeUndefined();
  });

  it("approve は approved（decided_by はオーナーの端末）。afterApply で1回だけ再送し、replayed にする", async () => {
    const hold = t.hold();
    passToOwner(hold.id);
    const { hold: target } = targets();
    expect(target.apply(hold.id, "approve", OWNER)).toEqual({ status: "approved" });
    expect(getHold(t.db, hold.id)).toMatchObject({ status: "approved", decidedBy: OWNER });
    expect(listAuditLog(t.db).at(-1)?.actor).toBe(OWNER);

    await target.afterApply?.(hold.id, "approve");
    expect(getHold(t.db, hold.id)).toMatchObject({ status: "replayed", responseStatus: 200 });
    expect(t.services.sent()).toHaveLength(1);
    // 二度目の afterApply でも送らない
    await target.afterApply?.(hold.id, "approve");
    expect(t.services.sent()).toHaveLength(1);
  });

  it("reject は rejected。結果なので on_hold_resolved のタスクを作り、送らない", async () => {
    t.reload({
      ...P2_FILES,
      triggers: [{ id: "r", type: "on_hold_resolved", member: "sales-mailer" }],
    });
    const hold = t.hold();
    passToOwner(hold.id);
    const { hold: target } = targets();
    expect(target.apply(hold.id, "reject", OWNER)).toEqual({ status: "rejected" });
    await target.afterApply?.(hold.id, "reject");
    expect(getHold(t.db, hold.id)).toMatchObject({ status: "rejected", decidedBy: OWNER });
    expect(listTasks(t.db).filter((x) => x.triggerKind === "on_hold_resolved")).toHaveLength(1);
    expect(t.services.calls).toEqual([]);
  });

  it("拒否：pending_owner でない（部長のレビュー前・決まったもの）・期限切れ・無い保留は apply できない", () => {
    const { hold: target } = targets();
    const beforeManager = t.hold();
    expect(() => target.apply(beforeManager.id, "approve", OWNER)).toThrow(NotAwaitingOwnerError);
    expect(getHold(t.db, beforeManager.id)?.status).toBe("pending_manager");

    const decided = t.hold();
    passToOwner(decided.id);
    target.apply(decided.id, "reject", OWNER);
    expect(() => target.apply(decided.id, "approve", OWNER)).toThrow(NotAwaitingOwnerError);
    expect(getHold(t.db, decided.id)?.status).toBe("rejected");

    const late = t.hold();
    passToOwner(late.id);
    t.clock.advance(72 * 3600_000);
    expect(target.describe(late.id)?.awaitingOwner).toBe(false);
    expect(() => target.apply(late.id, "approve", OWNER)).toThrow(NotAwaitingOwnerError);
    expect(getHold(t.db, late.id)?.status).toBe("pending_owner");

    expect(() => target.apply("h_01JD6V8X3S0Q5W7KQ9M2T4R6YB", "approve", OWNER)).toThrow(
      NotAwaitingOwnerError,
    );
  });

  it("要約は API の HoldView.summary と同じ（summary_sha256 のもとが一致する）", async () => {
    const { toHoldView } = await import("./views.ts");
    const hold = t.hold();
    passToOwner(hold.id);
    const described = targets().hold.describe(hold.id);
    expect(canonicalJson(described?.summary)).toBe(
      canonicalJson(
        toHoldView(getHold(t.db, hold.id) as NonNullable<ReturnType<typeof getHold>>).summary,
      ),
    );
  });
});

describe("承認の対象 grant（ApprovalTarget）と、5.7.3 の受け入れ条件 S-4", () => {
  const grant = (status: "pending_manager" | "pending_owner" = "pending_owner") =>
    createGrant(t.db, {
      memberId: "dev-implementer",
      service: "github",
      operation: "git.push",
      params: { repo: ["myorg/new"] },
      mode: "allow",
      reason: "新しいリポジトリ",
      durationHours: 24,
      status,
    });

  it("describe：誰が・何の操作を・どのパラメーターで・何時間・理由と、部長のコメント", () => {
    const g = grant();
    expect(targets().grant.describe(g.id)).toEqual({
      type: "grant",
      id: g.id,
      status: "pending_owner",
      awaitingOwner: true,
      summary: {
        kind: "grant",
        member_id: "dev-implementer",
        operation: "github.git.push",
        params: { repo: ["myorg/new"] },
        mode: "allow",
        duration_hours: 24,
        reason: "新しいリポジトリ",
        manager_comment: null,
      },
    });
  });

  it("approve で active（starts_at = 承認の時刻、expires_at = それ + duration_hours）。判定に入る", () => {
    const g = grant();
    t.clock.advance(3600_000);
    expect(targets().grant.apply(g.id, "approve", OWNER)).toEqual({ status: "active" });
    expect(getGrant(t.db, g.id)).toMatchObject({
      status: "active",
      startsAt: "2026-11-28T01:00:00.000Z",
      expiresAt: "2026-11-29T01:00:00.000Z",
      decidedBy: OWNER,
    });
    expect(activeGrantsFor(t.db, "dev-implementer")).toHaveLength(1);
  });

  it("reject で rejected。判定には入らない", () => {
    const g = grant();
    expect(targets().grant.apply(g.id, "reject", OWNER)).toEqual({ status: "rejected" });
    expect(activeGrantsFor(t.db, "dev-implementer")).toEqual([]);
  });

  it("拒否：部長のレビュー前・決まったもの・申請の期限を過ぎたものは apply できない", () => {
    const { grant: target } = targets();
    const early = grant("pending_manager");
    expect(() => target.apply(early.id, "approve", OWNER)).toThrow(NotAwaitingOwnerError);
    const g = grant();
    target.apply(g.id, "approve", OWNER);
    expect(() => target.apply(g.id, "approve", OWNER)).toThrow(NotAwaitingOwnerError);
    const late = grant();
    t.clock.advance(72 * 3600_000);
    expect(() => target.apply(late.id, "approve", OWNER)).toThrow(NotAwaitingOwnerError);
    expect(getGrant(t.db, late.id)?.status).toBe("pending_owner");
  });

  it("再送の結果の本文の先頭を response.bin に残す", async () => {
    const hold = t.hold();
    passToOwner(hold.id);
    const { hold: target } = targets();
    target.apply(hold.id, "approve", OWNER);
    await target.afterApply?.(hold.id, "approve");
    expect(readFileSync(t.paths.holdResponseFile(hold.id), "utf8")).toBe(t.services.sendBody);
  });
});
