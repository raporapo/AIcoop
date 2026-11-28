/**
 * 承認の署名（5.8 の3、T-4、P-4）。承認・却下の両方で行う。
 *
 * intent（`POST /approvals/intent`、ログイン中の端末）：
 * - 対象（`ApprovalTargets` の `describe`）がオーナーの承認を待っていることを確かめる
 * - payload を作って覚える：`summary_sha256` は `describe` の `summary` の正規化JSON の SHA-256（16進）、
 *   期限は2分、nonce は128ビットの乱数（base64url）
 * - チャレンジ = payload の正規化JSON の SHA-256（base64url）。allowCredentials はログイン中の端末のパスキーだけ
 *
 * assert（`POST /approvals/assert`）：次をすべて確かめ、1つでも通らなければ捨てる（その payload はもう使えない）
 * 1. payload が daemon の出したものと完全に同じ（正規化JSON で比べる。欄の追加・削除・型の違いも拒否）
 * 2. その payload を出した端末からの送信である
 * 3. 期限内（`expires_at` ちょうどまでは受ける）
 * 4. nonce が未使用（`used_nonces`。期限を過ぎた行は消す）
 * 5. @simplewebauthn/server で、チャレンジ・オリジン・RP ID・署名・カウンターの増加・UV
 * 6. 対象がまだオーナーの承認を待っていて、要約が表示したときと同じ
 *
 * すべて通ったら、1つのトランザクションで `used_nonces` に入れ、署名カウンターを保存し、`approvals` に
 * 記録し、監査ログ `approval` を書き、`target.apply`（対象の状態の変化と、その監査ログ）。そのあと `afterApply`。
 *
 * payload は daemon のメモリの中にだけ覚える（daemon を起動し直すと、出してあった payload はすべて使えなくなる）。
 */
import { canonicalJson, newId } from "@aicoop/shared";
import type {
  ApprovalAssertResponse,
  ApprovalDecision,
  ApprovalIntentResponse,
  ApprovalPayload,
  ApprovalSubjectType,
} from "@aicoop/shared/api";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { eq, lt } from "drizzle-orm";
import { appendAudit } from "../db/audit.ts";
import { writeTransaction } from "../db/open.ts";
import { approvals, usedNonces } from "../db/schema.ts";
import { type ApprovalContext, isRecord, objectBody } from "./context.ts";
import { advanceSignCount, getActiveDevice } from "./devices.ts";
import { ApprovalFailure, approvalError, invalidInput } from "./errors.ts";
import type { ApprovalTarget, ApprovalTargets } from "./types.ts";
import {
  appOrigin,
  base64url,
  RP_ID,
  randomBase64url,
  sha256,
  sha256Hex,
  verifyAssertion,
} from "./webauthn.ts";

/** 署名の期限（5.8 の3の3：issued_at + 2分） */
export const APPROVAL_TTL_MS = 2 * 60 * 1000;
/** 同時に出しておける payload の数（超えたら古いものから捨てる） */
export const MAX_PENDING_INTENTS = 64;
/** 期限を過ぎた payload も、しばらく覚えておく（「期限切れ」と正しく答えるため） */
const KEEP_EXPIRED_MS = 10 * 60 * 1000;

export const APPROVAL_SUBJECT_TYPES: readonly ApprovalSubjectType[] = [
  "hold",
  "grant",
  "tool_pin",
  "human_send",
  "human_accept",
  "human_result",
  "config_change",
  "secret_change",
];
const DECISIONS: readonly ApprovalDecision[] = ["approve", "reject"];
/** 対象の ID：印字できる ASCII で1〜200文字 */
const SUBJECT_ID = /^[\x21-\x7e]{1,200}$/;

const MSG = {
  signature:
    "パスキーの署名を確かめられませんでした（決定は記録していません）。もう一度、承認の操作からやり直してください",
  mismatch:
    "承認の内容が、制御サーバーが出したものと一致しません（書き換えられたか、古いものです）。決定は記録していません",
  otherDevice:
    "この承認の内容は、ほかの端末に出したものです。この端末で、承認の操作からやり直してください",
  expired: "署名の期限（2分）を過ぎました。もう一度、承認の操作からやり直してください",
  used: "この署名は、すでに使われています（送り直しは受け付けません）",
  notPending: "この対象は、もうオーナーの承認を待っていません",
  changed:
    "承認アプリに表示したあとで、対象の内容が変わりました。表示し直してから、もう一度決めてください",
} as const;

interface Intent {
  readonly payload: ApprovalPayload;
  /** payload の正規化JSON */
  readonly json: string;
  readonly challenge: string;
  readonly deviceId: string;
  readonly expiresAt: number;
}

