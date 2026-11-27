/**
 * 期限（5.2.6 の5、5.7.1 の6、5.7.3 の3）。
 *
 * - 保留：作られてから `holds.ttl_hours` までに決まらなければ `expired`（却下と同じ扱い）。
 *   結果なので、on_hold_resolved のタスクを作る
 * - 一時権限：`active` で `expires_at` を過ぎたら `expired`
 * - 一時権限の申請（pending_manager・pending_owner）：設計書に期限はないが、保留と同じく、申請から
 *   `holds.ttl_hours` までに決まらなければ `expired` にする（決まらない申請を、いつまでも承認できる形で残さない）
 * - 期限で決まらなくなった項目の、まだ始まっていないレビューのタスク（queued）は取り消す
 *
 * 決めるとき（部長の review_decision・オーナーの承認）にも、ここで期限を確かめる。
 * 定期の見直し（`expireDue`）が来る前でも、期限を過ぎたものは決められない。
 */
import type { CompanyConfig } from "@aicoop/shared";
import { GRANT_PENDING_STATUSES, type Grant, listGrants, transitionGrant } from "../db/grants.ts";
import { HOLD_PENDING_STATUSES, type Hold, listHolds, transitionHold } from "../db/holds.ts";
import { writeTransaction } from "../db/open.ts";
import { cancelTask, listTasks } from "../db/tasks.ts";
import type { HoldDeps } from "./deps.ts";
import { createOnHoldResolvedTask } from "./resolved.ts";

const HOUR_MS = 60 * 60 * 1000;

function cancelQueuedReviews(deps: Pick<HoldDeps, "db">, subjectId: string): void {
  for (const task of listTasks(deps.db, { status: "queued" })) {
    if (task.triggerKind === "review" && task.reviewSubject === subjectId) {
      cancelTask(deps.db, task.id, { actor: "system" });
    }
  }
}

/** 保留が決まらないまま期限を過ぎていれば expired にして true。そうでなければ何もせず false */
export function expireHoldIfDue(deps: HoldDeps, config: CompanyConfig, hold: Hold): boolean {
  if (!HOLD_PENDING_STATUSES.includes(hold.status)) return false;
  const expires = Date.parse(hold.expiresAt);
  // 読めない期限は、過ぎたものとみなす（拒否側）
  if (!Number.isNaN(expires) && deps.now().getTime() < expires) return false;
  writeTransaction(deps.db, () => {
    const after = transitionHold(deps.db, hold.id, {
      from: HOLD_PENDING_STATUSES,
      to: "expired",
      by: "system",
      actor: "system",
      decide: true,
    });
    cancelQueuedReviews(deps, hold.id);
    if (createOnHoldResolvedTask(deps, config, after) !== null) deps.onTaskCreated?.();
  });
  deps.logger?.info({ hold: hold.id }, "期限までに決まらなかった保留を expired にしました");
  return true;
}

/** 一時権限の申請の期限（申請から holds.ttl_hours） */
export function grantRequestExpiresAt(
  config: CompanyConfig,
  grant: Pick<Grant, "createdAt">,
): number {
  return Date.parse(grant.createdAt) + config.aicoop.holds.ttl_hours * HOUR_MS;
}

/** 申請が決まらないまま期限を過ぎた・active の期限が来たなら expired にして true */
export function expireGrantIfDue(deps: HoldDeps, config: CompanyConfig, grant: Grant): boolean {
  const now = deps.now().getTime();
  let due = false;
  if (GRANT_PENDING_STATUSES.includes(grant.status)) {
    const at = grantRequestExpiresAt(config, grant);
    due = Number.isNaN(at) || now >= at;
  } else if (grant.status === "active") {
    const at = grant.expiresAt === null ? Number.NaN : Date.parse(grant.expiresAt);
    due = Number.isNaN(at) || now >= at;
  }
  if (!due) return false;
  writeTransaction(deps.db, () => {
    transitionGrant(deps.db, grant.id, {
      from: [grant.status],
      to: "expired",
      by: "system",
      actor: "system",
      decide: grant.status !== "active",
    });
    cancelQueuedReviews(deps, grant.id);
  });
  deps.logger?.info(
    { grant: grant.id, from: grant.status },
    "期限が来た一時権限を expired にしました",
  );
  return true;
}

/** 期限を過ぎた保留・一時権限を、まとめて expired にする（daemon が定期的に呼ぶ） */
export function expireDue(deps: HoldDeps): { holds: string[]; grants: string[] } {
  const config = deps.config();
  const holds: string[] = [];
  const grants: string[] = [];
  for (const hold of listHolds(deps.db, { statuses: HOLD_PENDING_STATUSES, limit: 10_000 })) {
    try {
      if (expireHoldIfDue(deps, config, hold)) holds.push(hold.id);
    } catch (error) {
      deps.logger?.warn({ hold: hold.id, err: error }, "保留を expired にできませんでした");
    }
  }
  for (const grant of listGrants(deps.db, {
    statuses: [...GRANT_PENDING_STATUSES, "active"],
    limit: 10_000,
  })) {
    try {
      if (expireGrantIfDue(deps, config, grant)) grants.push(grant.id);
    } catch (error) {
      deps.logger?.warn({ grant: grant.id, err: error }, "一時権限を expired にできませんでした");
    }
  }
  return { holds, grants };
}
