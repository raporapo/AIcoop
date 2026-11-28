import { describe, expect, test } from "vitest";
import { describeSummary, formatBytes, shortSummary } from "./summary.ts";

// daemon（packages/daemon/src/holds/prepare.ts・views.ts）が作る要約の形
const GMAIL = {
  kind: "gmail_message",
  operation: "gmail.message.send",
  member_id: "sales-writer",
  warnings: [],
  source: "message",
  draft_id: null,
  from: [],
  to: ["client@example.com"],
  cc: [],
  bcc: ["boss@example.org"],
  subject: ["お見積りの件"],
  body_kind: "text",
  body_text: "いつもお世話になっております。",
  body_truncated: false,
  attachments: [],
  manager_comment: "問題ありません",
};

const MERGE = {
  kind: "github_pr_merge",
  operation: "github.pr.merge",
  member_id: "dev-implementer",
  warnings: [],
  repo: "myorg/app",
  number: 12,
  title: "README の誤字を直す",
  changed_files: 3,
  head_sha: "a".repeat(40),
  head_ref: "fix-typo",
  base_ref: "main",
  merge_method: "squash",
  manager_comment: null,
};

function field(d: ReturnType<typeof describeSummary>, key: string) {
  return d.fields.find((f) => f.key === key);
}

describe("要約の見せ方（5.7.1 の2 の表、5.7.3 の2）", () => {
  test("メール：宛先（To・Cc・Bcc）・件名・本文・部長のコメント。件名・本文・コメントは外から来た文章として囲む", () => {
    const d = describeSummary(GMAIL);
    expect(d.kindLabel).toBe("メール");
    expect(d.requireFullRequest).toBe(true);
    expect(field(d, "to")).toMatchObject({
      label: "宛先（To）",
      value: { type: "list", items: ["client@example.com"] },
      prose: false,
    });
    expect(field(d, "bcc")?.value).toEqual({ type: "list", items: ["boss@example.org"] });
    expect(field(d, "subject")).toMatchObject({ label: "件名", prose: true });
    expect(field(d, "body_text")).toMatchObject({ label: "本文", prose: true });
    expect(field(d, "manager_comment")).toMatchObject({ label: "部長のコメント", prose: true });
    expect(field(d, "source")?.value).toEqual({ type: "text", text: "メールを送る（message）" });
    // 注意が先頭、宛先は件名より前
    const keys = d.fields.map((f) => f.key);
    expect(keys[0]).toBe("warnings");
    expect(keys.indexOf("to")).toBeLessThan(keys.indexOf("subject"));
  });

  test("制御サーバーからの注意（warnings）は、目立たせる印を付ける", () => {
    const d = describeSummary({ ...GMAIL, warnings: ["件名に見えない文字があります"] });
    expect(field(d, "warnings")).toMatchObject({
      label: "制御サーバーからの注意",
      warning: true,
      value: { type: "list", items: ["件名に見えない文字があります"] },
    });
  });

  test("PR のマージ：リポジトリ・PR番号・タイトル・変更ファイル数・マージするコミット。元のリクエストは促すだけ", () => {
    const d = describeSummary(MERGE);
    expect(d.kindLabel).toBe("PR のマージ");
    expect(d.requireFullRequest).toBe(false);
    expect(field(d, "repo")?.value).toEqual({ type: "text", text: "myorg/app" });
    expect(field(d, "number")).toMatchObject({
      label: "PR 番号",
      value: { type: "text", text: "#12" },
    });
    expect(field(d, "title")?.prose).toBe(true);
    expect(field(d, "changed_files")?.value).toEqual({ type: "text", text: "3" });
    expect(field(d, "head_sha")?.label).toContain("マージするコミット");
    expect(field(d, "manager_comment")?.value).toEqual({ type: "empty" });
  });

  test("一時権限：誰が・何の操作を・どのパラメーターで・何時間・理由。制限なしは目立たせる", () => {
    const grant = {
      kind: "grant",
      member_id: "dev-implementer",
      operation: "github.git.push",
      params: { repo: ["myorg/new"] },
      mode: "allow",
      duration_hours: 24,
      reason: "push したい",
      manager_comment: null,
    };
    const d = describeSummary(grant);
    expect(d.kindLabel).toBe("一時権限");
    expect(d.requireFullRequest).toBe(false);
    expect(field(d, "params")?.value).toEqual({ type: "list", items: ["repo=myorg/new"] });
    expect(field(d, "duration_hours")?.value).toEqual({ type: "text", text: "24時間" });
    expect(field(d, "mode")?.value).toEqual({
      type: "text",
      text: "承認なしで、そのまま通る（allow）",
    });
    expect(field(d, "reason")?.prose).toBe(true);
    expect(field(describeSummary({ ...grant, params: {} }), "params")?.value).toEqual({
      type: "text",
      text: "⚠ 制限なし（この操作のすべてに効く）",
    });
  });

  test("知らない項目・知らない種類も、黙って捨てずに全部見せる（表示した要約が署名の対象）", () => {
    const d = describeSummary({ kind: "slack_message", zzz: "#general", extra: { a: 1 } });
    expect(d.kindLabel).toBe("slack_message");
    expect(d.requireFullRequest).toBe(true);
    expect(d.fields.map((f) => f.key)).toEqual(["zzz", "extra"]);
    expect(d.fields[1]?.value).toEqual({ type: "json", text: '{\n  "a": 1\n}' });
  });

  test("要約の種類がない（default）：メソッド・URL・本文の大きさと先頭", () => {
    const d = describeSummary({
      kind: "default",
      method: "POST",
      url: "https://api.example.com/v1/send",
      body_bytes: 2048,
      body_head: "{}",
      body_head_encoding: "text",
      body_truncated: false,
    });
    expect(d.kindLabel).toBe("リクエスト");
    expect(d.requireFullRequest).toBe(true);
    expect(field(d, "body_bytes")?.value).toEqual({ type: "text", text: "2.0 KiB（2048 バイト）" });
  });

  test("要約がオブジェクトでなくても落ちない", () => {
    expect(describeSummary(null).fields).toEqual([]);
    expect(describeSummary("text").fields).toEqual([
      { key: "(値)", label: "値", value: { type: "text", text: "text" }, prose: true },
    ]);
  });

  test("一覧の1行：宛先・件名（配列でも）、リポジトリ#PR。見えない文字は印にする", () => {
    expect(
      shortSummary({
        ...GMAIL,
        to: ["a@example.com", "b@example.com", "c@example.com"],
        subject: ["件名\u{202E}です"],
      }),
    ).toBe("宛先 a@example.com ほか2件・件名「件名[U+202E]です」");
    expect(shortSummary({ ...GMAIL, subject: "文字列の件名" })).toContain("件名「文字列の件名」");
    expect(shortSummary(MERGE)).toBe("myorg/app #12「README の誤字を直す」");
    expect(shortSummary({ kind: "default", method: "POST", url: "https://h.example/x" })).toBe(
      "POST https://h.example/x",
    );
    expect(shortSummary({ kind: "gmail_message", subject: ["あ".repeat(200)] })).toHaveLength(80);
  });

  test("バイト数", () => {
    expect(formatBytes(12)).toBe("12 バイト");
    expect(formatBytes(1536)).toBe("1.5 KiB（1536 バイト）");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MiB（10485760 バイト）");
  });
});
