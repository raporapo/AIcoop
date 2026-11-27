import { beforeEach, describe, expect, it } from "vitest";
import { listAuditLog } from "../db/audit.ts";
import { type ApprovalHarness, approvalHarness, TEST_ORIGIN } from "../testing/approvals.ts";
import { softAuthenticator } from "../testing/webauthn.ts";
import { listDevices } from "./devices.ts";
import { ApprovalFailure } from "./errors.ts";
import { confirmCodeFor, PAIRING_MAX_FAILURES, PAIRING_TTL_MS } from "./pairing.ts";

let h: ApprovalHarness;
beforeEach(() => {
  h = approvalHarness();
});

async function failure(p: Promise<unknown> | (() => unknown)): Promise<ApprovalFailure> {
  const run = typeof p === "function" ? Promise.resolve().then(p) : p;
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApprovalFailure);
  return error as ApprovalFailure;
}

describe("5.8 の2：aicoop pair --local の1回限りのコード", () => {
  it("10分で失効するコードを出す。人が打てる形（5文字-5文字、紛らわしい字なし）で、毎回違う", () => {
    const a = h.service.pairing.start();
    expect(a.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(a.expires_at).toBe(new Date(h.clock.now().getTime() + PAIRING_TTL_MS).toISOString());
    expect(a.url).toBe(`${TEST_ORIGIN}/app/#/pair`);
    const codes = new Set(Array.from({ length: 20 }, () => h.service.pairing.start().code));
    expect(codes.size).toBe(20);
  });

  it("状態は waiting → registered（確認コードと端末の名前）→ activated。CLI で y を押すまで端末は有効にならない", async () => {
    const auth = softAuthenticator();
    const { code } = h.service.pairing.start();
    expect(h.service.pairing.status(code)).toMatchObject({
      status: "waiting",
      device_name: null,
      confirm_code: null,
      cancel_reason: null,
    });
    const { options } = await h.service.pairing.options({ code, device_name: " 仕事のPC " });
    expect(options).toMatchObject({
      rp: { id: "localhost" },
      attestation: "none",
      authenticatorSelection: { userVerification: "required" },
    });
    const { confirm_code } = await h.service.pairing.register({
      code,
      response: auth.createCredential(options as never),
    });
    expect(confirm_code).toMatch(/^\d{6}$/);
    expect(h.service.pairing.status(code)).toMatchObject({
      status: "registered",
      device_name: "仕事のPC",
      confirm_code,
    });
    // まだ端末はない（ログインもできない）
    expect(listDevices(h.db)).toHaveLength(0);
    await expect(h.service.login.options()).rejects.toBeInstanceOf(ApprovalFailure);

    const device = h.service.pairing.activate(code);
    expect(device).toMatchObject({ name: "仕事のPC", kind: "pc", revoked_at: null });
    expect(h.service.pairing.status(code).status).toBe("activated");
    expect(listDevices(h.db)).toHaveLength(1);
    const audit = listAuditLog(h.db).filter((r) => r.kind === "device.state");
    expect(audit.map((r) => [r.subject, r.actor])).toEqual([[device.id, "owner:cli"]]);
    // ログインできる
    await expect(h.login(auth)).resolves.toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("コードはハイフン・空白・小文字があっても同じものとして読む", async () => {
    const { code } = h.service.pairing.start();
    const loose = ` ${code.replace("-", " ").toLowerCase()} `;
    await expect(
      h.service.pairing.options({ code: loose, device_name: "PC" }),
    ).resolves.toHaveProperty("options");
  });

  it("確認コードは、パスキーの公開鍵とコードから決まる6桁（ほかの鍵・ほかのコードなら変わる）", () => {
    const a = confirmCodeFor("ABCDEFGHJK", "Y3JlZA", "cHVi");
    expect(a).toMatch(/^\d{6}$/);
    expect(confirmCodeFor("ABCDEFGHJK", "Y3JlZA", "cHVi")).toBe(a);
    expect(confirmCodeFor("ABCDEFGHJK", "Y3JlZA", "cHVj")).not.toBe(a);
    expect(confirmCodeFor("ABCDEFGHJM", "Y3JlZA", "cHVi")).not.toBe(a);
  });

  it("登録した端末のパスキーは、次の登録の excludeCredentials に入る（同じ認証器を2回登録させない）", async () => {
    const { auth } = await h.pairDevice();
    const { code } = h.service.pairing.start();
    const { options } = await h.service.pairing.options({ code, device_name: "もう一度" });
    expect((options as { excludeCredentials: { id: string }[] }).excludeCredentials).toEqual([
      expect.objectContaining({ id: auth.credentialId }),
    ]);
    expect(() => auth.createCredential(options as never)).toThrow(/InvalidStateError/);
  });
});

describe("5.8 の2：拒否される登録", () => {
  it("拒否：違うコード・壊れたコード・失効したコードは 404 pairing_invalid", async () => {
    const { code } = h.service.pairing.start();
    for (const bad of ["ZZZZZ-ZZZZZ", "", "x", 123, null, "ABCDE-FGHJKL"]) {
      const e = await failure(h.service.pairing.options({ code: bad, device_name: "PC" }));
      expect(e.status, String(bad)).toBe(404);
      expect(e.code, String(bad)).toBe("pairing_invalid");
      // 数えすぎないように、新しいコードにし直す
      h.service.pairing.start();
    }
    const fresh = h.service.pairing.start();
    h.clock.advance(PAIRING_TTL_MS);
    const e = await failure(h.service.pairing.options({ code: fresh.code, device_name: "PC" }));
    expect(e.code).toBe("pairing_invalid");
    expect(h.service.pairing.status(fresh.code).status).toBe("expired");
    void code;
  });

  it(`拒否：違うコードを ${PAIRING_MAX_FAILURES} 回送られたら、いまのコードも無効にする（too_many_attempts）`, async () => {
    const { code } = h.service.pairing.start();
    for (let i = 0; i < PAIRING_MAX_FAILURES; i++) {
      await failure(h.service.pairing.options({ code: "ZZZZZ-ZZZZZ", device_name: "PC" }));
    }
    const e = await failure(h.service.pairing.options({ code, device_name: "PC" }));
    expect(e.code).toBe("pairing_invalid");
    expect(h.service.pairing.status(code)).toMatchObject({
      status: "cancelled",
      cancel_reason: "too_many_attempts",
    });
  });

  it("拒否：新しいコードを出したら、前のコードは使えない（superseded）", async () => {
    const first = h.service.pairing.start();
    h.service.pairing.start();
    const e = await failure(h.service.pairing.options({ code: first.code, device_name: "PC" }));
    expect(e.code).toBe("pairing_invalid");
    expect(h.service.pairing.status(first.code)).toMatchObject({
      status: "cancelled",
      cancel_reason: "superseded",
    });
  });

  it("拒否：取り消したコードは使えず、y も押せない", async () => {
    const auth = softAuthenticator();
    const { code } = h.service.pairing.start();
    const { options } = await h.service.pairing.options({ code, device_name: "PC" });
    await h.service.pairing.register({ code, response: auth.createCredential(options as never) });
    h.service.pairing.cancel(code);
    expect(h.service.pairing.status(code)).toMatchObject({
      status: "cancelled",
      cancel_reason: "cancelled",
      confirm_code: null,
    });
    const e = await failure(() => h.service.pairing.activate(code));
    expect(e.status).toBeGreaterThanOrEqual(404);
    expect(listDevices(h.db)).toHaveLength(0);
  });

  it("拒否：登録の前に y は押せない（409）。2回目の登録・2回目の y もできない", async () => {
    const auth = softAuthenticator();
    const { code } = h.service.pairing.start();
    expect((await failure(() => h.service.pairing.activate(code))).status).toBe(409);
    const { options } = await h.service.pairing.options({ code, device_name: "PC" });
    await h.service.pairing.register({ code, response: auth.createCredential(options as never) });
    const again = await failure(
      h.service.pairing.register({ code, response: auth.createCredential(options as never) }),
    );
    expect(again.status).toBe(409);
    expect((await failure(h.service.pairing.options({ code, device_name: "PC" }))).status).toBe(
      409,
    );
    h.service.pairing.activate(code);
    expect((await failure(() => h.service.pairing.activate(code))).status).toBe(409);
    expect(listDevices(h.db)).toHaveLength(1);
  });

  it("拒否：登録したまま y を押さずに10分たつと、y を押しても有効にならない", async () => {
    const auth = softAuthenticator();
    const { code } = h.service.pairing.start();
    const { options } = await h.service.pairing.options({ code, device_name: "PC" });
    await h.service.pairing.register({ code, response: auth.createCredential(options as never) });
    h.clock.advance(PAIRING_TTL_MS + 1);
    expect(h.service.pairing.status(code).status).toBe("expired");
    expect((await failure(() => h.service.pairing.activate(code))).code).toBe("pairing_invalid");
    expect(listDevices(h.db)).toHaveLength(0);
  });

  it("拒否：署名の確かめに通らない登録（オリジン違い・RP ID 違い・UV なし・チャレンジ違い）。失敗したらチャレンジを捨てる", async () => {
    for (const over of [
      { origin: "http://localhost:9999" },
      { origin: "http://127.0.0.1:7070" },
      { rpId: "example.com" },
      { uv: false },
      { challenge: "AAAA" },
    ]) {
      const auth = softAuthenticator();
      const { code } = h.service.pairing.start();
      const { options } = await h.service.pairing.options({ code, device_name: "PC" });
      const e = await failure(
        h.service.pairing.register({
          code,
          response: auth.createCredential(options as never, over),
        }),
      );
      expect(e.code, JSON.stringify(over)).toBe("signature_invalid");
      expect(h.service.pairing.status(code).status).toBe("waiting");
      // 正しい応答でも、同じチャレンジではもう登録できない（options からやり直す）
      const retry = await failure(
        h.service.pairing.register({ code, response: auth.createCredential(options as never) }),
      );
      expect(retry.status, JSON.stringify(over)).toBe(409);
    }
    expect(listDevices(h.db)).toHaveLength(0);
  });

  it("拒否：端末の名前が空・長すぎる・制御文字、知らないキー", async () => {
    const { code } = h.service.pairing.start();
    for (const device_name of ["", "  ", "x".repeat(41), "a\nb", 1]) {
      const e = await failure(h.service.pairing.options({ code, device_name }));
      expect(e.code, JSON.stringify(device_name)).toBe("invalid_input");
    }
    const e = await failure(h.service.pairing.options({ code, device_name: "PC", admin: true }));
    expect(e.code).toBe("invalid_input");
  });

  it("拒否：すでに登録したパスキーを、別のコードでもう一度登録する（excludeCredentials を無視したもの）", async () => {
    const { auth } = await h.pairDevice();
    const { code } = h.service.pairing.start();
    const { options } = await h.service.pairing.options({ code, device_name: "二重" });
    const response = auth.createCredential(options as never, { ignoreCredentialLists: true });
    const e = await failure(h.service.pairing.register({ code, response }));
    expect(e.status).toBe(409);
    expect(listDevices(h.db)).toHaveLength(1);
  });
});
