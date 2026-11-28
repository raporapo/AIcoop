/**
 * 承認の署名（5.8 の3）：`/approvals/intent` → パスキーで署名（navigator.credentials.get）→
 * `/approvals/assert`。承認と却下の両方で行う。
 *
 * 署名する前に、承認アプリの側でも次を確かめ、1つでも合わなければ署名しない（拒否側に倒す）。
 * - payload の対象の種類・ID・決定が、オーナーが選んだものと同じ
 * - チャレンジ = payload の正規化JSON の SHA-256（base64url）。署名するものが payload そのものであること
 * - summary_sha256 = いま画面に表示している要約の正規化JSON の SHA-256（保留のとき）
 * - 署名に使うパスキーが指定されている（登録済みの資格情報だけ。5.8 の3の4）
 */
import type {
  ApprovalAssertResponse,
  ApprovalDecision,
  ApprovalSubjectType,
} from "@aicoop/shared/api";
import { type ApiClient, ApiFailure } from "../api/client.ts";
import { canonicalJson, sha256Base64Url, sha256Hex } from "./canonical.ts";
import { PasskeyFailure, type Passkeys, passkeyMessage } from "./passkeys.ts";

export type SignStep = "intent" | "passkey" | "assert";

export type SignFailure =
  | { readonly kind: "api"; readonly step: "intent" | "assert"; readonly error: ApiFailure }
  | { readonly kind: "passkey"; readonly error: PasskeyFailure }
  | { readonly kind: "mismatch"; readonly message: string };

export type SignResult =
  | { readonly ok: true; readonly response: ApprovalAssertResponse }
  | { readonly ok: false; readonly failure: SignFailure };

export interface SignInput {
  readonly api: ApiClient;
  readonly passkeys: Passkeys;
  readonly type: ApprovalSubjectType;
  readonly id: string;
  readonly decision: ApprovalDecision;
  /** 画面に表示した要約（保留のとき）。payload の summary_sha256 と照らす */
  readonly displayedSummary?: { readonly value: unknown };
  readonly onStep?: (step: SignStep) => void;
}

const NOT_APPLIED = "署名しませんでした。決定は効いていません";

async function check(input: SignInput, payload: unknown, options: unknown): Promise<string | null> {
  if (typeof payload !== "object" || payload === null)
    return `署名の内容を読めません。${NOT_APPLIED}`;
  const p = payload as Record<string, unknown>;
  if (p.type !== input.type || p.id !== input.id || p.decision !== input.decision) {
    return `制御サーバーから受け取った署名の内容が、選んだもの（対象・決定）と違います。${NOT_APPLIED}`;
  }
  if (typeof options !== "object" || options === null)
    return `署名の求めを読めません。${NOT_APPLIED}`;
  const o = options as Record<string, unknown>;
  let expected: string;
  try {
    expected = await sha256Base64Url(canonicalJson(payload));
  } catch {
    return `署名の内容を確かめられません。${NOT_APPLIED}`;
  }
  if (typeof o.challenge !== "string" || o.challenge.replace(/=+$/, "") !== expected) {
    return `署名のチャレンジが、受け取った内容から作ったものと一致しません。${NOT_APPLIED}`;
  }
  if (input.displayedSummary !== undefined) {
    let shown: string;
    try {
      shown = await sha256Hex(canonicalJson(input.displayedSummary.value));
    } catch {
      return `表示している要約を確かめられません。${NOT_APPLIED}`;
    }
    if (p.summary_sha256 !== shown) {
      return `署名の内容が、いま画面に表示している要約と一致しません（要約が変わったのかもしれません）。読み直して中身を確かめてから、もう一度やり直してください。${NOT_APPLIED}`;
    }
  }
  if (!Array.isArray(o.allowCredentials) || o.allowCredentials.length === 0) {
    return `署名に使うパスキーの指定がありません。${NOT_APPLIED}`;
  }
  return null;
}

