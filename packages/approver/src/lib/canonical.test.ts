import { describe, expect, test } from "vitest";
import { canonicalJson, sha256Base64Url, sha256Hex } from "./canonical.ts";

// 期待値は、制御サーバーが使う packages/shared の canonicalJson と Node の SHA-256 で作ったもの
const PAYLOAD = {
  type: "hold",
  id: "h_01JQ0000000000000000000001",
  decision: "approve",
  company_id: "c_01JQ0000000000000000000009",
  summary_sha256: "ab".repeat(32),
  issued_at: "2026-11-28T03:00:00.000Z",
  expires_at: "2026-11-28T03:02:00.000Z",
  nonce: "AAECAwQFBgcICQoLDA0ODw",
};

const SUMMARY = {
  kind: "gmail_message",
  to: ["client@example.com"],
  cc: [],
  bcc: ["boss@example.org"],
  subject: "お見積りの件\u{202E}",
  body_text: 'いつも\nお世話に"なって"います \u{0000} 😀',
  n: 1.5,
  z: null,
  nested: { b: true, a: [1, 2, { y: "x", x: "y" }] },
};

describe("正規化JSON と SHA-256（5.8 の3の4：署名の前に、表示したものと署名するものが同じか確かめる）", () => {
  test("キーを辞書順に並べ、空白なし（制御サーバーと同じバイト列）", () => {
    expect(canonicalJson(PAYLOAD)).toBe(
      '{"company_id":"c_01JQ0000000000000000000009","decision":"approve","expires_at":"2026-11-28T03:02:00.000Z","id":"h_01JQ0000000000000000000001","issued_at":"2026-11-28T03:00:00.000Z","nonce":"AAECAwQFBgcICQoLDA0ODw","summary_sha256":"abababababababababababababababababababababababababababababababab","type":"hold"}',
    );
  });

  test("payload のチャレンジ（base64url）と、要約の SHA-256（16進の小文字）が制御サーバーと一致する", async () => {
    expect(await sha256Base64Url(canonicalJson(PAYLOAD))).toBe(
      "t1MKd0p_FiukhKoMkYkuvX-g5Zl2BrsfhMm7inrJPm8",
    );
    expect(await sha256Hex(canonicalJson(SUMMARY))).toBe(
      "ca910f24e7f638969bbe16b859795573375d106b07c39d7cfaccb205801ecc9b",
    );
  });

  test("JSON にできない値は、黙って変えずに失敗する", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: new Date(0) })).toThrow(TypeError);
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
    // undefined のプロパティは書かない（JSON.stringify と同じ）
    expect(canonicalJson({ b: undefined, a: 1 })).toBe('{"a":1}');
  });
});
