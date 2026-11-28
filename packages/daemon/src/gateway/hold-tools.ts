/**
 * 組み込み道具 `review_decision`・`list_my_holds`・`request_access`（5.3.3、9.3）。
 *
 * 役職ごとに見せる道具を絞る（5.3.1 の受け入れ条件：見せない道具は一覧に出ない）：
 * - `review_decision`：`manager` の役職だけ
 * - `list_my_holds`・`request_access`：CEO（役職 `ceo`）を除くすべて
 *
 * どの道具も、その実行の Claude Code が動いているあいだだけ受け付ける（`active`。report_result と同じ）。
 * 引数は箱の中から来る（Z3）。型・上限に合わないものは invalid_input にする。
 */
import { listGrants } from "../db/grants.ts";
import { listHolds } from "../db/holds.ts";
import { requestAccess, requestAccessInputSchema } from "../holds/access.ts";
import type { HoldDeps } from "../holds/deps.ts";
import { reviewDecision } from "../holds/review.ts";
import { hasUnsafeChar } from "./report-result.ts";
import type { GatewayTool, GatewayToolResult } from "./server.ts";

export const MAX_COMMENT_CHARS = 2000;
const LIST_LIMIT = 50;

export interface HoldToolsContext {
  readonly deps: HoldDeps;
  /** この実行の社員（ポートで決まる。5.3.1 の1） */
  readonly memberId: string;
  /** 役職の ID */
  readonly roleId: string;
  /** Claude Code が動いているあいだだけ true */
  readonly active: () => boolean;
}

/** その役職に見せる組み込み道具の名前（report_result を除く） */
export function holdToolNamesFor(roleId: string): string[] {
  if (roleId === "ceo") return [];
  return roleId === "manager"
    ? ["review_decision", "list_my_holds", "request_access"]
    : ["list_my_holds", "request_access"];
}

const notActive: GatewayToolResult = {
  ok: false,
  code: "not_allowed",
  message: "このタスクはもう動いていないので、この道具は使えません",
};
const invalid = (message: string): GatewayToolResult => ({
  ok: false,
  code: "invalid_input",
  message,
});

export function holdTools(ctx: HoldToolsContext): GatewayTool[] {
  const names = new Set(holdToolNamesFor(ctx.roleId));
  const all: GatewayTool[] = [
    reviewDecisionTool(ctx),
    listMyHoldsTool(ctx),
    requestAccessTool(ctx),
  ];
  return all.filter((t) => names.has(t.name));
}

function guarded(ctx: HoldToolsContext, fn: (args: unknown) => GatewayToolResult) {
  return (args: unknown): GatewayToolResult => (ctx.active() ? fn(args) : notActive);
}

// ---- review_decision ----

function reviewDecisionTool(ctx: HoldToolsContext): GatewayTool {
  return {
    name: "review_decision",
    description:
      "担当する部署の、保留（h_...）・一時権限の申請（g_...）のレビュー結果を返します。pass は「オーナーの承認に進める」で、承認ではありません。reject は却下です。comment（理由）は必須です。",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "保留（h_...）か一時権限の申請（g_...）の ID" },
        decision: { type: "string", enum: ["pass", "reject"] },
        comment: {
          type: "string",
          maxLength: MAX_COMMENT_CHARS,
          description: `理由（必須。${MAX_COMMENT_CHARS}文字まで）。オーナーに見せます`,
        },
        assign_to: { type: "string", description: "依頼票のときだけ（P4 から）" },
      },
      required: ["item_id", "decision", "comment"],
      additionalProperties: false,
    },
    call: guarded(ctx, (args) => {
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return invalid("引数はオブジェクトで渡してください");
      }
      const a = args as Record<string, unknown>;
      const unknown = Object.keys(a).filter(
        (k) => !["item_id", "decision", "comment", "assign_to"].includes(k),
      );
      if (unknown.length > 0)
        return invalid("使える引数は item_id・decision・comment・assign_to だけです");
      if (typeof a.item_id !== "string" || !/^[hgk]_[0-9A-Z]{26}$/.test(a.item_id)) {
        return invalid("item_id は保留（h_...）か一時権限の申請（g_...）の ID にしてください");
      }
      if (a.decision !== "pass" && a.decision !== "reject") {
        return invalid("decision は pass か reject にしてください");
      }
      const comment = a.comment;
      if (typeof comment !== "string" || comment.trim() === "") {
        return invalid("comment（理由）を書いてください");
      }
      if ([...comment].length > MAX_COMMENT_CHARS) {
        return invalid(`comment は${MAX_COMMENT_CHARS}文字までです`);
      }
      if (hasUnsafeChar(comment)) {
        return invalid("comment に制御文字や文字の向きを変える文字は使えません");
      }
      if (a.assign_to !== undefined && !a.item_id.startsWith("k_")) {
        return invalid("assign_to は依頼票（k_...）のときだけ書けます");
      }
      const outcome = reviewDecision(ctx.deps, {
        managerId: ctx.memberId,
        itemId: a.item_id,
        decision: a.decision,
        comment,
      });
      if (!outcome.ok) return outcome;
      return {
        ok: true,
        value: {
          ok: true,
          item_id: outcome.itemId,
          status: outcome.status,
          message:
            outcome.status === "pending_owner"
              ? "オーナーの承認に進めました（まだ承認されていません）。report_result で、レビューしたことを報告してください。"
              : "却下しました。report_result で、レビューしたことを報告してください。",
        },
      };
    }),
  };
}