export async function signDecision(input: SignInput): Promise<SignResult> {
  input.onStep?.("intent");
  let intent: Awaited<ReturnType<ApiClient["approvalIntent"]>>;
  try {
    intent = await input.api.approvalIntent({
      type: input.type,
      id: input.id,
      decision: input.decision,
    });
  } catch (e) {
    return { ok: false, failure: { kind: "api", step: "intent", error: asFailure(e) } };
  }

  const problem = await check(input, intent.payload, intent.options);
  if (problem !== null) return { ok: false, failure: { kind: "mismatch", message: problem } };

  input.onStep?.("passkey");
  let assertion: Awaited<ReturnType<Passkeys["authenticate"]>>;
  try {
    assertion = await input.passkeys.authenticate(intent.options);
  } catch (e) {
    const failure = e instanceof PasskeyFailure ? e : new PasskeyFailure("failed", "Error");
    return { ok: false, failure: { kind: "passkey", error: failure } };
  }

  input.onStep?.("assert");
  try {
    const response = await input.api.approvalAssert({
      payload: intent.payload,
      response: assertion,
    });
    return { ok: true, response };
  } catch (e) {
    return { ok: false, failure: { kind: "api", step: "assert", error: asFailure(e) } };
  }
}

function asFailure(e: unknown): ApiFailure {
  return e instanceof ApiFailure
    ? e
    : new ApiFailure(0, "internal", "承認アプリの中で思わぬエラーが起きました");
}

export interface FailureView {
  /** 制御サーバー・パスキーの言ったこと（そのまま見せる） */
  readonly message: string;
  /** 次にすること */
  readonly hint: string;
  /** もう一度やり直せるか（もう待っていないものは、やり直せない） */
  readonly retry: boolean;
  /** 決定が効いたか分からない（送ったあとに届かなくなった）ので、状態を読み直すべきか */
  readonly unknownOutcome: boolean;
}

const RETRY = "もう一度やり直してください（もう一度パスキーで署名します）";

export function describeSignFailure(failure: SignFailure): FailureView {
  switch (failure.kind) {
    case "mismatch":
      return { message: failure.message, hint: RETRY, retry: true, unknownOutcome: false };
    case "passkey":
      return {
        message: passkeyMessage(failure.error, "approve"),
        hint: RETRY,
        retry: true,
        unknownOutcome: false,
      };
    case "api": {
      const { error, step } = failure;
      const base = { message: error.message, retry: true, unknownOutcome: false };
      switch (error.code) {
        case "approval_expired":
          return { ...base, hint: `署名の期限（2分）が切れました。決定は効いていません。${RETRY}` };
        case "nonce_used":
          return {
            ...base,
            hint: `一度使った署名は、二度は使えません（使い回しを防ぐため）。決定は効いていません。${RETRY}`,
          };
        case "payload_mismatch":
          return {
            ...base,
            hint: `署名した内容が、制御サーバーの出したものと一致しませんでした。決定は効いていません。${RETRY}`,
          };
        case "signature_invalid":
          return {
            ...base,
            hint: `パスキーの署名を確かめられませんでした。決定は効いていません。${RETRY}`,
          };
        // 5.14 の4の4：変更を作ったあとでファイル・資格が書き換えられた（何も書いていない。変更は捨てられた）
        case "conflict":
          return {
            ...base,
            hint: "何も書いていません。いまの中身を読み直してから、もう一度変更を作ってください",
            retry: false,
          };
        // 5.14 の4の2：署名のあとの検証・読み直しで設定にエラーが見つかった（保存していない・元に戻した）
        case "config_invalid":
          return {
            ...base,
            hint: "保存していません。エラーを直してから、もう一度「確かめる」からやり直してください",
            retry: false,
          };
        case "not_pending":
          return {
            ...base,
            hint: "この件は、もうあなたの承認を待っていません（決まったか、期限が切れました）。いまの状態を読み直しました",
            retry: false,
          };
        case "offline":
          return step === "assert"
            ? {
                message: error.message,
                hint: "署名を送ったあとに届かなくなったので、決定が効いたかどうか分かりません。届くようになったら、いまの状態を確かめてください",
                retry: false,
                unknownOutcome: true,
              }
            : { ...base, hint: `決定は効いていません。届くようになったら、${RETRY}` };
        case "unauthorized":
          return {
            ...base,
            hint: "ログインし直してから、もう一度やり直してください。決定は効いていません",
            retry: false,
          };
        default:
          if (step === "assert" && (error.status >= 500 || error.code === "bad_response")) {
            return {
              ...base,
              hint: "署名を送ったあとに制御サーバーの中でエラーが起きたので、決定が効いたかどうか分かりません。いまの状態を読み直しました",
              retry: false,
              unknownOutcome: true,
            };
          }
          return { ...base, hint: `決定は効いていません。${RETRY}` };
      }
    }
  }
}
