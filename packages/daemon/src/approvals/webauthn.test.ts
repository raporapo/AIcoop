import { generateAuthenticationOptions, generateRegistrationOptions } from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import { type CeremonyOverrides, otherPrivateKey, softAuthenticator } from "../testing/webauthn.ts";
import { ApprovalFailure } from "./errors.ts";
import {
  appOrigin,
  RP_ID,
  SUPPORTED_ALGORITHM_IDS,
  verifyAssertion,
  verifyRegistration,
} from "./webauthn.ts";

const ORIGIN = appOrigin(7070);

async function registrationOptions() {
  return generateRegistrationOptions({
    rpName: "AIcoop",
    rpID: RP_ID,
    userName: "owner",
    userID: new Uint8Array(16),
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    supportedAlgorithmIDs: [...SUPPORTED_ALGORITHM_IDS],
  });
}

async function register(over: CeremonyOverrides = {}, auth = softAuthenticator()) {
  const options = await registrationOptions();
  const response = auth.createCredential(options, over);
  return { auth, options, response };
}

async function expectSignatureInvalid(p: Promise<unknown>, label: string) {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, label).toBeInstanceOf(ApprovalFailure);
  expect((error as ApprovalFailure).code, label).toBe("signature_invalid");
  expect((error as ApprovalFailure).status, label).toBe(400);
}

describe("5.8 の2：パスキーの登録（RP ID localhost、オリジン http://localhost:<port>、UV 必須、attestation none）", () => {
  it("本物の形の登録を @simplewebauthn/server で確かめ、資格情報の ID・公開鍵・カウンターを返す", async () => {
    const { auth, options, response } = await register();
    const result = await verifyRegistration(
      response,
      { challenge: options.challenge, origin: ORIGIN },
      "x",
    );
    expect(result.credentialId).toBe(auth.credentialId);
    expect(result.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.counter).toBe(0);
  });

  it("拒否：オリジン違い・RP ID 違い・UV なし・UP なし・チャレンジ違い・型違い・iframe の中・id の食い違い", async () => {
    const cases: Array<[string, CeremonyOverrides]> = [
      ["オリジン違い（http://localhost:8080）", { origin: "http://localhost:8080" }],
      ["オリジン違い（127.0.0.1）", { origin: "http://127.0.0.1:7070" }],
      ["オリジン違い（https）", { origin: "https://localhost:7070" }],
      ["オリジン違い（ほかのサイト）", { origin: "https://evil.example" }],
      ["RP ID 違い", { rpId: "evil.example" }],
      ["RP ID 違い（127.0.0.1）", { rpId: "127.0.0.1" }],
      ["UV なし", { uv: false }],
      ["UP なし", { up: false }],
      ["チャレンジ違い", { challenge: "AAAA" }],
      ["型違い（get）", { type: "webauthn.get" }],
      ["iframe の中（crossOrigin）", { crossOrigin: true }],
      ["id の食い違い", { responseId: "b3RoZXI" }],
    ];
    for (const [label, over] of cases) {
      const { options, response } = await register(over);
      await expectSignatureInvalid(
        verifyRegistration(response, { challenge: options.challenge, origin: ORIGIN }, "x"),
        label,
      );
    }
  });

  it("拒否：形の壊れた応答（オブジェクトでない・欄がない・base64url でない）", async () => {
    const { options, response } = await register();
    const r = response as { response: Record<string, unknown> };
    for (const [label, bad] of [
      ["null", null],
      ["文字列", "x"],
      ["配列", []],
      ["response がない", { ...response, response: undefined }],
      [
        "clientDataJSON が壊れている",
        { ...response, response: { ...r.response, clientDataJSON: "@@" } },
      ],
      [
        "attestationObject がない",
        { ...response, response: { ...r.response, attestationObject: undefined } },
      ],
      ["type が違う", { ...response, type: "password" }],
    ] as const) {
      const error = await verifyRegistration(
        bad,
        { challenge: options.challenge, origin: ORIGIN },
        "x",
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, label).toBeInstanceOf(ApprovalFailure);
      expect((error as ApprovalFailure).status, label).toBe(400);
    }
  });
});

