import { canonicalJson } from "@aicoop/shared";
import type { ApprovalIntentResponse, ApprovalPayload } from "@aicoop/shared/api";
import { beforeEach, describe, expect, it } from "vitest";
import { listAuditLog, verifyAuditLog } from "../db/audit.ts";
import { approvals, usedNonces } from "../db/schema.ts";
import {
  type ApprovalHarness,
  approvalHarness,
  fakeTarget,
  TEST_COMPANY,
} from "../testing/approvals.ts";
import {
  type CeremonyOverrides,
  otherPrivateKey,
  type SoftAuthenticator,
  softAuthenticator,
} from "../testing/webauthn.ts";
import { getDevice } from "./devices.ts";
import { ApprovalFailure } from "./errors.ts";
import { APPROVAL_TTL_MS } from "./sign.ts";
import { base64url, sha256, sha256Hex } from "./webauthn.ts";

let h: ApprovalHarness;
let auth: SoftAuthenticator;
let deviceId: string;
beforeEach(async () => {
  h = approvalHarness();
  ({ auth, deviceId } = await h.pairDevice());
});

async function failure(p: Promise<unknown>): Promise<ApprovalFailure> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApprovalFailure);
  return error as ApprovalFailure;
}

function intent(id: string, decision: "approve" | "reject" = "approve", device = deviceId) {
  return h.service.signer.intent(device, { type: "hold", id, decision });
}

function sign(res: ApprovalIntentResponse, over: CeremonyOverrides = {}, by = auth) {
  return by.getAssertion(res.options as never, over);
}

const approvalRows = () => h.db.orm.select().from(approvals).all();
const nonceRows = () => h.db.orm.select().from(usedNonces).all();

describe("5.8 の3の2〜3：承認の意思（approval_intent）と payload", () => {
  it("payload は 5.8 の形。summary_sha256 は要約の正規化JSON の SHA-256、期限は2分、nonce は128ビット", async () => {
    const summary = { kind: "gmail_message", to: ["a@example.com"], subject: "見積もり", n: 1 };
    const id = h.hold.add(summary);
    const res = await intent(id, "reject");
    const now = h.clock.now();
    expect(res.payload).toEqual({
      type: "hold",
      id,
      decision: "reject",
      company_id: TEST_COMPANY.id,
      summary_sha256: sha256Hex(canonicalJson(summary)),
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
    });
    expect(Buffer.from(res.payload.nonce, "base64url")).toHaveLength(16);
    expect((await intent(id)).payload.nonce).not.toBe(res.payload.nonce);
  });

  it("チャレンジは payload の正規化JSON の SHA-256（base64url）。allowCredentials はログイン中の端末のパスキーだけ、UV 必須", async () => {
    await h.pairDevice("もう1台");
    const id = h.hold.add();
    const res = await intent(id);
    expect(res.options).toMatchObject({
      rpId: "localhost",
      challenge: base64url(sha256(canonicalJson(res.payload))),
      userVerification: "required",
      timeout: APPROVAL_TTL_MS,
    });
    expect((res.options as { allowCredentials: { id: string }[] }).allowCredentials).toEqual([
      expect.objectContaining({ id: auth.credentialId }),
    ]);
  });

  it("拒否：対象がない・オーナーの承認を待っていない・知らない種類・この種類の対象が登録されていない", async () => {
    expect((await failure(intent("h_01JD6V8X3S0Q5W7KQ9M2T4R6YB"))).status).toBe(404);
    const managed = h.hold.add(undefined, "pending_manager");
    expect((await failure(intent(managed))).code).toBe("not_pending");
    const done = h.hold.add(undefined, "approved");
    expect((await failure(intent(done))).code).toBe("not_pending");
    const id = h.hold.add();
    const grant = await failure(
      h.service.signer.intent(deviceId, { type: "grant", id, decision: "approve" }),
    );
    expect(grant.status).toBe(404);
    for (const body of [
      { type: "nope", id, decision: "approve" },
      { type: "hold", id, decision: "maybe" },
      { type: "hold", id: "", decision: "approve" },
      { type: "hold", id: `${id}\n`, decision: "approve" },
      { type: "hold", id, decision: "approve", extra: 1 },
      { type: "hold", id },
      null,
    ]) {
      expect(
        (await failure(h.service.signer.intent(deviceId, body))).code,
        JSON.stringify(body),
      ).toBe("invalid_input");
    }
  });
});