// ---- list_my_holds ----

const STATUS_TEXT: Readonly<Record<string, string>> = {
  pending_manager: "部長のレビュー待ち",
  pending_owner: "オーナーの承認待ち",
  approved: "承認済み（送信中）",
  replayed: "承認され、実行した",
  replay_failed: "承認されたが、送信に失敗した",
  rejected: "却下された",
  expired: "期限までに決まらなかった",
  active: "使える",
};

function listMyHoldsTool(ctx: HoldToolsContext): GatewayTool {
  return {
    name: "list_my_holds",
    description: "自分が出した保留と、一時権限の申請の状態を見ます（新しいものから50件ずつ）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    call: guarded(ctx, (args) => {
      if (
        args !== undefined &&
        (typeof args !== "object" || args === null || Object.keys(args).length > 0)
      ) {
        return invalid("この道具に引数はありません");
      }
      const db = ctx.deps.db;
      const holds = listHolds(db, { memberId: ctx.memberId, limit: LIST_LIMIT }).map((h) => ({
        hold_id: h.id,
        operation: `${h.service}.${h.operation}`,
        status: h.status,
        status_text: STATUS_TEXT[h.status] ?? h.status,
        created_at: h.createdAt,
        expires_at: h.expiresAt,
        resolved_at: h.resolvedAt,
        response_status: h.responseStatus,
      }));
      const grants = listGrants(db, { memberId: ctx.memberId, limit: LIST_LIMIT }).map((g) => ({
        grant_id: g.id,
        operation: `${g.service}.${g.operation}`,
        status: g.status,
        status_text: STATUS_TEXT[g.status] ?? g.status,
        duration_hours: g.durationHours,
        created_at: g.createdAt,
        starts_at: g.startsAt,
        expires_at: g.expiresAt,
      }));
      return { ok: true, value: { holds, grants } };
    }),
  };
}

// ---- request_access ----

function requestAccessTool(ctx: HoldToolsContext): GatewayTool {
  /** この実行の中で受け付けた申請の数（出しすぎの上限。holds/limits.ts） */
  let requested = 0;
  return {
    name: "request_access",
    description:
      "一時権限を申請します。部署の上限の中の操作だけを、決めた時間だけ使えるように頼みます。すぐには効かず、部長のレビューとオーナーの承認のあとで使えるようになります（新しいサービスの資格が要るものは、次の実行から）。",
    inputSchema: requestAccessInputSchema(ctx.deps.config().aicoop.grants.max_hours),
    call: guarded(ctx, (args) => {
      const outcome = requestAccess(ctx.deps, ctx.memberId, args, { inRun: requested });
      if (!outcome.ok) return outcome;
      requested += 1;
      return {
        ok: true,
        value: {
          ok: true,
          grant_id: outcome.grant.id,
          status: outcome.grant.status,
          message:
            "申請しました。まだ使えません。部長のレビューとオーナーの承認を待っています。状態は list_my_holds で確かめられます。",
        },
      };
    }),
  };
}
