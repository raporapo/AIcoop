import { describe, expect, test } from "vitest";
import { describeSummary, formatBytes, shortSummary } from "./summary.ts";

describe("保留の要約の見せ方（5.7.1 の2 の表）", () => {
  test("メール：宛先（To・Cc・Bcc）・件名・本文。本文と件名は外から来た文章として囲む", () => {
    const d = describeSummary({
      kind: "gmail_message",
      to: ["client@example.com"],
      cc: [],
      bcc: ["boss@example.org"],
      subject: "お見積りの件",
      body_text: "いつもお世話になっております。",
    });
    expect(d.kindLabel).toBe("メール");
    expect(d.requireFullRequest).toBe(true);
    expect(d.fields.map((f) => [f.label, f.value, f.prose])).toEqual([
      ["宛先（To）", { type: "list", items: ["client@example.com"] }, false],
      ["Cc", { type: "list", items: [] }, false],
      ["Bcc", { type: "list", items: ["boss@example.org"] }, false],
      ["件名", { type: "text", text: "お見積りの件" }, true],
      ["本文", { type: "text", text: "いつもお世話になっております。" }, true],
    ]);
  });

  test("PR のマージ：リポジトリ・PR番号・タイトル・変更ファイル数。元のリクエストは促すだけ", () => {
    const d = describeSummary({
      kind: "github_pr_merge",
      repo: "myorg/app",
      pr_number: 12,
      title: "README の誤字を直す",
      changed_files: 3,
    });
    expect(d.kindLabel).toBe("PR のマージ");
    expect(d.requireFullRequest).toBe(false);
    expect(d.fields.map((f) => [f.label, f.value])).toEqual([
      ["リポジトリ", { type: "text", text: "myorg/app" }],
      ["PR 番号", { type: "text", text: "#12" }],
      ["タイトル", { type: "text", text: "README の誤字を直す" }],
      ["変更ファイル数", { type: "text", text: "3" }],
    ]);
  });

  test("知らない項目・知らない種類も、黙って捨てずに全部見せる（表示した要約が署名の対象）", () => {
    const d = describeSummary({ kind: "slack_message", channel: "#general", extra: { a: 1 } });
    expect(d.kindLabel).toBe("slack_message");
    expect(d.requireFullRequest).toBe(true);
    expect(d.fields.map((f) => f.key)).toEqual(["channel", "extra"]);
    expect(d.fields[1]?.value).toEqual({ type: "json", text: '{\n  "a": 1\n}' });
  });

  test("要約の種類がない（P1 の形）：メソッド・ホスト・パス・本文の大きさ", () => {
    const d = describeSummary({
      kind: "default",
      method: "POST",
      host: "api.example.com",
      path: "/v1/send",
      body_bytes: 2048,
    });
    expect(d.kindLabel).toBe("リクエスト");
    expect(d.requireFullRequest).toBe(true);
    expect(d.fields.find((f) => f.key === "body_bytes")?.value).toEqual({
      type: "text",
      text: "2.0 KiB（2048 バイト）",
    });
  });

  test("要約がオブジェクトでなくても落ちない", () => {
    expect(describeSummary(null).fields).toEqual([]);
    expect(describeSummary("text").fields).toEqual([
      { key: "(値)", label: "値", value: { type: "text", text: "text" }, prose: true },
    ]);
  });

  test("一覧の1行：宛先・件名、リポジトリ#PR。見えない文字は印にする", () => {
    expect(
      shortSummary({
        kind: "gmail_message",
        to: ["a@example.com", "b@example.com", "c@example.com"],
        subject: "件名\u{202E}です",
      }),
    ).toBe("宛先 a@example.com ほか2件・件名「件名[U+202E]です」");
    expect(
      shortSummary({ kind: "github_pr_merge", repo: "myorg/app", pr_number: 12, title: "直す" }),
    ).toBe("myorg/app #12「直す」");
    expect(shortSummary({ kind: "default", method: "POST", host: "h.example", path: "/x" })).toBe(
      "POST h.example/x",
    );
    expect(shortSummary({ kind: "gmail_message", subject: "あ".repeat(200) })).toHaveLength(80);
  });

  test("バイト数", () => {
    expect(formatBytes(12)).toBe("12 バイト");
    expect(formatBytes(1536)).toBe("1.5 KiB（1536 バイト）");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MiB（10485760 バイト）");
  });
});