describe("5.8 の3の6：署名を確かめて、決定を効力を持たせる", () => {
  it("承認：approvals に記録し、used_nonces に入れ、監査ログ approval → 対象の状態の変化の順に書き、afterApply を呼ぶ", async () => {
    const id = h.hold.add();
    const res = await intent(id);
    const out = await h.service.signer.assert(deviceId, {
      payload: res.payload,
      response: sign(res),
    });
    expect(out.subject_status).toBe("approved");
    expect(out.approval).toMatchObject({
      id: expect.stringMatching(/^a_/),
      subject_type: "hold",
      subject_id: id,
      decision: "approve",
      device_id: deviceId,
      verified_at: h.clock.now().toISOString(),
    });
    const rows = approvalRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.payload ?? "")).toEqual(res.payload);
    expect(rows[0]?.payload).toBe(canonicalJson(res.payload));
    expect(JSON.parse(rows[0]?.assertion ?? "")).toHaveProperty("response.signature");
    expect(nonceRows()).toEqual([{ nonce: res.payload.nonce, expiresAt: res.payload.expires_at }]);
    const kinds = listAuditLog(h.db).map((r) => [r.kind, r.subject, r.actor]);
    expect(kinds.slice(-2)).toEqual([
      ["approval", id, `owner:${deviceId}`],
      ["hold.state", id, `owner:${deviceId}`],
    ]);
    const approvalAudit = listAuditLog(h.db).find((r) => r.kind === "approval");
    expect(JSON.parse(approvalAudit?.data ?? "")).toEqual({
      subject_type: "hold",
      decision: "approve",
      device_id: deviceId,
    });
    expect(verifyAuditLog(h.db).ok).toBe(true);
    expect(h.hold.applied).toEqual([{ id, decision: "approve", by: `owner:${deviceId}` }]);
    await h.service.drain();
    expect(h.hold.afterApplied).toEqual([{ id, decision: "approve" }]);
    expect(getDevice(h.db, deviceId)?.signCount).toBe(1);
  });

  it("5.8 の3：却下も署名で行う（署名がなければ却下も効かない）", async () => {
    const id = h.hold.add();
    const res = await intent(id, "reject");
    const out = await h.service.signer.assert(deviceId, {
      payload: res.payload,
      response: sign(res),
    });
    expect(out.subject_status).toBe("rejected");
    expect(approvalRows()[0]?.decision).toBe("reject");

    const other = h.hold.add();
    const bad = await intent(other, "reject");
    await failure(
      h.service.signer.assert(deviceId, {
        payload: bad.payload,
        response: sign(bad, { signWith: otherPrivateKey() }),
      }),
    );
    expect(h.hold.items.get(other)?.status).toBe("pending_owner");
  });

  describe("受け入れ条件（5.8）", () => {
    it("中継で payload を書き換えると、PC が承認を拒否する（どの欄でも）", async () => {
      const id = h.hold.add();
      const other = h.hold.add();
      const edits: Array<[string, (p: ApprovalPayload) => Record<string, unknown>]> = [
        ["決定を変える", (p) => ({ ...p, decision: "reject" })],
        ["対象を変える", (p) => ({ ...p, id: other })],
        ["種類を変える", (p) => ({ ...p, type: "grant" })],
        ["会社を変える", (p) => ({ ...p, company_id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YC" })],
        ["要約のハッシュを変える", (p) => ({ ...p, summary_sha256: "0".repeat(64) })],
        ["期限を延ばす", (p) => ({ ...p, expires_at: "2099-01-01T00:00:00.000Z" })],
        ["発行の時刻を変える", (p) => ({ ...p, issued_at: "2026-11-27T00:00:00.000Z" })],
        ["欄を足す", (p) => ({ ...p, extra: "x" })],
        ["欄を消す", ({ summary_sha256: _, ...p }) => p],
        ["型を変える（数値の文字列）", (p) => ({ ...p, issued_at: Date.parse(p.issued_at) })],
      ];
      for (const [label, edit] of edits) {
        const res = await intent(id);
        // 署名は本物のチャレンジ（書き換える前の payload）に対して行われている
        const response = sign(res);
        const e = await failure(
          h.service.signer.assert(deviceId, { payload: edit(res.payload), response }),
        );
        expect(e.code, label).toBe("payload_mismatch");
      }
      // 書き換えた payload から作ったチャレンジに署名させても通らない（daemon が出したものではない）
      const res = await intent(id);
      const forged = { ...res.payload, decision: "reject" as const };
      const forgedOptions = {
        ...res.options,
        challenge: base64url(sha256(canonicalJson(forged))),
      };
      const e = await failure(
        h.service.signer.assert(deviceId, {
          payload: forged,
          response: auth.getAssertion(forgedOptions as never),
        }),
      );
      expect(e.code).toBe("payload_mismatch");
      expect(approvalRows()).toHaveLength(0);
      expect(h.hold.items.get(id)?.status).toBe("pending_owner");
      expect(h.hold.items.get(other)?.status).toBe("pending_owner");
    });

    it("一度使った署名を送り直すと、PC が拒否する（nonce_used）", async () => {
      const id = h.hold.add();
      const res = await intent(id);
      const body = { payload: res.payload, response: sign(res) };
      await h.service.signer.assert(deviceId, body);
      const e = await failure(h.service.signer.assert(deviceId, body));
      expect(e.code).toBe("nonce_used");
      expect(e.status).toBe(409);
      expect(approvalRows()).toHaveLength(1);
      expect(h.hold.applied).toHaveLength(1);
    });

    it("一度使った署名の送り直しは、カウンターを数えない認証器でも拒否する", async () => {
      const counterless = await h.pairDevice("数えない", softAuthenticator({ counterStep: 0 }));
      const id = h.hold.add();
      const res = await intent(id, "approve", counterless.deviceId);
      const body = { payload: res.payload, response: sign(res, {}, counterless.auth) };
      await h.service.signer.assert(counterless.deviceId, body);
      const e = await failure(h.service.signer.assert(counterless.deviceId, body));
      expect(e.code).toBe("nonce_used");
      expect(approvalRows()).toHaveLength(1);
    });

    it("期限（2分）を過ぎた署名は、PC が拒否する", async () => {
      const id = h.hold.add();
      const res = await intent(id);
      const response = sign(res);
      h.clock.advance(APPROVAL_TTL_MS + 1);
      const e = await failure(
        h.service.signer.assert(deviceId, { payload: res.payload, response }),
      );
      expect(e.code).toBe("approval_expired");
      expect(approvalRows()).toHaveLength(0);
      expect(h.hold.items.get(id)?.status).toBe("pending_owner");
    });

    it("期限ちょうど（2分）までは受ける", async () => {
      const id = h.hold.add();
      const res = await intent(id);
      const response = sign(res);
      h.clock.advance(APPROVAL_TTL_MS);
      await expect(
        h.service.signer.assert(deviceId, { payload: res.payload, response }),
      ).resolves.toHaveProperty("subject_status", "approved");
    });
  });

  it("拒否：署名の確かめに通らない（ほかの鍵・書き換え・オリジン違い・RP ID 違い・UV なし・UP なし・チャレンジ違い・iframe の中）", async () => {
    const cases: Array<[string, CeremonyOverrides]> = [
      ["ほかの鍵", { signWith: otherPrivateKey() }],
      ["署名の書き換え", { tamperSignature: true }],
      ["オリジン違い", { origin: "http://localhost:7071" }],
      ["オリジン違い（127.0.0.1）", { origin: "http://127.0.0.1:7070" }],
      ["RP ID 違い", { rpId: "relay.example" }],
      ["UV なし", { uv: false }],
      ["UP なし", { up: false }],
      ["チャレンジ違い", { challenge: base64url(sha256("x")) }],
      ["iframe の中", { crossOrigin: true }],
    ];
    for (const [label, over] of cases) {
      const id = h.hold.add();
      const res = await intent(id);
      const e = await failure(
        h.service.signer.assert(deviceId, { payload: res.payload, response: sign(res, over) }),
      );
      expect(e.code, label).toBe("signature_invalid");
      expect(h.hold.items.get(id)?.status, label).toBe("pending_owner");
    }
    expect(approvalRows()).toHaveLength(0);
    expect(nonceRows()).toHaveLength(0);
    expect(getDevice(h.db, deviceId)?.signCount).toBe(0);
  });

  it("拒否：失敗した payload は捨てる（正しい署名でも、同じ payload ではもう通らない）", async () => {
    const id = h.hold.add();
    const res = await intent(id);
    await failure(
      h.service.signer.assert(deviceId, {
        payload: res.payload,
        response: sign(res, { tamperSignature: true }),
      }),
    );
    const e = await failure(
      h.service.signer.assert(deviceId, { payload: res.payload, response: sign(res) }),
    );
    expect(e.code).toBe("payload_mismatch");
    expect(h.hold.items.get(id)?.status).toBe("pending_owner");
  });

  it("拒否：カウンターが増えない署名", async () => {
    const id = h.hold.add();
    const first = await intent(id);
    await h.service.signer.assert(deviceId, { payload: first.payload, response: sign(first) });
    const next = h.hold.add();
    const res = await intent(next);
    const e = await failure(
      h.service.signer.assert(deviceId, {
        payload: res.payload,
        response: sign(res, { counter: 1 }),
      }),
    );
    expect(e.code).toBe("signature_invalid");
    expect(h.hold.items.get(next)?.status).toBe("pending_owner");
  });

  it("拒否：別の端末（ほかの端末に出した payload・ほかの端末のパスキーでの署名）", async () => {
    const other = await h.pairDevice("もう1台");
    const id = h.hold.add();
    // other に出した payload を、この端末のセッションで送る
    const forOther = await intent(id, "approve", other.deviceId);
    const e1 = await failure(
      h.service.signer.assert(deviceId, {
        payload: forOther.payload,
        response: other.auth.getAssertion(forOther.options as never),
      }),
    );
    expect(e1.code).toBe("payload_mismatch");
    // この端末に出した payload に、ほかの端末のパスキーで署名する
    const mine = await intent(id);
    const e2 = await failure(
      h.service.signer.assert(deviceId, {
        payload: mine.payload,
        response: other.auth.getAssertion(mine.options as never, { ignoreCredentialLists: true }),
      }),
    );
    expect(e2.code).toBe("signature_invalid");
    // ほかの端末の鍵で、この端末の資格情報を名乗る
    const mine2 = await intent(id);
    const e3 = await failure(
      h.service.signer.assert(deviceId, {
        payload: mine2.payload,
        response: other.auth.getAssertion(mine2.options as never, {
          ignoreCredentialLists: true,
          responseId: auth.credentialId,
        }),
      }),
    );
    expect(e3.code).toBe("signature_invalid");
    expect(h.hold.items.get(id)?.status).toBe("pending_owner");
  });

  it("T-12：取り消した端末は、出してあった payload にも署名できない", async () => {
    const id = h.hold.add();
    const res = await intent(id);
    const response = sign(res);
    h.service.revokeDevice(deviceId, "owner:cli");
    const e = await failure(h.service.signer.assert(deviceId, { payload: res.payload, response }));
    expect(["payload_mismatch", "signature_invalid"]).toContain(e.code);
    expect(h.hold.items.get(id)?.status).toBe("pending_owner");
    expect(approvalRows()).toHaveLength(0);
    // 取り消した端末には、新しい payload も出さない
    const again = await failure(intent(id));
    expect(again.status).toBeGreaterThanOrEqual(400);
  });

  it("拒否：署名のあいだに対象が決まった（not_pending）・要約が変わった（payload_mismatch）", async () => {
    const id = h.hold.add();
    const res = await intent(id);
    const response = sign(res);
    (h.hold.items.get(id) as { status: string }).status = "expired";
    const e = await failure(h.service.signer.assert(deviceId, { payload: res.payload, response }));
    expect(e.code).toBe("not_pending");

    const changed = h.hold.add({ to: ["a@example.com"] });
    const r2 = await intent(changed);
    const s2 = sign(r2);
    (h.hold.items.get(changed) as { summary: unknown }).summary = { to: ["evil@example.com"] };
    const e2 = await failure(
      h.service.signer.assert(deviceId, { payload: r2.payload, response: s2 }),
    );
    expect(e2.code).toBe("payload_mismatch");
    expect(approvalRows()).toHaveLength(0);
    expect(nonceRows()).toHaveLength(0);
  });

  it("拒否：apply の中で失敗したら、approvals・used_nonces・監査ログ・カウンターをすべて巻き戻す", async () => {
    const id = h.hold.add();
    const res = await intent(id);
    const before = listAuditLog(h.db).length;
    h.hold.failApply = true;
    await expect(
      h.service.signer.assert(deviceId, { payload: res.payload, response: sign(res) }),
    ).rejects.toThrow();
    expect(approvalRows()).toHaveLength(0);
    expect(nonceRows()).toHaveLength(0);
    expect(listAuditLog(h.db)).toHaveLength(before);
    expect(getDevice(h.db, deviceId)?.signCount).toBe(0);
    expect(h.hold.afterApplied).toHaveLength(0);
  });

  it("拒否：形の違う本文", async () => {
    const id = h.hold.add();
    const res = await intent(id);
    for (const body of [
      null,
      {},
      { payload: res.payload },
      { response: sign(res) },
      { payload: "x", response: {} },
      { payload: res.payload, response: sign(res), extra: 1 },
    ]) {
      const e = await failure(h.service.signer.assert(deviceId, body));
      expect(e.status, JSON.stringify(body)?.slice(0, 40)).toBe(400);
    }
    expect(approvalRows()).toHaveLength(0);
  });

  it("used_nonces は、期限を過ぎたものを消す", async () => {
    const a = h.hold.add();
    const ra = await intent(a);
    await h.service.signer.assert(deviceId, { payload: ra.payload, response: sign(ra) });
    expect(nonceRows()).toHaveLength(1);
    h.clock.advance(APPROVAL_TTL_MS + 1);
    const b = h.hold.add();
    const rb = await intent(b);
    await h.service.signer.assert(deviceId, { payload: rb.payload, response: sign(rb) });
    expect(nonceRows().map((r) => r.nonce)).toEqual([rb.payload.nonce]);
  });

  it("afterApply の失敗は、承認の記録を消さない", async () => {
    const target = fakeTarget(h.db);
    target.afterApply = async () => {
      throw new Error("再送に失敗");
    };
    h.targets.hold = target;
    const id = target.add();
    const res = await intent(id);
    await h.service.signer.assert(deviceId, { payload: res.payload, response: sign(res) });
    await h.service.drain();
    expect(approvalRows()).toHaveLength(1);
    expect(target.items.get(id)?.status).toBe("approved");
  });
});