describe("5.8 の3の6：パスキーの署名（チャレンジ・オリジン・RP ID・署名・カウンターの増加・UV）", () => {
  async function registered(options: Parameters<typeof softAuthenticator>[0] = {}) {
    const auth = softAuthenticator(options);
    const reg = await register({}, auth);
    const cred = await verifyRegistration(
      reg.response,
      { challenge: reg.options.challenge, origin: ORIGIN },
      "x",
    );
    return {
      auth,
      credential: { id: cred.credentialId, publicKey: cred.publicKey, counter: cred.counter },
    };
  }

  async function requestOptions(id: string) {
    return generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: [{ id }],
      userVerification: "required",
    });
  }

  it("正しい署名なら通り、新しいカウンターを返す", async () => {
    const { auth, credential } = await registered();
    const options = await requestOptions(credential.id);
    const response = auth.getAssertion(options);
    const result = await verifyAssertion(
      response,
      { challenge: options.challenge, origin: ORIGIN, credential },
      "x",
    );
    expect(result.newCounter).toBe(1);
  });

  it("拒否：偽造（ほかの鍵）・書き換えた署名・オリジン違い・RP ID 違い・UV なし・UP なし・チャレンジ違い・型違い・iframe の中", async () => {
    const { auth, credential } = await registered();
    const cases: Array<[string, CeremonyOverrides]> = [
      ["ほかの鍵で署名", { signWith: otherPrivateKey() }],
      ["署名の書き換え", { tamperSignature: true }],
      ["オリジン違い", { origin: "http://localhost:7071" }],
      ["オリジン違い（127.0.0.1）", { origin: "http://127.0.0.1:7070" }],
      ["RP ID 違い", { rpId: "example.com" }],
      ["UV なし", { uv: false }],
      ["UP なし", { up: false }],
      ["チャレンジ違い", { challenge: "AAAA" }],
      ["型違い（create）", { type: "webauthn.create" }],
      ["iframe の中（crossOrigin）", { crossOrigin: true }],
      ["topOrigin つき", { topOrigin: "https://evil.example" }],
    ];
    for (const [label, over] of cases) {
      const options = await requestOptions(credential.id);
      const response = auth.getAssertion(options, over);
      await expectSignatureInvalid(
        verifyAssertion(
          response,
          { challenge: options.challenge, origin: ORIGIN, credential },
          "x",
        ),
        label,
      );
    }
  });

  it("拒否：ほかの端末のパスキーで署名し、その資格情報を名乗る・この端末を名乗る", async () => {
    const a = await registered();
    const b = await registered();
    const options = await requestOptions(a.credential.id);
    // b が自分の ID のまま署名する
    const own = b.auth.getAssertion(options, { ignoreCredentialLists: true });
    await expectSignatureInvalid(
      verifyAssertion(
        own,
        { challenge: options.challenge, origin: ORIGIN, credential: a.credential },
        "x",
      ),
      "ほかの資格情報の ID",
    );
    // b が a の ID を名乗る（署名は b の鍵）
    const forged = b.auth.getAssertion(options, {
      ignoreCredentialLists: true,
      responseId: a.credential.id,
    });
    await expectSignatureInvalid(
      verifyAssertion(
        forged,
        { challenge: options.challenge, origin: ORIGIN, credential: a.credential },
        "x",
      ),
      "a を名乗る",
    );
  });

  it("拒否：カウンターが増えない（同じ値・減った・0 に戻った）", async () => {
    const { auth, credential } = await registered({ initialCounter: 10 });
    const stored = { ...credential, counter: 11 };
    for (const counter of [11, 5, 0]) {
      const options = await requestOptions(credential.id);
      const response = auth.getAssertion(options, { counter });
      await expectSignatureInvalid(
        verifyAssertion(
          response,
          { challenge: options.challenge, origin: ORIGIN, credential: stored },
          "x",
        ),
        `counter ${counter}`,
      );
    }
    const options = await requestOptions(credential.id);
    const ok = auth.getAssertion(options, { counter: 12 });
    await expect(
      verifyAssertion(
        ok,
        { challenge: options.challenge, origin: ORIGIN, credential: stored },
        "x",
      ),
    ).resolves.toEqual({ newCounter: 12 });
  });

  it("カウンターを数えない認証器（ずっと 0）は、WebAuthn の仕様のとおり受ける", async () => {
    const { auth, credential } = await registered({ counterStep: 0 });
    for (let i = 0; i < 2; i++) {
      const options = await requestOptions(credential.id);
      const response = auth.getAssertion(options);
      await expect(
        verifyAssertion(
          response,
          { challenge: options.challenge, origin: ORIGIN, credential },
          "x",
        ),
      ).resolves.toEqual({ newCounter: 0 });
    }
  });
});
