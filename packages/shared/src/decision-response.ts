/**
 * 拒否と保留の返し方（5.2.5）。
 *
 * AI社員が「操作が成功した」と勘違いしないように、ふつうの成功やエラーと区別できる形で返す。
 * 本文は 5.2.5 の表と同じ形・同じ文言にする（自動で作るプロンプト 5.4.3 でも、この形を説明する）。
 */
import type { ProxyDecision } from "./box.ts";
import { isId } from "./ids.ts";
import type { RuleDecision } from "./permission.ts";

export const AICOOP_DECISION_HEADER = "X-Aicoop-Decision";

/** 5.2.5 の表の保留の文言 */
export const HOLD_MESSAGE = "承認待ちです。結果は後で届きます。同じ操作を繰り返さないでください。";

/**
 * 拒否の理由。
 * - `no_operation`：どの操作にも一致しない（5.2.4 の1）
 * - `not_allowed`：有効な許可にない（5.2.4 の4）
 * - `too_large_to_hold`：保留にする本文が上限を超えた（5.2.6 の1）
 */
export type DenyReason = "no_operation" | "not_allowed" | "too_large_to_hold";

const DENY_REASONS: ReadonlySet<string> = new Set<DenyReason>([
  "no_operation",
  "not_allowed",
  "too_large_to_hold",
]);

/** `<service>.<operation>`（6.3 の許可項目の op と同じ形） */
const OPERATION_ID = /^[a-z0-9-]+\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

export type DecisionResponse = Extract<ProxyDecision, { action: "respond" }>;

function respond(status: 403 | 428, decision: "deny" | "hold", body: string): DecisionResponse {
  return {
    action: "respond",
    status,
    headers: {
      [AICOOP_DECISION_HEADER]: decision,
      "Content-Type": "application/json; charset=utf-8",
    },
    body,
  };
}

/** 拒否：`403`、`X-Aicoop-Decision: deny` */
export function denyResponse(operation: string | null, reason: DenyReason): DecisionResponse {
  if (operation !== null && !OPERATION_ID.test(operation)) {
    throw new TypeError("拒否の応答の operation は <service>.<operation> か null にしてください");
  }
  if (!DENY_REASONS.has(reason)) {
    throw new TypeError(`知らない拒否の理由です: ${String(reason)}`);
  }
  // キーの順は 5.2.5 の表のとおり
  return respond(403, "deny", JSON.stringify({ aicoop: "deny", operation, reason }));
}

/** ルールの判定（5.2.4）の deny から、拒否の応答を作る */
export function denyResponseFor(
  decision: Extract<RuleDecision, { decision: "deny" }>,
): DecisionResponse {
  return denyResponse(decision.operation?.id ?? null, decision.reason);
}

/** 保留：`428`、`X-Aicoop-Decision: hold` */
export function holdResponse(holdId: string): DecisionResponse {
  if (!isId(holdId, "hold")) {
    throw new TypeError("保留の応答には保留の ID（h_...）を渡してください");
  }
  return respond(
    428,
    "hold",
    JSON.stringify({ aicoop: "hold", hold_id: holdId, message: HOLD_MESSAGE }),
  );
}