export interface Signer {
  intent(deviceId: string, body: unknown): Promise<ApprovalIntentResponse>;
  assert(deviceId: string, body: unknown): Promise<ApprovalAssertResponse>;
  /** 端末を取り消したとき：その端末に出した payload を捨てる */
  forgetDevice(deviceId: string): void;
  /** 動いている afterApply を待つ（daemon を止めるとき） */
  drain(): Promise<void>;
}

export function summarySha256(summary: unknown): string {
  return sha256Hex(canonicalJson(summary));
}

/** チャレンジ：payload の正規化JSON の SHA-256（base64url。5.8 の3の4） */
export function challengeFor(payload: ApprovalPayload): string {
  return base64url(sha256(canonicalJson(payload)));
}

function readIntentBody(raw: unknown): {
  readonly type: ApprovalSubjectType;
  readonly id: string;
  readonly decision: ApprovalDecision;
} {
  const body = objectBody(raw, ["type", "id", "decision"]);
  const { type, id, decision } = body;
  if (!APPROVAL_SUBJECT_TYPES.includes(type as ApprovalSubjectType)) {
    throw invalidInput(`type は ${APPROVAL_SUBJECT_TYPES.join("・")} のどれかにしてください`);
  }
  if (!DECISIONS.includes(decision as ApprovalDecision)) {
    throw invalidInput("decision は approve か reject にしてください");
  }
  if (typeof id !== "string" || !SUBJECT_ID.test(id)) {
    throw invalidInput("id（対象の ID）を書いてください");
  }
  return { type: type as ApprovalSubjectType, id, decision: decision as ApprovalDecision };
}

