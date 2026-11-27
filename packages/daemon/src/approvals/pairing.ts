/**
 * 端末の登録 `aicoop pair --local`（5.8 の2。P2 は PC の localhost だけ）。
 *
 * 1. CLI（Bearer）が `start` で1回限りのコードをもらう（10分で失効）
 * 2. ブラウザ（認証なし。コードが鍵）が `options` でパスキーの作り方をもらい、`register` で登録を送る
 *    → daemon が登録を確かめ（UV 必須・RP ID localhost・オリジン http://localhost:<port>・attestation none）、
 *    パスキーの公開鍵とコードから6桁の確認コードを作る
 * 3. CLI が確認コードと端末の名前を出し、オーナーが `y` → `activate` で端末が有効になる（それまでは無効）
 *
 * 守ること（拒否側に倒す）：
 * - コードは 10 文字（Crockford の base32、50ビット）。違うコード・壊れたコードが合わせて5回来たら、
 *   いまのコードも無効にする（too_many_attempts）。新しいコードを出したら、前のコードは無効（superseded）
 * - 有効なコードは同時に1つだけ。状態はメモリの中だけ（daemon を起動し直すと消える）
 * - 登録の確かめに失敗したら、そのチャレンジは捨てる（options からやり直す）
 * - 登録したまま `y` を押さずに10分たったら、`y` を押しても有効にしない
 */
import { randomInt } from "node:crypto";
import { canonicalJson } from "@aicoop/shared";
import type {
  DeviceView,
  LocalPairingStatusResponse,
  PairingCancelReason,
  PairingOptionsResponse,
  PairingRegisterResponse,
  PairingStatus,
  StartLocalPairingResponse,
} from "@aicoop/shared/api";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { type ApprovalContext, objectBody } from "./context.ts";
import {
  addDevice,
  credentialInUse,
  DeviceError,
  listDevices,
  MAX_DEVICE_NAME_CHARS,
  normalizeDeviceName,
  toDeviceView,
} from "./devices.ts";
import { ApprovalFailure, approvalError, invalidInput } from "./errors.ts";
import {
  appOrigin,
  type RegisteredCredential,
  RP_ID,
  SUPPORTED_ALGORITHM_IDS,
  sha256,
  verifyRegistration,
} from "./webauthn.ts";

export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** 違うコードがこの回数来たら、いまのコードも無効にする */
export const PAIRING_MAX_FAILURES = 5;
/** ブラウザがパスキーを作るのを待つ長さ */
const REGISTRATION_TIMEOUT_MS = 2 * 60 * 1000;
/** 終わったペアリングの状態を、CLI が読めるように残しておく長さ */
const KEEP_ENDED_MS = 10 * 60 * 1000;

/** Crockford の base32（I・L・O・U を使わない） */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 10;
const CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

const INVALID_CODE =
  "ペアリングのコードが違うか、期限が切れています。PC で aicoop pair --local をやり直してください";
const REGISTER_FAILED =
  "パスキーの登録を確かめられませんでした。この画面を開き直して、もう一度登録してください";

type InternalStatus = "waiting" | "registered" | "activated" | "cancelled";

interface Pairing {
  readonly code: string;
  readonly expiresAt: number;
  status: InternalStatus;
  cancelReason: PairingCancelReason | null;
  endedAt: number | null;
  challenge: string | null;
  deviceName: string | null;
  credential: RegisteredCredential | null;
  confirmCode: string | null;
}

/** 表示の形（`ABCDE-FGHJK`） */
function display(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** 打ったコードを読む（ハイフン・空白・小文字は許す）。読めなければ null */
export function normalizePairingCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const v = value.replace(/[\s-]/g, "").toUpperCase();
  return CODE.test(v) ? v : null;
}

