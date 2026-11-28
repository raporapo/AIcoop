import { afterEach, describe, expect, test, vi } from "vitest";
import { installFakeWebAuthn, removeWebAuthn } from "../testing/webauthn.ts";
import { createPasskeys, PasskeyFailure, passkeyMessage } from "./passkeys.ts";

const REQUEST = {
  challenge: "AAECAwQFBgcICQoLDA0ODw",
  rpId: "localhost",
  allowCredentials: [{ id: "Y3JlZC0x", type: "public-key" }],
  timeout: 60_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("パスキーの呼び出し（5.8 の2・3。userVerification は必ず required）", () => {
  test("署名では、受け取ったチャレンジと資格情報だけを navigator.credentials.get に渡す", async () => {
    const fake = installFakeWebAuthn();
    const passkeys = createPasskeys();
    const res = await passkeys.authenticate({ ...REQUEST, userVerification: "preferred" });
    expect(fake.getCalls).toEqual([
      {
        challenge: "AAECAwQFBgcICQoLDA0ODw",
        allowCredentials: ["Y3JlZC0x"],
        userVerification: "required",
        rpId: "localhost",
      },
    ]);
    expect(res).toMatchObject({ id: "cred-1", type: "public-key" });
  });

  test("登録でも本人確認を required にする", async () => {
    const fake = installFakeWebAuthn();
    await createPasskeys().register({
      challenge: "AAEC",
      rp: { id: "localhost", name: "AIcoop" },
      user: { id: "b3duZXI", name: "owner", displayName: "オーナー" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { userVerification: "discouraged" },
    });
    expect(fake.createCalls[0]?.userVerification).toBe("required");
  });

  test("パスキーが使えないブラウザ", async () => {
    removeWebAuthn();
    const passkeys = createPasskeys();
    expect(passkeys.supported()).toBe(false);
    const err = await passkeys.authenticate(REQUEST).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PasskeyFailure);
    expect((err as PasskeyFailure).kind).toBe("unsupported");
    expect(passkeyMessage(err as PasskeyFailure, "login")).toContain(
      "パスキー（WebAuthn）に対応していません",
    );
  });

  test("取り消した操作と、時間切れを分けて言う", async () => {
    const fake = installFakeWebAuthn();
    let t = 0;
    const passkeys = createPasskeys(() => t);

    fake.failNextGet("NotAllowedError");
    const cancelled = (await passkeys
      .authenticate(REQUEST)
      .catch((e: unknown) => e)) as PasskeyFailure;
    expect(cancelled.kind).toBe("cancelled");
    expect(passkeyMessage(cancelled, "approve")).toBe(
      "パスキーの操作が取り消されました（または時間切れになりました）。決定は効いていません",
    );
    expect(passkeyMessage(cancelled, "login")).toContain("aicoop pair --local");

    fake.failNextGet("NotAllowedError");
    const slow = createPasskeys(() => {
      t += 59_000;
      return t;
    });
    const timedOut = (await slow.authenticate(REQUEST).catch((e: unknown) => e)) as PasskeyFailure;
    expect(timedOut.kind).toBe("timeout");
    expect(passkeyMessage(timedOut, "approve")).toBe(
      "パスキーの操作が時間切れになりました。決定は効いていません",
    );
  });

  test("ほかの失敗：違うアドレス・登録済み・本人確認なし・中止", async () => {
    const fake = installFakeWebAuthn();
    const passkeys = createPasskeys();
    fake.failNextGet("SecurityError");
    const wrong = (await passkeys
      .authenticate({ ...REQUEST, rpId: "example.com" })
      .catch((e: unknown) => e)) as PasskeyFailure;
    expect(wrong.kind).toBe("wrong_origin");
    expect(passkeyMessage(wrong, "login")).toContain("http://localhost:");

    fake.failNextCreate("InvalidStateError");
    const dup = (await passkeys
      .register({
        challenge: "AAEC",
        rp: { id: "localhost", name: "AIcoop" },
        user: { id: "b3duZXI", name: "owner", displayName: "オーナー" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        excludeCredentials: [{ id: "Y3JlZC0x", type: "public-key" }],
      })
      .catch((e: unknown) => e)) as PasskeyFailure;
    expect(dup.kind).toBe("already_registered");

    fake.failNextGet("UnknownError");
    const unknown = (await passkeys
      .authenticate(REQUEST)
      .catch((e: unknown) => e)) as PasskeyFailure;
    expect(unknown.kind).toBe("failed");
    expect(passkeyMessage(unknown, "approve")).toContain("決定は効いていません");
  });
});
