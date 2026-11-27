import { beforeEach, describe, expect, it } from "vitest";
import { type ApprovalHarness, approvalHarness } from "../testing/approvals.ts";
import { type CeremonyOverrides, otherPrivateKey, softAuthenticator } from "../testing/webauthn.ts";
import { getDevice } from "./devices.ts";
import { ApprovalFailure } from "./errors.ts";
import { LOGIN_CHALLENGE_TTL_MS } from "./login.ts";
import { SESSION_TTL_MS } from "./sessions.ts";

let h: ApprovalHarness;
beforeEach(() => {
  h = approvalHarness();
});

async function failure(p: Promise<unknown>): Promise<ApprovalFailure> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApprovalFailure);
  return error as ApprovalFailure;
}

describe("9.2：パスキーでのログイン（承認アプリ）", () => {
  it("有効な端末のパスキーだけを allowCredentials に入れ、UV 必須・チャレンジは2分", async () => {
    const a = await h.pairDevice("A");
    const b = await h.pairDevice("B");
    h.service.revokeDevice(b.deviceId, "owner:cli");
    const { options } = await h.service.login.options();
    expect(options).toMatchObject({ rpId: "localhost", userVerification: "required" });
    expect((options as { timeout: number }).timeout).toBe(LOGIN_CHALLENGE_TTL_MS);
    expect((options as { allowCredentials: { id: string }[] }).allowCredentials).toEqual([
      expect.objectContaining({ id: a.auth.credentialId }),
    ]);
  });

  it("署名が通ればセッションを作り、署名カウンターを保存する。セッションから端末が分かる", async () => {
    const { auth, deviceId } = await h.pairDevice();
    const token = await h.login(auth);
    expect(getDevice(h.db, deviceId)?.signCount).toBe(1);
    const session = h.service.sessionFor(token);
    expect(session?.device.id).toBe(deviceId);
    expect(session?.expiresAt.toISOString()).toBe(
      new Date(h.clock.now().getTime() + SESSION_TTL_MS).toISOString(),
    );
  });

  it("拒否：端末がないときは options を出さない（409）", async () => {
    const e = await failure(h.service.login.options());
    expect(e.status).toBe(409);
  });

  it("拒否：偽造・オリジン違い・RP ID 違い・UV なし・チャレンジ違い・iframe の中（セッションを作らない）", async () => {
    const { auth, deviceId } = await h.pairDevice();
    const cases: Array<[string, CeremonyOverrides]> = [
      ["ほかの鍵", { signWith: otherPrivateKey() }],
      ["署名の書き換え", { tamperSignature: true }],
      ["オリジン違い", { origin: "http://localhost:3000" }],
      ["RP ID 違い", { rpId: "evil.example" }],
      ["UV なし", { uv: false }],
      ["チャレンジ違い", { challenge: "AAAA" }],
      ["iframe の中", { crossOrigin: true }],
    ];
    for (const [label, over] of cases) {
      const { options } = await h.service.login.options();
      const response = auth.getAssertion(options as never, over);
      const e = await failure(h.service.login.verify({ response }));
      expect(e.code, label).toBe("signature_invalid");
    }
    // 失敗では、カウンターを進めない
    expect(getDevice(h.db, deviceId)?.signCount).toBe(0);
  });

  it("拒否：同じログインの署名を2回送る（チャレンジは1回限り）", async () => {
    const { auth } = await h.pairDevice();
    const { options } = await h.service.login.options();
    const response = auth.getAssertion(options as never);
    await h.service.login.verify({ response });
    const e = await failure(h.service.login.verify({ response }));
    expect(e.code).toBe("signature_invalid");
  });

  it("拒否：カウンターを数えない認証器でも、同じログインの署名は2回使えない", async () => {
    const { auth } = await h.pairDevice("数えない", softAuthenticator({ counterStep: 0 }));
    const { options } = await h.service.login.options();
    const response = auth.getAssertion(options as never);
    await h.service.login.verify({ response });
    const e = await failure(h.service.login.verify({ response }));
    expect(e.code).toBe("signature_invalid");
  });

  it("拒否：チャレンジの期限（2分）を過ぎた", async () => {
    const { auth } = await h.pairDevice();
    const { options } = await h.service.login.options();
    const response = auth.getAssertion(options as never);
    h.clock.advance(LOGIN_CHALLENGE_TTL_MS + 1);
    expect((await failure(h.service.login.verify({ response }))).code).toBe("signature_invalid");
  });

  it("拒否：取り消した端末・登録していないパスキー", async () => {
    const { auth, deviceId } = await h.pairDevice();
    const stranger = softAuthenticator();
    const { options } = await h.service.login.options();
    const response = stranger.getAssertion(options as never, { ignoreCredentialLists: true });
    expect((await failure(h.service.login.verify({ response }))).code).toBe("signature_invalid");

    h.service.revokeDevice(deviceId, "owner:cli");
    await h.pairDevice("もう1台");
    const again = await h.service.login.options();
    const revoked = auth.getAssertion(again.options as never, { ignoreCredentialLists: true });
    expect((await failure(h.service.login.verify({ response: revoked }))).code).toBe(
      "signature_invalid",
    );
  });

  it("拒否：カウンターが増えない（複製された認証器の疑い）", async () => {
    const { auth } = await h.pairDevice();
    await h.login(auth);
    await h.login(auth);
    const { options } = await h.service.login.options();
    const response = auth.getAssertion(options as never, { counter: 1 });
    expect((await failure(h.service.login.verify({ response }))).code).toBe("signature_invalid");
  });

  it("拒否：形の違う本文（response がない・知らないキー）", async () => {
    for (const body of [{}, { response: "x" }, { response: {}, extra: 1 }, null, []]) {
      const e = await failure(h.service.login.verify(body));
      expect(e.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("9.2：セッション（サーバーはトークンのハッシュだけを持つ）", () => {
  it("期限を過ぎたセッションは使えない", async () => {
    const { auth } = await h.pairDevice();
    const token = await h.login(auth);
    h.clock.advance(SESSION_TTL_MS - 1);
    expect(h.service.sessionFor(token)).toBeDefined();
    h.clock.advance(1);
    expect(h.service.sessionFor(token)).toBeUndefined();
  });

  it("ログアウトしたセッションは使えない", async () => {
    const { auth } = await h.pairDevice();
    const token = await h.login(auth);
    h.service.logout(token);
    expect(h.service.sessionFor(token)).toBeUndefined();
  });

  it("T-12：端末を取り消すと、その端末のセッションはすぐ使えなくなる（ほかの端末のものは残る）", async () => {
    const a = await h.pairDevice("A");
    const b = await h.pairDevice("B");
    const ta = await h.login(a.auth);
    const tb = await h.login(b.auth);
    h.service.revokeDevice(a.deviceId, "owner:cli");
    expect(h.service.sessionFor(ta)).toBeUndefined();
    expect(h.service.sessionFor(tb)?.device.id).toBe(b.deviceId);
  });

  it("拒否：知らないトークン・形の違うトークン・トークンの一部", async () => {
    const { auth } = await h.pairDevice();
    const token = await h.login(auth);
    for (const bad of ["", "x", token.slice(0, -1), `${token}x`, token.toUpperCase(), undefined]) {
      expect(h.service.sessionFor(bad), String(bad)).toBeUndefined();
    }
  });
});
