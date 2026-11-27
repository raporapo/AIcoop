import { beforeEach, describe, expect, it } from "vitest";
import { listAuditLog, verifyAuditLog } from "../db/audit.ts";
import type { StateDb } from "../db/open.ts";
import { type FakeClock, memoryDb } from "../testing/state-db.ts";
import {
  activeDeviceByCredential,
  addDevice,
  advanceSignCount,
  DeviceError,
  getDevice,
  listDevices,
  revokeDevice,
  toDeviceView,
} from "./devices.ts";

let db: StateDb;
let clock: FakeClock;
beforeEach(() => {
  ({ db, clock } = memoryDb());
});

const input = (over: Partial<Parameters<typeof addDevice>[1]> = {}) => ({
  name: "仕事のPC",
  kind: "pc" as const,
  credentialId: "Y3JlZGVudGlhbC0x",
  publicKey: "cHVibGljLWtleQ",
  signCount: 0,
  ...over,
});

describe("7.2 devices：端末の作成・一覧", () => {
  it("作ると d_ の ID と created_at が付き、監査ログ device.state（null → active）を同じトランザクションで書く", () => {
    const d = addDevice(db, input(), "owner:cli");
    expect(d.id).toMatch(/^d_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(d.createdAt).toBe("2026-11-28T00:00:00.000Z");
    expect(d.revokedAt).toBeNull();
    expect(d.x25519PublicKey).toBeNull();
    const audit = listAuditLog(db).filter((r) => r.kind === "device.state");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.subject).toBe(d.id);
    expect(audit[0]?.actor).toBe("owner:cli");
    expect(JSON.parse(audit[0]?.data ?? "")).toEqual({ from: null, to: "active", by: "owner:cli" });
    expect(verifyAuditLog(db).ok).toBe(true);
  });

  it("一覧は作った順で、取り消したものも含む。API の形には鍵を出さない", () => {
    const a = addDevice(db, input({ name: "A", credentialId: "QQ" }), "owner:cli");
    clock.advance(1000);
    const b = addDevice(db, input({ name: "B", credentialId: "Qg" }), "owner:cli");
    revokeDevice(db, a.id, "owner:cli");
    expect(listDevices(db).map((d) => d.name)).toEqual(["A", "B"]);
    const view = toDeviceView(getDevice(db, b.id) as never);
    expect(view).toEqual({
      id: b.id,
      name: "B",
      kind: "pc",
      created_at: "2026-11-28T00:00:01.000Z",
      revoked_at: null,
    });
    expect(JSON.stringify(view)).not.toContain("Qg");
  });

  it("拒否：名前が空・41文字以上・制御文字・書式文字・改行を含むものは作らない", () => {
    for (const name of ["", "   ", "あ".repeat(41), "a\nb", "a\u0000b", "a\u202eb", "a\u200bb"]) {
      expect(() => addDevice(db, input({ name }), "owner:cli"), JSON.stringify(name)).toThrow(
        DeviceError,
      );
    }
    expect(listDevices(db)).toHaveLength(0);
    expect(listAuditLog(db)).toHaveLength(0);
  });

  it("拒否：同じパスキー（資格情報の ID）の端末は2つ作れない", () => {
    addDevice(db, input(), "owner:cli");
    expect(() => addDevice(db, input({ name: "別の名前" }), "owner:cli")).toThrow(DeviceError);
    expect(listDevices(db)).toHaveLength(1);
    expect(listAuditLog(db).filter((r) => r.kind === "device.state")).toHaveLength(1);
  });
});

describe("T-12：端末の取り消し", () => {
  it("取り消すと revoked_at が入り、監査ログ device.state（active → revoked）と、取り消した者を書く", () => {
    const d = addDevice(db, input(), "owner:cli");
    clock.advance(5000);
    const revoked = revokeDevice(db, d.id, "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB");
    expect(revoked.revokedAt).toBe("2026-11-28T00:00:05.000Z");
    const last = listAuditLog(db).at(-1);
    expect(last?.kind).toBe("device.state");
    expect(last?.actor).toBe("owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB");
    expect(JSON.parse(last?.data ?? "")).toEqual({
      from: "active",
      to: "revoked",
      by: "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
    });
  });

  it("取り消した端末は、資格情報の ID から「有効な端末」として見つからない", () => {
    const d = addDevice(db, input(), "owner:cli");
    expect(activeDeviceByCredential(db, d.webauthnCredentialId)?.id).toBe(d.id);
    revokeDevice(db, d.id, "owner:cli");
    expect(activeDeviceByCredential(db, d.webauthnCredentialId)).toBeUndefined();
  });

  it("拒否：ない端末・すでに取り消した端末は取り消せない（監査ログも書かない）", () => {
    const d = addDevice(db, input(), "owner:cli");
    revokeDevice(db, d.id, "owner:cli");
    const before = listAuditLog(db).length;
    expect(() => revokeDevice(db, d.id, "owner:cli")).toThrow(DeviceError);
    expect(() => revokeDevice(db, "d_01JD6V8X3S0Q5W7KQ9M2T4R6YB", "owner:cli")).toThrow(
      DeviceError,
    );
    expect(() => revokeDevice(db, "x", "owner:cli")).toThrow(DeviceError);
    expect(listAuditLog(db)).toHaveLength(before);
  });
});

describe("7.2 devices.sign_count：署名カウンターの更新", () => {
  it("前の値が合っているときだけ、新しい値にする", () => {
    const d = addDevice(db, input({ signCount: 3 }), "owner:cli");
    expect(advanceSignCount(db, d.id, 3, 4)).toBe(true);
    expect(getDevice(db, d.id)?.signCount).toBe(4);
  });

  it("拒否：前の値が違う（ほかで先に使われた）・取り消した端末なら変えない", () => {
    const d = addDevice(db, input({ signCount: 3 }), "owner:cli");
    expect(advanceSignCount(db, d.id, 2, 4)).toBe(false);
    expect(getDevice(db, d.id)?.signCount).toBe(3);
    revokeDevice(db, d.id, "owner:cli");
    expect(advanceSignCount(db, d.id, 3, 4)).toBe(false);
    expect(getDevice(db, d.id)?.signCount).toBe(3);
  });
});
