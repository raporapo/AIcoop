/**
 * 承認アプリの端末（7.2 の devices。5.8 の2、T-12）。
 *
 * - 端末は、オーナーが登録したパスキー（WebAuthn の資格情報）を1つ持つ。承認できるのは、有効な
 *   （取り消していない）端末のパスキーだけ（5.7.2）
 * - 作成・取り消しは、同じトランザクションで監査ログ `device.state` を書く（中身・鍵は書かない）
 * - 取り消した端末の行は消さない（`approvals.device_id` から引けるように）
 */
import type { AuditActor } from "@aicoop/shared";
import { isId, newId } from "@aicoop/shared";
import type { DeviceView } from "@aicoop/shared/api";
import { and, asc, eq, isNull } from "drizzle-orm";
import { appendAudit } from "../db/audit.ts";
import { type StateDb, writeTransaction } from "../db/open.ts";
import { devices } from "../db/schema.ts";

export type Device = typeof devices.$inferSelect;

/** 端末の名前：前後の空白を除いて1〜40文字。制御文字・書式文字・行区切りを含まない */
const DEVICE_NAME = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,40}$/u;
export const MAX_DEVICE_NAME_CHARS = 40;

/** 端末の名前を確かめる（前後の空白は除く）。使えなければ null */
export function normalizeDeviceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return DEVICE_NAME.test(name) ? name : null;
}

export type DeviceErrorCode = "invalid_name" | "duplicate_credential" | "not_found" | "revoked";

export class DeviceError extends Error {
  override name = "DeviceError";
  readonly code: DeviceErrorCode;
  constructor(code: DeviceErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface NewDeviceInput {
  readonly name: string;
  readonly kind: "phone" | "pc";
  /** WebAuthn の資格情報の ID（base64url） */
  readonly credentialId: string;
  /** COSE の公開鍵（base64url） */
  readonly publicKey: string;
  readonly signCount: number;
}

export function toDeviceView(d: Device): DeviceView {
  return {
    id: d.id,
    name: d.name,
    kind: d.kind,
    created_at: d.createdAt,
    revoked_at: d.revokedAt,
  };
}

export function getDevice(db: StateDb, id: string): Device | undefined {
  if (!isId(id, "device")) return undefined;
  return db.orm.select().from(devices).where(eq(devices.id, id)).get();
}

/** 有効な端末だけを返す（取り消した端末は undefined） */
export function getActiveDevice(db: StateDb, id: string): Device | undefined {
  const d = getDevice(db, id);
  return d !== undefined && d.revokedAt === null ? d : undefined;
}

/** 作った順（同じ時刻なら ID の順）。取り消したものも含む */
export function listDevices(db: StateDb): Device[] {
  return db.orm.select().from(devices).orderBy(asc(devices.createdAt), asc(devices.id)).all();
}

export function activeDevices(db: StateDb): Device[] {
  return db.orm
    .select()
    .from(devices)
    .where(isNull(devices.revokedAt))
    .orderBy(asc(devices.createdAt), asc(devices.id))
    .all();
}

export function activeDeviceByCredential(db: StateDb, credentialId: string): Device | undefined {
  return db.orm
    .select()
    .from(devices)
    .where(and(eq(devices.webauthnCredentialId, credentialId), isNull(devices.revokedAt)))
    .get();
}

/** 資格情報の ID がすでに使われているか（取り消した端末のものも含む） */
export function credentialInUse(db: StateDb, credentialId: string): boolean {
  return (
    db.orm
      .select({ id: devices.id })
      .from(devices)
      .where(eq(devices.webauthnCredentialId, credentialId))
      .get() !== undefined
  );
}

/** 端末を作り、監査ログ `device.state`（null → active）を書く */
export function addDevice(db: StateDb, input: NewDeviceInput, by: AuditActor): Device {
  const name = normalizeDeviceName(input.name);
  if (name === null) {
    throw new DeviceError(
      "invalid_name",
      `端末の名前は1〜${MAX_DEVICE_NAME_CHARS}文字で、改行や制御文字を含めないでください`,
    );
  }
  if (!Number.isInteger(input.signCount) || input.signCount < 0) {
    throw new RangeError("signCount は0以上の整数にしてください");
  }
  return writeTransaction(db, () => {
    if (credentialInUse(db, input.credentialId)) {
      throw new DeviceError(
        "duplicate_credential",
        "このパスキーは、すでにほかの端末として登録されています",
      );
    }
    const row: Device = {
      id: newId("device", db.now().getTime()),
      name,
      kind: input.kind,
      x25519PublicKey: null,
      webauthnCredentialId: input.credentialId,
      webauthnPublicKey: input.publicKey,
      signCount: input.signCount,
      createdAt: db.now().toISOString(),
      revokedAt: null,
    };
    db.orm.insert(devices).values(row).run();
    appendAudit(db, {
      actor: by,
      kind: "device.state",
      subject: row.id,
      data: { from: null, to: "active", by },
    });
    return row;
  });
}

/** 端末を取り消し、監査ログ `device.state`（active → revoked）を書く */
export function revokeDevice(db: StateDb, id: string, by: AuditActor): Device {
  return writeTransaction(db, () => {
    const d = getDevice(db, id);
    if (d === undefined) throw new DeviceError("not_found", "その端末はありません");
    if (d.revokedAt !== null) {
      throw new DeviceError("revoked", "その端末は、すでに取り消されています");
    }
    const revokedAt = db.now().toISOString();
    db.orm
      .update(devices)
      .set({ revokedAt })
      .where(and(eq(devices.id, id), isNull(devices.revokedAt)))
      .run();
    appendAudit(db, {
      actor: by,
      kind: "device.state",
      subject: id,
      data: { from: "active", to: "revoked", by },
    });
    return { ...d, revokedAt };
  });
}

/**
 * 署名カウンターを `expected` から `next` にする（有効な端末で、値が `expected` のときだけ）。
 * 変えたら true。ほかで先に使われた・取り消した端末なら false（呼ぶ側は拒否する）
 */
export function advanceSignCount(db: StateDb, id: string, expected: number, next: number): boolean {
  const result = db.orm
    .update(devices)
    .set({ signCount: next })
    .where(and(eq(devices.id, id), eq(devices.signCount, expected), isNull(devices.revokedAt)))
    .run();
  return result.changes === 1;
}
