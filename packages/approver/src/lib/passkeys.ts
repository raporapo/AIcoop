/**
 * パスキー（WebAuthn）の呼び出し。@simplewebauthn/browser を包み、失敗を利用者に見せる日本語にする。
 *
 * - 本人確認（`userVerification`）は、daemon の options に何が書いてあっても `required` にする
 *   （5.8 の2の2・3の4。弱める側には倒さない）
 * - 取り消し（NotAllowedError）は、ブラウザが時間切れと区別しないので、かかった時間で見分ける
 */

import type { WebAuthnJson } from "@aicoop/shared/api";
import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnError,
} from "@simplewebauthn/browser";

export type PasskeyFailureKind =
  | "unsupported"
  | "cancelled"
  | "timeout"
  | "wrong_origin"
  | "already_registered"
  | "no_user_verification"
  | "unsupported_algorithm"
  | "aborted"
  | "failed";

export class PasskeyFailure extends Error {
  readonly kind: PasskeyFailureKind;
  /** ブラウザの例外の名前（NotAllowedError など。調べるとき用） */
  readonly detail: string;

  constructor(kind: PasskeyFailureKind, detail: string) {
    super(`passkey: ${kind}`);
    this.name = "PasskeyFailure";
    this.kind = kind;
    this.detail = detail;
  }
}

export interface Passkeys {
  supported(): boolean;
  /** ログイン・承認の署名（navigator.credentials.get） */
  authenticate(options: WebAuthnJson): Promise<WebAuthnJson>;
  /** 端末の登録（navigator.credentials.create） */
  register(options: WebAuthnJson): Promise<WebAuthnJson>;
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "Error";
}

function classify(
  error: unknown,
  elapsedMs: number,
  timeoutMs: number | undefined,
): PasskeyFailure {
  const code = error instanceof WebAuthnError ? error.code : undefined;
  const name = errorName(error);
  if (error instanceof Error && error.message === "WebAuthn is not supported in this browser") {
    return new PasskeyFailure("unsupported", name);
  }
  if (code === "ERROR_CEREMONY_ABORTED" || name === "AbortError") {
    return new PasskeyFailure("aborted", name);
  }
  if (name === "NotAllowedError") {
    // ブラウザは「取り消した」と「時間切れ」を同じ例外で返す。期限の近くまでかかっていたら時間切れ
    const timedOut = timeoutMs !== undefined && elapsedMs >= timeoutMs - 2000;
    return new PasskeyFailure(timedOut ? "timeout" : "cancelled", name);
  }
  if (
    code === "ERROR_INVALID_DOMAIN" ||
    code === "ERROR_INVALID_RP_ID" ||
    name === "SecurityError"
  ) {
    return new PasskeyFailure("wrong_origin", name);
  }
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError") {
    return new PasskeyFailure("already_registered", name);
  }
  if (code === "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT") {
    return new PasskeyFailure("no_user_verification", name);
  }
  if (
    code === "ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG" ||
    name === "NotSupportedError"
  ) {
    return new PasskeyFailure("unsupported_algorithm", name);
  }
  return new PasskeyFailure("failed", code ?? name);
}

function timeoutOf(options: WebAuthnJson): number | undefined {
  const t = options.timeout;
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : undefined;
}

export function createPasskeys(clock: () => number = Date.now): Passkeys {
  async function run<T>(options: WebAuthnJson, call: () => Promise<T>): Promise<T> {
    if (!browserSupportsWebAuthn())
      throw new PasskeyFailure("unsupported", "no PublicKeyCredential");
    const started = clock();
    try {
      return await call();
    } catch (error) {
      throw classify(error, clock() - started, timeoutOf(options));
    }
  }

  return {
    supported: () => browserSupportsWebAuthn(),
    authenticate: (options) =>
      run(options, async () => {
        const optionsJSON = {
          ...options,
          userVerification: "required",
        } as unknown as PublicKeyCredentialRequestOptionsJSON;
        return (await startAuthentication({ optionsJSON })) as unknown as WebAuthnJson;
      }),
    register: (options) =>
      run(options, async () => {
        const selection =
          typeof options.authenticatorSelection === "object" &&
          options.authenticatorSelection !== null
            ? (options.authenticatorSelection as Record<string, unknown>)
            : {};
        const optionsJSON = {
          ...options,
          authenticatorSelection: { ...selection, userVerification: "required" },
        } as unknown as PublicKeyCredentialCreationOptionsJSON;
        return (await startRegistration({ optionsJSON })) as unknown as WebAuthnJson;
      }),
  };
}

export type PasskeyContext = "login" | "pair" | "approve";

/** パスキーを使える正しいアドレス（RP ID は localhost。IP アドレスでは使えない） */
export function localhostAppUrl(): string {
  const port = window.location.port === "" ? "7070" : window.location.port;
  return `http://localhost:${port}/app/`;
}

export function passkeyMessage(failure: PasskeyFailure, context: PasskeyContext): string {
  const notApplied = context === "approve" ? "。決定は効いていません" : "";
  const retry = context === "approve" ? notApplied : "。もう一度お試しください";
  switch (failure.kind) {
    case "unsupported":
      return "このブラウザはパスキー（WebAuthn）に対応していません。最新の Chrome・Edge・Safari・Firefox で開いてください";
    case "cancelled":
      if (context === "login") {
        return "パスキーの操作が取り消されました（または時間切れになりました）。この端末にまだパスキーがないときも、こうなります。PC のターミナルで aicoop pair --local を実行して、端末を登録してください";
      }
      return `パスキーの操作が取り消されました（または時間切れになりました）${retry}`;
    case "timeout":
      return `パスキーの操作が時間切れになりました${retry}`;
    case "wrong_origin":
      return `パスキーは ${localhostAppUrl()} でだけ使えます。アドレス欄を確かめて、開き直してください${notApplied}`;
    case "already_registered":
      return "この認証器には、もうこの会社のパスキーが登録されています。登録済みの端末は、ログインして「端末」の画面で確かめられます";
    case "no_user_verification":
      return `この認証器は本人確認（指紋・顔・PIN）に対応していません。本人確認のできるパスキーを使ってください${notApplied}`;
    case "unsupported_algorithm":
      return `この認証器は、求める署名の方式に対応していません。ほかの認証器を使ってください${notApplied}`;
    case "aborted":
      return `別のパスキーの操作が始まったので、この操作は中止されました${notApplied}`;
    case "failed":
      return `パスキーの操作に失敗しました（${failure.detail}）${notApplied}`;
  }
}
