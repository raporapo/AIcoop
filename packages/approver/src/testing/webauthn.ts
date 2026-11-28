/**
 * テスト用：ブラウザのパスキー（`navigator.credentials`・`PublicKeyCredential`）の偽物。
 * 本物の @simplewebauthn/browser を通して呼ばれるので、`navigator.credentials.get` に渡った
 * チャレンジ・資格情報の指定をテストで確かめられる。
 */
import { vi } from "vitest";

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

export function toBase64Url(buf: ArrayBuffer | ArrayBufferView): string {
  const view =
    buf instanceof ArrayBuffer
      ? new Uint8Array(buf)
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = "";
  for (const b of view) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface FakeGetCall {
  readonly challenge: string;
  readonly allowCredentials: readonly string[];
  readonly userVerification: string | undefined;
  readonly rpId: string | undefined;
}

export interface FakeCreateCall {
  readonly challenge: string;
  readonly userVerification: string | undefined;
}

export interface FakeWebAuthn {
  readonly getCalls: FakeGetCall[];
  readonly createCalls: FakeCreateCall[];
  /** 次の get を、この名前の DOMException で失敗させる（NotAllowedError など） */
  failNextGet(name: string): void;
  failNextCreate(name: string): void;
  /** 次の get を、resolve を呼ぶまで待たせる */
  holdNextGet(): { release: () => void };
}

type Pending = { name: string } | { hold: Promise<void> } | null;

export function installFakeWebAuthn(): FakeWebAuthn {
  const getCalls: FakeGetCall[] = [];
  const createCalls: FakeCreateCall[] = [];
  let nextGet: Pending = null;
  let nextCreate: Pending = null;

  class FakePublicKeyCredential {}
  vi.stubGlobal("PublicKeyCredential", FakePublicKeyCredential);

  const credentials = {
    get: vi.fn(async (options: CredentialRequestOptions) => {
      const pk = options.publicKey as PublicKeyCredentialRequestOptions;
      getCalls.push({
        challenge: toBase64Url(pk.challenge as ArrayBuffer),
        allowCredentials: (pk.allowCredentials ?? []).map((c) => toBase64Url(c.id as ArrayBuffer)),
        userVerification: pk.userVerification,
        rpId: pk.rpId,
      });
      const p = nextGet;
      nextGet = null;
      if (p !== null && "name" in p) throw new DOMException("テストの失敗", p.name);
      if (p !== null && "hold" in p) await p.hold;
      const clientData = JSON.stringify({
        type: "webauthn.get",
        challenge: toBase64Url(pk.challenge as ArrayBuffer),
        origin: window.location.origin,
      });
      return {
        id: "cred-1",
        rawId: bytes("cred-1"),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          authenticatorData: bytes("auth-data"),
          clientDataJSON: bytes(clientData),
          signature: bytes("signature"),
          userHandle: bytes("owner"),
        },
        getClientExtensionResults: () => ({}),
      };
    }),
    create: vi.fn(async (options: CredentialCreationOptions) => {
      const pk = options.publicKey as PublicKeyCredentialCreationOptions;
      createCalls.push({
        challenge: toBase64Url(pk.challenge as ArrayBuffer),
        userVerification: pk.authenticatorSelection?.userVerification,
      });
      const p = nextCreate;
      nextCreate = null;
      if (p !== null && "name" in p) throw new DOMException("テストの失敗", p.name);
      return {
        id: "cred-new",
        rawId: bytes("cred-new"),
        type: "public-key",
        authenticatorAttachment: "platform",
        response: {
          attestationObject: bytes("attestation"),
          clientDataJSON: bytes("{}"),
          getTransports: () => ["internal"],
        },
        getClientExtensionResults: () => ({}),
      };
    }),
  };
  Object.defineProperty(navigator, "credentials", { configurable: true, value: credentials });

  return {
    getCalls,
    createCalls,
    failNextGet(name) {
      nextGet = { name };
    },
    failNextCreate(name) {
      nextCreate = { name };
    },
    holdNextGet() {
      let release: () => void = () => {};
      nextGet = {
        hold: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      return { release: () => release() };
    },
  };
}

/** パスキーに対応していないブラウザ */
export function removeWebAuthn(): void {
  vi.stubGlobal("PublicKeyCredential", undefined);
  Object.defineProperty(navigator, "credentials", { configurable: true, value: undefined });
}
