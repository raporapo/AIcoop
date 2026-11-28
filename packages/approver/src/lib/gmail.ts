/**
 * Gmail の送信（`users.messages.send`）の本文 `{"raw": "<base64url の RFC 2822>"}` を、読める形にする。
 * 要約に出ない宛先（Bcc）・添付・HTML の部分を、承認の前に確かめるため（10.2）。
 */
import { bytesFromBase64Url } from "./canonical.ts";

export function decodeGmailRaw(bodyText: string | null): string | null {
  if (bodyText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as { raw?: unknown; message?: { raw?: unknown } };
  const raw = typeof p.raw === "string" ? p.raw : p.message?.raw;
  if (typeof raw !== "string") return null;
  const bytes = bytesFromBase64Url(raw);
  if (bytes === null) return null;
  return new TextDecoder("utf-8").decode(bytes);
}
