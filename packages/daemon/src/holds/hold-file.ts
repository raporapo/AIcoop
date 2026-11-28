/**
 * 保留したリクエストのファイル（`state/holds/<hold_id>.bin`。5.2.6 の1）。
 *
 * 1行目に `{"format","method","url","headers","body_bytes","auth"}` の JSON と改行、そのあとに本文をそのまま置く。
 * - 認証ヘッダー・cookie・その資格の `header` は保存しない（5.2.6 の1。再送のときに本物を付け直す）
 * - 仮の札は、どのヘッダーに入っていても置き換わる（C-3）ので、仮の札の入ったヘッダーは名前を問わず保存しない
 * - URL（クエリ）の中の仮の札は伏せ字にする（クエリでは置き換わらない。11.5）
 * - 資格のヘッダーの形（例：`Bearer <仮の札>`）は、仮の札を伏せ字にした `auth.template` として残し、
 *   再送のときに伏せ字のところへ本物を入れる（`Bearer` 以外の形の資格でも、送った形のまま付け直せる）
 * 本文は、送るものとして保存する（5.2.1 の3：本文の中の仮の札は置き換わらない）
 */
import type { ProxiedRequest } from "@aicoop/shared";
import { containsPlaceholder, maskPlaceholders, PLACEHOLDER_MASK } from "../run/redact.ts";

/** ファイルの形の名前（1行目の JSON の format） */
export const HOLD_FILE_FORMAT = "aicoop-hold/1";

/** 保留に保存しないヘッダー（認証の情報）。その資格の header も除く */
const DROPPED_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);

/** 資格のヘッダーの形として残してよいもの（見える ASCII と空白、512文字まで） */
const AUTH_TEMPLATE = /^[\x20-\x7e]{1,512}$/;

export interface SavedHoldRequest {
  readonly method: string;
  /** クエリ文字列を含む URL */
  readonly url: string;
  /** 認証ヘッダー・cookie・その資格のヘッダー・仮の札の入ったヘッダーを除いたもの（名前は小文字） */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** 資格のヘッダーの形（仮の札は伏せ字 `GONDOLIN_SECRET_****` がちょうど1つ）。なければ null */
  readonly auth: { readonly header: string; readonly template: string } | null;
}

/** 箱から来たリクエストを、保存する形にする */
export function savedRequestFrom(
  req: ProxiedRequest,
  body: Uint8Array,
  secretHeader: string | undefined,
): SavedHoldRequest {
  const headers: Record<string, string> = {};
  let auth: SavedHoldRequest["auth"] = null;
  const secret = secretHeader?.toLowerCase();
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (lower === secret) {
      const template = maskPlaceholders(value);
      if (
        AUTH_TEMPLATE.test(template) &&
        template.split(PLACEHOLDER_MASK).length === 2 &&
        !containsPlaceholder(template.split(PLACEHOLDER_MASK).join(""))
      ) {
        auth = { header: lower, template };
      }
      continue;
    }
    if (DROPPED_HEADERS.has(lower)) continue;
    if (containsPlaceholder(value)) continue;
    headers[lower] = value;
  }
  const host = req.host.includes(":") ? `[${req.host}]` : req.host;
  return {
    method: req.method,
    url: maskPlaceholders(`${req.protocol}://${host}${req.path}`),
    headers,
    body,
    auth,
  };
}

export function encodeHoldFile(saved: SavedHoldRequest): Buffer {
  const head = JSON.stringify({
    format: HOLD_FILE_FORMAT,
    method: saved.method,
    url: saved.url,
    headers: saved.headers,
    body_bytes: saved.body.byteLength,
    ...(saved.auth === null ? {} : { auth: saved.auth }),
  });
  return Buffer.concat([Buffer.from(`${head}\n`, "utf8"), saved.body]);
}

/** 保存したリクエストを読む（再送・承認アプリでの表示）。形が違えば例外 */
export function readHoldFile(bytes: Uint8Array): SavedHoldRequest {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const newline = buffer.indexOf(0x0a);
  if (newline < 0) throw new Error("保留のファイルの形が違います");
  const head = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
  const body = buffer.subarray(newline + 1);
  const headers = head.headers;
  if (
    head.format !== HOLD_FILE_FORMAT ||
    typeof head.method !== "string" ||
    typeof head.url !== "string" ||
    typeof headers !== "object" ||
    headers === null ||
    Array.isArray(headers) ||
    !Object.values(headers).every((v) => typeof v === "string") ||
    head.body_bytes !== body.byteLength
  ) {
    throw new Error("保留のファイルの形が違います");
  }
  let auth: SavedHoldRequest["auth"] = null;
  if (head.auth !== undefined) {
    const a = head.auth as Record<string, unknown> | null;
    if (
      typeof a !== "object" ||
      a === null ||
      typeof a.header !== "string" ||
      typeof a.template !== "string" ||
      !AUTH_TEMPLATE.test(a.template) ||
      a.template.split(PLACEHOLDER_MASK).length !== 2
    ) {
      throw new Error("保留のファイルの形が違います");
    }
    auth = { header: a.header, template: a.template };
  }
  return {
    method: head.method,
    url: head.url,
    headers: headers as Record<string, string>,
    body: new Uint8Array(body),
    auth,
  };
}
