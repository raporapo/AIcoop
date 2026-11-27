/**
 * テスト用：ソフトウェアの認証器（パスキー）。node:crypto の ES256（P-256）の鍵で、本物と同じ形の
 * WebAuthn の登録（attestation `none`）と署名（assertion）を作る。確かめるのは本物の
 * @simplewebauthn/server（偽物にしない）。
 *
 * 拒否される側のテストのために、オリジン・RP ID・UV・UP・カウンター・チャレンジ・型・署名の鍵などを
 * 1回ごとに差し替えられる（`CeremonyOverrides`）。
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

export interface CeremonyOverrides {
  /** clientDataJSON の origin（既定：`defaultOrigin`） */
  readonly origin?: string;
  /** authenticatorData の rpIdHash のもとにする RP ID（既定：options の RP ID） */
  readonly rpId?: string;
  /** 本人確認（UV）の旗（既定 true） */
  readonly uv?: boolean;
  /** ユーザーがいる（UP）の旗（既定 true） */
  readonly up?: boolean;
  /** 署名カウンターをこの値にする（既定：前の値 + counterStep） */
  readonly counter?: number;
  /** clientDataJSON の challenge（既定：options の challenge） */
  readonly challenge?: string;
  /** clientDataJSON の type（既定：webauthn.create / webauthn.get） */
  readonly type?: string;
  readonly crossOrigin?: boolean;
  readonly topOrigin?: string;
  /** 応答の id・rawId を差し替える（別の資格情報を名乗る） */
  readonly responseId?: string;
  /** この鍵で署名する（盗んでいない鍵での偽造） */
  readonly signWith?: KeyObject;
  /** 署名の1バイトを書き換える */
  readonly tamperSignature?: boolean;
  /** options の allowCredentials・excludeCredentials を無視する（本物のブラウザはしない） */
  readonly ignoreCredentialLists?: boolean;
}

/** `PublicKeyCredentialCreationOptionsJSON` のうち、ここで使うもの */
interface CreationOptions {
  readonly challenge: string;
  readonly rp: { readonly id?: string };
  readonly excludeCredentials?: readonly { readonly id: string }[];
}

/** `PublicKeyCredentialRequestOptionsJSON` のうち、ここで使うもの */
interface RequestOptions {
  readonly challenge: string;
  readonly rpId?: string;
  readonly allowCredentials?: readonly { readonly id: string }[];
}

export interface SoftAuthenticatorOptions {
  /** 署名のたびにカウンターを増やす数（0 なら数えない認証器。既定 1） */
  readonly counterStep?: number;
  readonly initialCounter?: number;
  /** clientDataJSON の origin の既定 */
  readonly origin?: string;
}

export class SoftAuthenticator {
  readonly credentialId: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  counter: number;
  readonly counterStep: number;
  defaultOrigin: string;

  constructor(options: SoftAuthenticatorOptions = {}) {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.credentialId = b64url(randomBytes(32));
    this.counter = options.initialCounter ?? 0;
    this.counterStep = options.counterStep ?? 1;
    this.defaultOrigin = options.origin ?? "http://localhost:7070";
  }

  /** COSE の EC2 公開鍵（alg -7 = ES256） */
  private cosePublicKey(): Uint8Array {
    const jwk = this.publicKey.export({ format: "jwk" });
    const x = Buffer.from(jwk.x as string, "base64url");
    const y = Buffer.from(jwk.y as string, "base64url");
    return isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(x)],
        [-3, new Uint8Array(y)],
      ]),
    );
  }

  private flags(over: CeremonyOverrides, extra = 0): number {
    return (over.up === false ? 0 : FLAG_UP) | (over.uv === false ? 0 : FLAG_UV) | extra;
  }

  private nextCounter(over: CeremonyOverrides): number {
    if (over.counter !== undefined) return over.counter;
    this.counter += this.counterStep;
    return this.counter;
  }

  private clientData(
    type: string,
    challenge: string,
    over: CeremonyOverrides,
  ): { readonly json: string; readonly b64: string } {
    const data: Record<string, unknown> = {
      type: over.type ?? type,
      challenge: over.challenge ?? challenge,
      origin: over.origin ?? this.defaultOrigin,
      crossOrigin: over.crossOrigin ?? false,
    };
    if (over.topOrigin !== undefined) data.topOrigin = over.topOrigin;
    const json = JSON.stringify(data);
    return { json, b64: b64url(Buffer.from(json, "utf8")) };
  }

  /** navigator.credentials.create() の代わり（RegistrationResponseJSON を返す） */
  createCredential(
    options: CreationOptions,
    over: CeremonyOverrides = {},
  ): Record<string, unknown> {
    if (
      !over.ignoreCredentialLists &&
      (options.excludeCredentials ?? []).some((c) => c.id === this.credentialId)
    ) {
      throw new Error("InvalidStateError：この認証器は、すでに登録されています");
    }
    const rpId = over.rpId ?? options.rp.id ?? "localhost";
    const credId = Buffer.from(this.credentialId, "base64url");
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(over, FLAG_AT)]),
      u32(over.counter ?? this.counter),
      Buffer.alloc(16),
      u16(credId.length),
      credId,
      Buffer.from(this.cosePublicKey()),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", new Uint8Array(authData)],
      ]) as never,
    );
    const client = this.clientData("webauthn.create", options.challenge, over);
    const id = over.responseId ?? this.credentialId;
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: client.b64,
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** navigator.credentials.get() の代わり（AuthenticationResponseJSON を返す） */
  getAssertion(options: RequestOptions, over: CeremonyOverrides = {}): Record<string, unknown> {
    const allow = options.allowCredentials ?? [];
    if (
      !over.ignoreCredentialLists &&
      allow.length > 0 &&
      !allow.some((c) => c.id === this.credentialId)
    ) {
      throw new Error("NotAllowedError：この認証器の資格情報は、許されていません");
    }
    const rpId = over.rpId ?? options.rpId ?? "localhost";
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([this.flags(over)]),
      u32(this.nextCounter(over)),
    ]);
    const client = this.clientData("webauthn.get", options.challenge, over);
    const signed = Buffer.concat([authData, sha256(Buffer.from(client.json, "utf8"))]);
    const signature = sign("sha256", signed, over.signWith ?? this.privateKey);
    if (over.tamperSignature) {
      const i = signature.length - 1;
      signature[i] = (signature[i] as number) ^ 0x01;
    }
    const id = over.responseId ?? this.credentialId;
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: client.b64,
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: b64url(Buffer.from("owner")),
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

export function softAuthenticator(options?: SoftAuthenticatorOptions): SoftAuthenticator {
  return new SoftAuthenticator(options);
}

/** 盗んでいない（ほかの）鍵 */
export function otherPrivateKey(): KeyObject {
  return generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
}