export function createSigner(ctx: ApprovalContext, targets: () => ApprovalTargets): Signer {
  const { db, now, logger } = ctx;
  const intents = new Map<string, Intent>();
  const inflight = new Set<Promise<void>>();

  const prune = () => {
    const t = now().getTime();
    for (const [nonce, i] of intents) if (i.expiresAt + KEEP_EXPIRED_MS < t) intents.delete(nonce);
  };

  const targetFor = (type: ApprovalSubjectType): ApprovalTarget | undefined => {
    const t = targets()[type];
    return t !== undefined && t.type === type ? t : undefined;
  };

  const nonceUsed = (nonce: string): boolean =>
    db.orm.select().from(usedNonces).where(eq(usedNonces.nonce, nonce)).get() !== undefined;

  return {
    async intent(deviceId, raw) {
      const req = readIntentBody(raw);
      const device = getActiveDevice(db, deviceId);
      if (device === undefined) {
        throw new ApprovalFailure(
          401,
          "unauthorized",
          "この端末は使えません（取り消されています）",
        );
      }
      const target = targetFor(req.type);
      if (target === undefined) {
        throw new ApprovalFailure(404, "not_found", "この種類の承認は、まだできません");
      }
      const subject = target.describe(req.id);
      if (subject === undefined)
        throw new ApprovalFailure(404, "not_found", "その対象はありません");
      if (!subject.awaitingOwner) throw approvalError("not_pending", MSG.notPending);

      prune();
      while (intents.size >= MAX_PENDING_INTENTS) {
        const oldest = intents.keys().next().value;
        if (oldest === undefined) break;
        intents.delete(oldest);
      }
      const issued = now().getTime();
      const payload: ApprovalPayload = {
        type: req.type,
        id: req.id,
        decision: req.decision,
        company_id: ctx.company().id,
        summary_sha256: summarySha256(subject.summary),
        issued_at: new Date(issued).toISOString(),
        expires_at: new Date(issued + APPROVAL_TTL_MS).toISOString(),
        nonce: randomBase64url(16),
      };
      const json = canonicalJson(payload);
      const digest = sha256(json);
      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        challenge: new Uint8Array(digest),
        allowCredentials: [{ id: device.webauthnCredentialId }],
        userVerification: "required",
        timeout: APPROVAL_TTL_MS,
      });
      intents.set(payload.nonce, {
        payload,
        json,
        challenge: options.challenge,
        deviceId,
        expiresAt: issued + APPROVAL_TTL_MS,
      });
      return { payload, options: options as unknown as ApprovalIntentResponse["options"] };
    },

    async assert(deviceId, raw) {
      const body = objectBody(raw, ["payload", "response"]);
      if (!isRecord(body.payload))
        throw invalidInput("payload を JSON のオブジェクトで送ってください");
      if (!isRecord(body.response)) {
        throw invalidInput("response（パスキーの応答）を JSON のオブジェクトで送ってください");
      }
      const nonce = body.payload.nonce;
      if (typeof nonce !== "string") throw approvalError("payload_mismatch", MSG.mismatch);

      // 1. daemon が出したもの（1回だけ使える。ここで捨てる）
      const intent = intents.get(nonce);
      intents.delete(nonce);
      if (intent === undefined) {
        if (nonceUsed(nonce)) throw approvalError("nonce_used", MSG.used);
        throw approvalError("payload_mismatch", MSG.mismatch);
      }
      let json: string;
      try {
        json = canonicalJson(body.payload);
      } catch {
        throw approvalError("payload_mismatch", MSG.mismatch);
      }
      if (json !== intent.json) throw approvalError("payload_mismatch", MSG.mismatch);
      // 2. 出した端末から
      if (intent.deviceId !== deviceId) throw approvalError("payload_mismatch", MSG.otherDevice);
      // 3. 期限
      if (now().getTime() > intent.expiresAt) throw approvalError("approval_expired", MSG.expired);
      const payload = intent.payload;

      const device = getActiveDevice(db, deviceId);
      if (device === undefined) throw approvalError("signature_invalid", MSG.signature);
      const target = targetFor(payload.type);
      if (target === undefined) throw approvalError("not_pending", MSG.notPending);

      // 5. 署名
      const { newCounter } = await verifyAssertion(
        body.response,
        {
          challenge: intent.challenge,
          origin: appOrigin(ctx.port()),
          credential: {
            id: device.webauthnCredentialId,
            publicKey: device.webauthnPublicKey,
            counter: device.signCount,
          },
        },
        MSG.signature,
      );
      // 確かめているあいだに期限を過ぎたもの
      if (now().getTime() > intent.expiresAt) throw approvalError("approval_expired", MSG.expired);

      const by = `owner:${deviceId}` as const;
      const verifiedAt = now().toISOString();
      const approvalId = newId("approval", now().getTime());
      let status: string;
      try {
        status = writeTransaction(db, () => {
          // 4. nonce（期限を過ぎた行はここで消す）
          db.orm.delete(usedNonces).where(lt(usedNonces.expiresAt, verifiedAt)).run();
          if (nonceUsed(nonce)) throw approvalError("nonce_used", MSG.used);
          // 6. 対象
          const subject = target.describe(payload.id);
          if (subject === undefined || !subject.awaitingOwner) {
            throw approvalError("not_pending", MSG.notPending);
          }
          if (summarySha256(subject.summary) !== payload.summary_sha256) {
            throw approvalError("payload_mismatch", MSG.changed);
          }
          if (!advanceSignCount(db, device.id, device.signCount, newCounter)) {
            throw approvalError("signature_invalid", MSG.signature);
          }
          db.orm.insert(usedNonces).values({ nonce, expiresAt: payload.expires_at }).run();
          db.orm
            .insert(approvals)
            .values({
              id: approvalId,
              subjectType: payload.type,
              subjectId: payload.id,
              decision: payload.decision,
              deviceId,
              payload: intent.json,
              assertion: canonicalJson(body.response),
              verifiedAt,
            })
            .run();
          appendAudit(db, {
            actor: by,
            kind: "approval",
            subject: payload.id,
            data: { subject_type: payload.type, decision: payload.decision, device_id: deviceId },
          });
          return target.apply(payload.id, payload.decision, by).status;
        });
      } catch (error) {
        if (error instanceof ApprovalFailure) throw error;
        // apply が「もう待っていない」で投げたもの
        const subject = target.describe(payload.id);
        if (subject === undefined || !subject.awaitingOwner) {
          throw approvalError("not_pending", MSG.notPending);
        }
        throw error;
      }
      logger.info(
        {
          approval_id: approvalId,
          type: payload.type,
          id: payload.id,
          decision: payload.decision,
          device_id: deviceId,
        },
        "オーナーの決定を、パスキーの署名を確かめて記録しました",
      );

      if (target.afterApply !== undefined) {
        const p = target.afterApply(payload.id, payload.decision).catch((error: unknown) => {
          logger.error(
            { err: error, type: payload.type, id: payload.id },
            "承認のあとの処理（afterApply）が失敗しました。承認の記録は残っています",
          );
        });
        inflight.add(p);
        void p.finally(() => inflight.delete(p));
      }

      return {
        approval: {
          id: approvalId,
          subject_type: payload.type,
          subject_id: payload.id,
          decision: payload.decision,
          device_id: deviceId,
          verified_at: verifiedAt,
        },
        subject_status: status,
      };
    },

    forgetDevice(deviceId) {
      for (const [nonce, i] of intents) if (i.deviceId === deviceId) intents.delete(nonce);
    },

    async drain() {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