/** 確認コード：パスキーの資格情報の ID・公開鍵とコードから決まる6桁（5.8 の2の3） */
export function confirmCodeFor(code: string, credentialId: string, publicKey: string): string {
  const digest = sha256(
    canonicalJson({
      v: "aicoop-pair-local-1",
      code,
      credential_id: credentialId,
      public_key: publicKey,
    }),
  );
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export interface PairingManager {
  start(): StartLocalPairingResponse;
  status(code: string): LocalPairingStatusResponse;
  options(body: unknown): Promise<PairingOptionsResponse>;
  register(body: unknown): Promise<PairingRegisterResponse>;
  /** オーナーが y を押した（Bearer） */
  activate(code: string): DeviceView;
  cancel(code: string): void;
}

export function createPairing(ctx: ApprovalContext): PairingManager {
  const { db, now, logger } = ctx;
  const pairings = new Map<string, Pairing>();
  let failures = 0;

  const statusOf = (p: Pairing): PairingStatus =>
    (p.status === "waiting" || p.status === "registered") && now().getTime() >= p.expiresAt
      ? "expired"
      : p.status;

  const isOpen = (p: Pairing) => {
    const s = statusOf(p);
    return s === "waiting" || s === "registered";
  };

  const end = (p: Pairing, status: "activated" | "cancelled", reason?: PairingCancelReason) => {
    p.status = status;
    p.cancelReason = status === "cancelled" ? (reason ?? "cancelled") : null;
    p.endedAt = now().getTime();
    p.challenge = null;
  };

  const prune = () => {
    const t = now().getTime();
    for (const [code, p] of pairings) {
      const endedAt = p.endedAt ?? (statusOf(p) === "expired" ? p.expiresAt : null);
      if (endedAt !== null && t - endedAt > KEEP_ENDED_MS) pairings.delete(code);
    }
  };

  /** 認証なしの道（ブラウザ）から来たコード。違えば数え、多すぎたらいまのコードも無効にする */
  const forBrowser = (value: unknown): Pairing => {
    const code = normalizePairingCode(value);
    const p = code === null ? undefined : pairings.get(code);
    if (p === undefined || !isOpen(p)) {
      const guessed = p === undefined || p.status === "cancelled";
      if (guessed) {
        failures++;
        if (failures >= PAIRING_MAX_FAILURES) {
          for (const open of pairings.values()) {
            if (isOpen(open)) {
              end(open, "cancelled", "too_many_attempts");
              logger.warn(
                "違うペアリングのコードが何度も送られたので、いまのコードを無効にしました",
              );
            }
          }
          failures = 0;
        }
      }
      throw approvalError("pairing_invalid", INVALID_CODE);
    }
    return p;
  };

  /** CLI（Bearer）から来たコード */
  const forCli = (value: string): Pairing => {
    const code = normalizePairingCode(value);
    const p = code === null ? undefined : pairings.get(code);
    if (p === undefined)
      throw approvalError("pairing_invalid", "そのペアリングのコードはありません");
    return p;
  };

  return {
    start() {
      prune();
      for (const p of pairings.values()) if (isOpen(p)) end(p, "cancelled", "superseded");
      failures = 0;
      let code = "";
      do {
        code = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(32)]).join("");
      } while (pairings.has(code));
      const p: Pairing = {
        code,
        expiresAt: now().getTime() + PAIRING_TTL_MS,
        status: "waiting",
        cancelReason: null,
        endedAt: null,
        challenge: null,
        deviceName: null,
        credential: null,
        confirmCode: null,
      };
      pairings.set(code, p);
      logger.info("端末の登録（aicoop pair --local）を始めました");
      return {
        code: display(code),
        expires_at: new Date(p.expiresAt).toISOString(),
        url: `${appOrigin(ctx.port())}/app/#/pair`,
      };
    },

    status(value) {
      const p = forCli(value);
      const status = statusOf(p);
      const shown = status === "registered" || status === "activated";
      return {
        status,
        expires_at: new Date(p.expiresAt).toISOString(),
        device_name: shown ? p.deviceName : null,
        confirm_code: shown ? p.confirmCode : null,
        cancel_reason: status === "cancelled" ? p.cancelReason : null,
      };
    },

    async options(raw) {
      const body = objectBody(raw, ["code", "device_name"]);
      const p = forBrowser(body.code);
      if (statusOf(p) !== "waiting") {
        throw new ApprovalFailure(409, "invalid_state", "このコードでは、もう登録が済んでいます");
      }
      const name = normalizeDeviceName(body.device_name);
      if (name === null) {
        throw invalidInput(
          `device_name（端末の名前）は1〜${MAX_DEVICE_NAME_CHARS}文字で、改行や制御文字を含めないでください`,
        );
      }
      const company = ctx.company();
      const options = await generateRegistrationOptions({
        rpName: `AIcoop（${company.name}）`,
        rpID: RP_ID,
        userName: "owner",
        userDisplayName: `オーナー（${company.name}）`,
        // 同じ会社のオーナーは、どの端末でも同じ利用者として扱う
        userID: new Uint8Array(sha256(`aicoop-owner:${company.id}`).subarray(0, 16)),
        attestationType: "none",
        excludeCredentials: listDevices(db).map((d) => ({ id: d.webauthnCredentialId })),
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
        supportedAlgorithmIDs: [...SUPPORTED_ALGORITHM_IDS],
        timeout: REGISTRATION_TIMEOUT_MS,
      });
      p.challenge = options.challenge;
      p.deviceName = name;
      return { options: options as unknown as PairingOptionsResponse["options"] };
    },

    async register(raw) {
      const body = objectBody(raw, ["code", "response"]);
      const p = forBrowser(body.code);
      const challenge = p.challenge;
      if (statusOf(p) !== "waiting" || challenge === null) {
        throw new ApprovalFailure(
          409,
          "invalid_state",
          "このコードでは、いまは登録できません（登録が済んだか、画面を開き直す必要があります）",
        );
      }
      // チャレンジは1回限り（失敗しても使い回させない）
      p.challenge = null;
      const credential = await verifyRegistration(
        body.response,
        { challenge, origin: appOrigin(ctx.port()) },
        REGISTER_FAILED,
      );
      if (!isOpen(p) || p.status !== "waiting")
        throw approvalError("pairing_invalid", INVALID_CODE);
      if (credentialInUse(db, credential.credentialId)) {
        throw new ApprovalFailure(
          409,
          "invalid_state",
          "このパスキーは、すでにほかの端末として登録されています",
        );
      }
      p.credential = credential;
      p.confirmCode = confirmCodeFor(p.code, credential.credentialId, credential.publicKey);
      p.status = "registered";
      logger.info("端末のパスキーが登録されました。CLI で確認コードを確かめてください");
      return { confirm_code: p.confirmCode };
    },

    activate(value) {
      const p = forCli(value);
      const status = statusOf(p);
      if (status === "expired" || status === "cancelled") {
        throw approvalError("pairing_invalid", INVALID_CODE);
      }
      if (status !== "registered" || p.credential === null || p.deviceName === null) {
        throw new ApprovalFailure(
          409,
          "invalid_state",
          status === "activated"
            ? "この端末は、もう有効になっています"
            : "まだブラウザでパスキーが登録されていません",
        );
      }
      let device: ReturnType<typeof addDevice>;
      try {
        device = addDevice(
          db,
          {
            name: p.deviceName,
            kind: "pc",
            credentialId: p.credential.credentialId,
            publicKey: p.credential.publicKey,
            signCount: p.credential.counter,
          },
          "owner:cli",
        );
      } catch (error) {
        if (error instanceof DeviceError) {
          end(p, "cancelled");
          throw new ApprovalFailure(409, "invalid_state", error.message);
        }
        throw error;
      }
      end(p, "activated");
      logger.info({ device_id: device.id }, "端末を有効にしました");
      return toDeviceView(device);
    },

    cancel(value) {
      const p = forCli(value);
      const status = statusOf(p);
      if (status === "activated") {
        throw new ApprovalFailure(
          409,
          "invalid_state",
          "この端末は、もう有効になっています。取り消すときは aicoop devices revoke を使ってください",
        );
      }
      if (status === "waiting" || status === "registered") {
        end(p, "cancelled", "cancelled");
        logger.info("端末の登録を取りやめました");
      }
    },
  };
}
