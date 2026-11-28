/**
 * オーナーの承認の対象（`approvals/types.ts` の `ApprovalTarget`）：保留（hold）と一時権限（grant）。
 *
 * 署名を確かめる側（approvals/）が、署名が通ったら `apply` を呼ぶ（`approvals` の記録と同じトランザクション）。
 *
 * - `describe`：承認アプリに見せる要約（保留は 5.7.1 の2 の要約に部長のコメントを添えたもの、一時権限は
 *   「誰が・何の操作を・どのパラメーターで・何時間・理由」と部長のコメント）と、オーナーの承認を待っているか
 *   （`pending_owner` で、期限の内のときだけ true）。要約は API（`GET /holds`・`GET /grants`）と同じもの
 * - `apply`：
 *   - hold：approve → `approved`、reject → `rejected`（結果なので on_hold_resolved のタスクも作る）
 *   - grant：approve → `active`（`starts_at` = 承認の時刻、`expires_at` = それ + `duration_hours`）、reject → `rejected`
 *   - `pending_owner` でない・期限を過ぎた・無いなら `NotAwaitingOwnerError`（何も変えない）
 * - `afterApply`：hold の approve なら、再送する（`replay.ts`。1回だけ）
 *
 * daemon への渡し方：`createHoldTargets(deps)` の戻り値を、approvals/ の対象の一覧に入れる。
 */
import type { ApprovalDecision } from "@aicoop/shared/api";
import type { ApprovalSubject, ApprovalTarget, ApprovalTargets } from "../approvals/types.ts";
import { getGrant, transitionGrant } from "../db/grants.ts";
import { getHold, transitionHold } from "../db/holds.ts";
import { writeTransaction } from "../db/open.ts";
import type { HoldDeps } from "./deps.ts";
import { grantRequestExpiresAt } from "./expire.ts";
import { replayHold } from "./replay.ts";
import { createOnHoldResolvedTask } from "./resolved.ts";
import { grantSummaryOf, holdApprovalSummary } from "./views.ts";

const HOUR_MS = 60 * 60 * 1000;

/** オーナーの承認を待っていない（決まった・期限切れ・無い）。決定は効力を持たない */
export class NotAwaitingOwnerError extends Error {
  override name = "NotAwaitingOwnerError";
}

export function createHoldTargets(deps: HoldDeps): ApprovalTargets {
  return { hold: holdTarget(deps), grant: grantTarget(deps) };
}

function holdTarget(deps: HoldDeps): ApprovalTarget {
  const awaiting = (status: string, expiresAt: string) =>
    status === "pending_owner" && deps.now().getTime() < Date.parse(expiresAt);
  return {
    type: "hold",
    describe(id): ApprovalSubject | undefined {
      const hold = getHold(deps.db, id);
      if (hold === undefined) return undefined;
      return {
        type: "hold",
        id: hold.id,
        status: hold.status,
        awaitingOwner: awaiting(hold.status, hold.expiresAt),
        summary: holdApprovalSummary(hold),
      };
    },
    apply(id, decision: ApprovalDecision, by) {
      return writeTransaction(deps.db, () => {
        const hold = getHold(deps.db, id);
        if (hold === undefined || !awaiting(hold.status, hold.expiresAt)) {
          throw new NotAwaitingOwnerError(
            hold === undefined
              ? `保留 ${id} はありません`
              : `保留 ${id} は、オーナーの承認を待っていません（状態：${hold.status}）`,
          );
        }
        const after = transitionHold(deps.db, id, {
          from: ["pending_owner"],
          to: decision === "approve" ? "approved" : "rejected",
          by,
          actor: by,
          decide: true,
        });
        if (after.status === "rejected") createOnHoldResolvedTask(deps, deps.config(), after);
        return { status: after.status };
      });
    },
    async afterApply(id, decision) {
      if (decision === "approve") {
        await replayHold(deps, id);
      } else {
        deps.onTaskCreated?.();
      }
    },
  };
}

function grantTarget(deps: HoldDeps): ApprovalTarget {
  const awaiting = (grant: NonNullable<ReturnType<typeof getGrant>>) =>
    grant.status === "pending_owner" &&
    deps.now().getTime() < grantRequestExpiresAt(deps.config(), grant);
  return {
    type: "grant",
    describe(id): ApprovalSubject | undefined {
      const grant = getGrant(deps.db, id);
      if (grant === undefined) return undefined;
      return {
        type: "grant",
        id: grant.id,
        status: grant.status,
        awaitingOwner: awaiting(grant),
        summary: grantSummaryOf(grant),
      };
    },
    apply(id, decision: ApprovalDecision, by) {
      return writeTransaction(deps.db, () => {
        const grant = getGrant(deps.db, id);
        if (grant === undefined || !awaiting(grant)) {
          throw new NotAwaitingOwnerError(
            grant === undefined
              ? `一時権限の申請 ${id} はありません`
              : `一時権限の申請 ${id} は、オーナーの承認を待っていません（状態：${grant.status}）`,
          );
        }
        if (decision === "reject") {
          const after = transitionGrant(deps.db, id, {
            from: ["pending_owner"],
            to: "rejected",
            by,
            actor: by,
            decide: true,
          });
          return { status: after.status };
        }
        const startsAt = deps.now();
        const after = transitionGrant(deps.db, id, {
          from: ["pending_owner"],
          to: "active",
          by,
          actor: by,
          decide: true,
          startsAt: startsAt.toISOString(),
          expiresAt: new Date(startsAt.getTime() + grant.durationHours * HOUR_MS).toISOString(),
        });
        return { status: after.status };
      });
    },
  };
}
