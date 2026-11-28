/**
 * 正規化JSON（キーを辞書順に並べ、空白なし）と SHA-256。
 *
 * 制御サーバーの `packages/shared/src/canonical-json.ts` と同じ規則（ブラウザでは shared の部品を
 * 読まないので、ここに同じものを置く。一致はテストの期待値で確かめる）。承認アプリでは、署名する前に
 * 「チャレンジ = payload の正規化JSON の SHA-256」「summary_sha256 = 表示した要約の SHA-256」を
 * 自分でも計算して確かめる（5.8 の3の3・4）。
 */

export function canonicalJson(value: unknown): string {
  return write(value, new Set());
}

function write(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("正規化JSONにできない数値です");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`正規化JSONにできない値です: ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("正規化JSONにできない値です: 循環参照");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => {
        if (item === undefined) throw new TypeError("正規化JSONにできない値です: 配列の undefined");
        return write(item, ancestors);
      });
      return `[${items.join(",")}]`;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("正規化JSONにできない値です: ふつうのオブジェクトではありません");
    }
    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v === undefined) continue;
      members.push(`${JSON.stringify(key)}:${write(v, ancestors)}`);
    }
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

async function digest(text: string): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(buf);
}

/** SHA-256 の16進（小文字） */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = await digest(text);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function base64UrlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 の base64url（`=` なし） */
export async function sha256Base64Url(text: string): Promise<string> {
  return base64UrlFromBytes(await digest(text));
}

/** base64url（`=` があってもよい）をバイト列に。読めなければ null */
export function bytesFromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
  const b64 = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
