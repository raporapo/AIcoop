/**
 * 資格の画面から受け取った値を、種類の形にする（5.14 の5、5.2.8 の4）。CLI の `aicoop secret set` と同じ確かめ。
 *
 * - `static_token`・`anthropic_oauth` は、トークンだけの文字列でもよい（前後の空白・BOM は除く。
 *   中に空白・改行・印字できない文字があれば誤り）
 * - オブジェクトは `validateSecretValue`（知らないキーは、名前も出さずに誤り）
 * - 誤りの文には、値もキーの名前も入れない（11.5）
 */
import type { SecretKind } from "@aicoop/shared";
import { SecretStoreError, type SecretValue, validateSecretValue } from "../secrets/store.ts";

const TOKEN_ONLY: ReadonlySet<SecretKind> = new Set(["static_token", "anthropic_oauth"]);

export function parseSecretInput(kind: SecretKind, value: unknown): SecretValue {
  if (typeof value === "string") {
    if (!TOKEN_ONLY.has(kind)) {
      throw new SecretStoreError(
        `${kind} の資格は、JSON のオブジェクトで渡してください（中身は表示しません）`,
      );
    }
    const text = value.replace(/^﻿/, "").trim();
    if (text === "") throw new SecretStoreError("資格が空です");
    if (/\s/.test(text)) {
      throw new SecretStoreError(
        "トークンに空白や改行が入っています（中身は表示しません）。トークンだけを貼り付けてください",
      );
    }
    if (!/^[\x21-\x7e]+$/.test(text)) {
      throw new SecretStoreError(
        "トークンに使えない文字（全角の文字など）が入っています（中身は表示しません）",
      );
    }
    return validateSecretValue(kind, { token: text });
  }
  return validateSecretValue(kind, value);
}
