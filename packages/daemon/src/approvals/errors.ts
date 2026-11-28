/**
 * 承認・ペアリング・ログインの失敗（5.8）。HTTP のステータスと `ApiErrorCode` を持つ。
 * `message` は利用者に見せる日本語（11.7）。中身に、署名・鍵・トークン・資格を入れない。
 */
import type { ConfigIssue } from "@aicoop/shared";
import type { ApiErrorCode } from "@aicoop/shared/api";

export type ApprovalFailureStatus = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500;

export class ApprovalFailure extends Error {
  override name = "ApprovalFailure";
  readonly status: ApprovalFailureStatus;
  readonly code: ApiErrorCode;
  /** config_invalid のとき（設定の画面の変更。5.14 の4の2） */
  readonly issues: readonly ConfigIssue[] | undefined;
  constructor(
    status: ApprovalFailureStatus,
    code: ApiErrorCode,
    message: string,
    issues?: readonly ConfigIssue[],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

export const invalidInput = (message: string) => new ApprovalFailure(400, "invalid_input", message);

/**
 * 承認の署名で使うエラーの HTTP のステータス（api.ts の ApprovalErrorCode）。
 * 対象の状態・使い済みに当たるものは 409、送られたものが合わないものは 400、ペアリングのコードは 404
 */
export const APPROVAL_ERROR_STATUS = {
  signature_invalid: 400,
  payload_mismatch: 400,
  approval_expired: 400,
  nonce_used: 409,
  not_pending: 409,
  pairing_invalid: 404,
} as const satisfies Record<string, ApprovalFailureStatus>;

export function approvalError(
  code: keyof typeof APPROVAL_ERROR_STATUS,
  message: string,
): ApprovalFailure {
  return new ApprovalFailure(APPROVAL_ERROR_STATUS[code], code, message);
}
