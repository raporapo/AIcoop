/**
 * パスキー（WebAuthn）の決まりと、@simplewebauthn/server での確かめ（5.8）。
 *
 * - RP ID は `localhost`、期待するオリジンは `http://localhost:<daemon.port>`（P2 は PC の localhost だけ。
 *   IP アドレスは RP ID にできない）
 * - 本人確認（UV）は必須。ユーザーがいる（UP）ことも確かめる
 * - iframe の中からの応答（`crossOrigin: true`・`topOrigin` つき）は受けない（承認アプリは枠に入れない）
 * - 署名を確かめるときは、応答の資格情報の ID が、確かめる端末のものと同じであることも確かめる
 *   （@simplewebauthn/server は、渡した資格情報の鍵で確かめるだけで、ID は比べない）
 * - 署名カウンター：WebAuthn の仕様と @simplewebauthn/server のとおり、保存した値か新しい値が 0 より
 *   大きければ、新しい値が保存した値より大きくなければ拒否する。両方 0（数えない認証器）なら受ける
 *
 * 失敗はどれも `signature_invalid`（どこが違ったかは言わない）。形の壊れた本文だけ `invalid_input`。
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { ApprovalFailure, approvalError, invalidInput } from "./errors.ts";

export const RP_ID = "localhost";

/**
 * 受ける公開鍵の方式（COSE）：EdDSA・ES256・RS256。@simplewebauthn/server の既定は、Node が対応していれば
 * ML-DSA-44 も足し、そのたびに実験的な機能の警告を出すので、決めて渡す
 */
export const SUPPORTED_ALGORITHM_IDS: readonly number[] = [-8, -7, -257];

/** 承認アプリのオリジン（パスキーの登録・署名の clientDataJSON の origin） */
export function appOrigin(port: number): string {
  return `http://localhost:${port}`;
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function randomBase64url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** 資格情報の ID は 1023 バイトまで（WebAuthn）。base64url で 1364 文字 */
const MAX_CREDENTIAL_ID_CHARS = 1364;
/** clientDataJSON・authenticatorData・attestationObject・署名の上限（本文の上限 64 KiB の中） */
const MAX_FIELD_CHARS = 32 * 1024;

export interface ClientData {
  readonly type: unknown;
  readonly challenge: string;
  readonly origin: unknown;
  readonly crossOrigin?: unknown;
  readonly topOrigin?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isB64(value: unknown, max = MAX_FIELD_CHARS): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && BASE64URL.test(value)
  );
}

/**
 * 送られた WebAuthn の応答（JSON）の形を確かめ、clientDataJSON を読む。
 * オブジェクトでなければ `invalid_input`、中身の形・iframe の中の応答は `signature_invalid`
 */
export function readCredentialResponse(
  value: unknown,
  kind: "registration" | "authentication",
  failMessage: string,
): { readonly id: string; readonly clientData: ClientData } {
  if (!isRecord(value))
    throw invalidInput("response（パスキーの応答）を JSON のオブジェクトで送ってください");
  const fail = () => approvalError("signature_invalid", failMessage);
  const { id, rawId, type, response } = value;
  if (!isB64(id, MAX_CREDENTIAL_ID_CHARS) || rawId !== id || type !== "public-key") throw fail();
  if (!isRecord(response) || !isB64(response.clientDataJSON)) throw fail();
  if (kind === "registration" && !isB64(response.attestationObject)) throw fail();
  if (
    kind === "authentication" &&
    (!isB64(response.authenticatorData) || !isB64(response.signature))
  ) {
    throw fail();
  }
  let clientData: unknown;
  try {
    clientData = JSON.parse(Buffer.from(response.clientDataJSON, "base64url").toString("utf8"));
  } catch {
    throw fail();
  }
  if (!isRecord(clientData) || typeof clientData.challenge !== "string") throw fail();
  // 承認アプリは枠（iframe）に入れない。枠の中で作られた応答は受けない
  if (clientData.crossOrigin !== undefined && clientData.crossOrigin !== false) throw fail();
  if (clientData.topOrigin !== undefined) throw fail();
  return { id, clientData: clientData as unknown as ClientData };
}

export interface RegisteredCredential {
  /** base64url */
  readonly credentialId: string;
  /** COSE の公開鍵（base64url） */
  readonly publicKey: string;
  readonly counter: number;
}

/** 登録（attestation）を確かめる。通らなければ `signature_invalid` */
export async function verifyRegistration(
  response: unknown,
  expected: { readonly challenge: string; readonly origin: string },
  failMessage: string,
): Promise<RegisteredCredential> {
  const { id } = readCredentialResponse(response, "registration", failMessage);
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    result = await verifyRegistrationResponse({
      response: response as unknown as RegistrationResponseJSON,
      expectedChallenge: expected.challenge,
      expectedOrigin: expected.origin,
      expectedRPID: RP_ID,
      expectedType: "webauthn.create",
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...SUPPORTED_ALGORITHM_IDS],
    });
  } catch (error) {
    if (error instanceof ApprovalFailure) throw error;
    throw approvalError("signature_invalid", failMessage);
  }
  if (!result.verified || !result.registrationInfo.userVerified) {
    throw approvalError("signature_invalid", failMessage);
  }
  const credential = result.registrationInfo.credential;
  // authenticatorData の中の資格情報の ID と、応答の id が違うものは受けない
  if (credential.id !== id) throw approvalError("signature_invalid", failMessage);
  return {
    credentialId: credential.id,
    publicKey: base64url(credential.publicKey),
    counter: credential.counter,
  };
}

export interface StoredCredential {
  readonly id: string;
  /** base64url */
  readonly publicKey: string;
  readonly counter: number;
}

/** 署名（assertion）を確かめる。通らなければ `signature_invalid` */
export async function verifyAssertion(
  response: unknown,
  expected: {
    readonly challenge: string;
    readonly origin: string;
    readonly credential: StoredCredential;
  },
  failMessage: string,
): Promise<{ readonly newCounter: number }> {
  const { id } = readCredentialResponse(response, "authentication", failMessage);
  if (id !== expected.credential.id) throw approvalError("signature_invalid", failMessage);
  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    result = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: expected.challenge,
      expectedOrigin: expected.origin,
      expectedRPID: RP_ID,
      expectedType: "webauthn.get",
      credential: {
        id: expected.credential.id,
        publicKey: new Uint8Array(Buffer.from(expected.credential.publicKey, "base64url")),
        counter: expected.credential.counter,
      },
      requireUserVerification: true,
    });
  } catch {
    throw approvalError("signature_invalid", failMessage);
  }
  if (!result.verified || !result.authenticationInfo.userVerified) {
    throw approvalError("signature_invalid", failMessage);
  }
  return { newCounter: result.authenticationInfo.newCounter };
}
