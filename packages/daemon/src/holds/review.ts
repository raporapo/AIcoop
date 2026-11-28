/**
 * 部長のレビュー（5.7.1 の2・3、5.7.3 の2、5.3.3 の review_decision）。
 *
 * - 保留・一時権限の申請が `pending_manager` で作られたら、担当の部長に `review` のタスクを作る
 *   （優先度1、`review_subject` に対象の ID、部長は役員室の箱で動く。5.1.1 の2）。タスク本文の背景には、
 *   要約を外から来た文章として囲んで入れる（中身は AI社員が書いたもの）
 * - `review_decision` は、その部長が担当する部署（`manages`）の項目で、`pending_manager` のときだけ通る。
 *   pass は `pending_owner`（承認ではなく、オーナーの承認に進めること）、reject は `rejected`。
 *   部長のコメントは `manager_comment` に残す
 * - 担当でない項目・無い項目は、同じ答え（not_allowed）にする（ほかの部署の項目があるかを教えない）
 * - レビューのタスクは、毎回新しいセッション（スレッド `task-<task_id>`）で動かす。前のレビューで読んだ
 *   中身（外から来た文章）を、次のレビューに持ち込ませない
 */
import {
  type CompanyConfig,
  isId,
  managerOf,
  resolveMember,
  timeoutMinutesFor,
} from "@aicoop/shared";
import { type Grant, GrantStateError, getGrant, transitionGrant } from "../db/grants.ts";
import { getHold, type Hold, HoldStateError, transitionHold } from "../db/holds.ts";
import { writeTransaction } from "../db/open.ts";
import { createTask, type Task } from "../db/tasks.ts";
import type { HoldDeps } from "./deps.ts";
import { expireGrantIfDue, expireHoldIfDue } from "./expire.ts";
import type { HoldSummary } from "./prepare.ts";
import { type GrantSummary, renderGrantSummary, renderHoldSummary } from "./render.ts";
import { createOnHoldResolvedTask } from "./resolved.ts";

const MANAGER = "manager";

/** 保留・申請を出した部署の部長（いなければ undefined。5.7.1 の1） */
export function reviewerFor(config: CompanyConfig, groupId: string): string | undefined {
  return managerOf(config, groupId);
}

/** 一時権限を申請した社員の部署（いまの設定の members.yaml の group）。設定にいなければ undefined */
export function grantGroupOf(
  config: CompanyConfig,
  grant: Pick<Grant, "memberId">,
): string | undefined {
  const m = Object.hasOwn(config.members, grant.memberId)
    ? config.members[grant.memberId]
    : undefined;
  return m !== undefined && m.kind === "ai" ? m.group : undefined;
}

/** 5.7.1 の2：保留のレビューのタスクを作る */
export function createHoldReviewTask(
  deps: Pick<HoldDeps, "db">,
  config: CompanyConfig,
  managerId: string,
  hold: Hold,
  summary: HoldSummary,
): Task {
  return createReviewTask(deps, config, managerId, {
    id: hold.id,
    purpose: `社員 ${hold.memberId}（部署 ${hold.groupId}）が出した保留 ${hold.id}（${hold.service}.${hold.operation}）をレビューする。宛先・中身・送り先に問題がないかを見て、問題がなければ pass（オーナーの承認に進める）、あれば reject にする`,
    context: renderHoldSummary(summary),
  });
}

/** 5.7.3 の2：一時権限の申請のレビューのタスクを作る */
export function createGrantReviewTask(
  deps: Pick<HoldDeps, "db">,
  config: CompanyConfig,
  managerId: string,
  grant: Grant,
  summary: GrantSummary,
): Task {
  return createReviewTask(deps, config, managerId, {
    id: grant.id,
    purpose: `社員 ${grant.memberId} が申請した一時権限 ${grant.id}（${grant.service}.${grant.operation}、${grant.durationHours}時間）をレビューする。仕事に本当に要る範囲か、広すぎないかを見て、問題がなければ pass（オーナーの承認に進める）、あれば reject にする`,
    context: renderGrantSummary(summary),
  });
}

function createReviewTask(
  deps: Pick<HoldDeps, "db">,
  config: CompanyConfig,
  managerId: string,
  item: { readonly id: string; readonly purpose: string; readonly context: string },
): Task {
  const manager = resolveMember(config, managerId);
  if (manager === undefined) throw new Error(`部長「${managerId}」が設定にいません`);
  return createTask(deps.db, {
    memberId: manager.id,
    groupId: manager.group.id,
    triggerKind: "review",
    thread: null,
    purpose: item.purpose,
    context: item.context,
    // 中身は AI社員が書いたもの（5.7.1 の2「外から来た文章として囲んで入れる」）
    contextUntrusted: true,
    doneWhen: `review_decision（item_id: ${item.id}）で pass か reject を、理由のコメントを添えて返し、report_result で報告した`,
    reviewSubject: item.id,
    timeoutMinutes: timeoutMinutesFor(config),
  });
}

