/**
 * 承認アプリのパスキーでのログイン（9.2 の `/auth/login/options`・`/auth/login/verify`）。
 *
 * - options は、有効な端末のパスキーだけを allowCredentials に入れる。UV 必須。チャレンジは2分で失効し、
 *   1回限り（確かめる前に消す。失敗しても使い回させない）
 * - 確かめるもの：チャレンジ・オリジン・RP ID・署名・カウンターの増加・UV（`verifyAssertion`）
 * - 通ったら、署名カウンターを保存し（ほかで先に使われていたら拒否）、セッションを作る
 */

import type { LoginOptionsResponse } from "@aicoop/shared/api";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { writeTransaction } from "../db/open.ts";
import { type ApprovalContext, objectBody } from "./context.ts";
import {
  activeDeviceByCredential,
  activeDevices,
  advanceSignCount,
  type Device,
} from "./devices.ts";
import { ApprovalFailure, approvalError } from "./errors.ts";
import type { SessionStore } from "./sessions.ts";
import { appOrigin, RP_ID, readCredentialResponse, verifyAssertion } from "./webauthn.ts";

export const LOGIN_CHALLENGE_TTL_MS = 2 * 60 * 1000;
/** 同時に出しておけるログインのチャレンジの数（超えたら古いものから捨てる） */
export const MAX_LOGIN_CHALLENGES = 16;

const FAILED = "パスキーでログインできませんでした。もう一度ログインからやり直してください";

export interface LoginResult {
  readonly device: Device;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface Login {
  options(): Promise<LoginOptionsResponse>;
  verify(body: unknown): Promise<LoginResult>;
}

export function createLogin(ctx: ApprovalContext, sessions: SessionStore): Login {
  const { db, now, logger } = ctx;
  /** チャレンジ → 期限（ミリ秒）。入れた順 */
  const challenges = new Map<string, number>();

  const prune = () => {
    const t = now().getTime();
    for (const [c, exp] of challenges) if (exp < t) challenges.delete(c);
  };

  return {
    async options() {
      const devices = activeDevices(db);
      if (devices.length === 0) {
        throw new ApprovalFailure(
          409,
          "invalid_state",
          "登録された端末がありません。PC で aicoop pair --local を実行して、この端末を登録してください",
        );
      }
      prune();
      while (challenges.size >= MAX_LOGIN_CHALLENGES) {
        const oldest = challenges.keys().next().value;
        if (oldest === undefined) break;
        challenges.delete(oldest);
      }
      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        allowCredentials: devices.map((d) => ({ id: d.webauthnCredentialId })),
        userVerification: "required",
        timeout: LOGIN_CHALLENGE_TTL_MS,
      });
      challenges.set(options.challenge, now().getTime() + LOGIN_CHALLENGE_TTL_MS);
      return { options: options as unknown as LoginOptionsResponse["options"] };
    },

    async verify(raw) {
      const body = objectBody(raw, ["response"]);
      const { id, clientData } = readCredentialResponse(body.response, "authentication", FAILED);
      // チャレンジは1回限り：確かめる前に消す
      const expires = challenges.get(clientData.challenge);
      challenges.delete(clientData.challenge);
      if (expires === undefined || expires < now().getTime()) {
        throw approvalError("signature_invalid", FAILED);
      }
      const device = activeDeviceByCredential(db, id);
      if (device === undefined) throw approvalError("signature_invalid", FAILED);
      const { newCounter } = await verifyAssertion(
        body.response,
        {
          challenge: clientData.challenge,
          origin: appOrigin(ctx.port()),
          credential: {
            id: device.webauthnCredentialId,
            publicKey: device.webauthnPublicKey,
            counter: device.signCount,
          },
        },
        FAILED,
      );
      writeTransaction(db, () => {
        if (!advanceSignCount(db, device.id, device.signCount, newCounter)) {
          throw approvalError("signature_invalid", FAILED);
        }
      });
      const session = sessions.create(device.id);
      logger.info({ device_id: device.id }, "承認アプリにパスキーでログインしました");
      return { device: { ...device, signCount: newCounter }, ...session };
    },
  };
}