export interface ReviewDecisionInput {
  readonly managerId: string;
  readonly itemId: string;
  readonly decision: "pass" | "reject";
  readonly comment: string;
}

export type ReviewOutcome =
  | { readonly ok: true; readonly itemId: string; readonly status: string }
  | {
      readonly ok: false;
      readonly code: "not_allowed" | "invalid_input";
      readonly message: string;
    };

const NOT_YOURS =
  "その項目は、あなたのレビューの対象ではありません（担当する部署の、部長のレビューを待っている保留・一時権限の申請だけを決められます）";

/** 5.3.3 の review_decision（入力の形は呼ぶ側で確かめてある） */
export function reviewDecision(deps: HoldDeps, input: ReviewDecisionInput): ReviewOutcome {
  const config = deps.config();
  const manager = resolveMember(config, input.managerId);
  const manages = manager?.member.manages;
  if (manager === undefined || manager.role.id !== MANAGER || manages === undefined) {
    return { ok: false, code: "not_allowed", message: "review_decision は部長だけが使えます" };
  }
  const by = `manager:${manager.id}` as const;
  const actor = `member:${manager.id}` as const;

  if (isId(input.itemId, "ticket")) {
    return {
      ok: false,
      code: "not_allowed",
      message: "依頼票（k_）のレビューは、まだ使えません（P4 から）",
    };
  }

  const created = { task: false };
  let outcome: ReviewOutcome;
  try {
    outcome = writeTransaction(deps.db, (): ReviewOutcome => {
      if (isId(input.itemId, "hold")) {
        const hold = getHold(deps.db, input.itemId);
        if (hold === undefined || hold.groupId !== manages) {
          return { ok: false, code: "not_allowed", message: NOT_YOURS };
        }
        if (expireHoldIfDue(deps, config, hold)) {
          return { ok: false, code: "not_allowed", message: `保留 ${hold.id} は期限が切れました` };
        }
        if (hold.status !== "pending_manager") {
          return {
            ok: false,
            code: "not_allowed",
            message: `保留 ${hold.id} は、もう部長のレビューを待っていません（状態：${hold.status}）`,
          };
        }
        const after = transitionHold(deps.db, hold.id, {
          from: ["pending_manager"],
          to: input.decision === "pass" ? "pending_owner" : "rejected",
          by,
          actor,
          managerComment: input.comment,
          ...(input.decision === "reject" && { decide: true }),
        });
        // 5.2.6 の4：却下も結果。on_hold_resolved のタスクを同じトランザクションで作る
        if (after.status === "rejected" && createOnHoldResolvedTask(deps, config, after) !== null) {
          created.task = true;
        }
        return { ok: true, itemId: hold.id, status: after.status };
      }
      if (isId(input.itemId, "grant")) {
        const grant = getGrant(deps.db, input.itemId);
        if (grant === undefined || grantGroupOf(config, grant) !== manages) {
          return { ok: false, code: "not_allowed", message: NOT_YOURS };
        }
        if (expireGrantIfDue(deps, config, grant)) {
          return {
            ok: false,
            code: "not_allowed",
            message: `一時権限の申請 ${grant.id} は期限が切れました`,
          };
        }
        if (grant.status !== "pending_manager") {
          return {
            ok: false,
            code: "not_allowed",
            message: `一時権限の申請 ${grant.id} は、もう部長のレビューを待っていません（状態：${grant.status}）`,
          };
        }
        const after = transitionGrant(deps.db, grant.id, {
          from: ["pending_manager"],
          to: input.decision === "pass" ? "pending_owner" : "rejected",
          by,
          actor,
          managerComment: input.comment,
          ...(input.decision === "reject" && { decide: true }),
        });
        return { ok: true, itemId: grant.id, status: after.status };
      }
      return {
        ok: false,
        code: "invalid_input",
        message: "item_id は保留（h_...）か一時権限の申請（g_...）の ID にしてください",
      };
    });
  } catch (error) {
    if (error instanceof HoldStateError || error instanceof GrantStateError) {
      return {
        ok: false,
        code: "not_allowed",
        message: "その項目は、ちょうどほかの決定で状態が変わりました",
      };
    }
    throw error;
  }
  if (created.task) deps.onTaskCreated?.();
  deps.logger?.info(
    { manager: input.managerId, item: input.itemId, decision: input.decision, ok: outcome.ok },
    "部長のレビューを受けました",
  );
  return outcome;
}
