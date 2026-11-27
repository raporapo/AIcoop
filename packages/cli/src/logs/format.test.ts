import { describe, expect, it } from "vitest";
import { createStyle } from "../ui/style.ts";
import { createLogFormatter } from "./format.ts";

const plain = createStyle(false);

function format(events: unknown[]): string {
  const f = createLogFormatter({ timeZone: "Asia/Tokyo", style: plain });
  return events.flatMap((e) => f.format(typeof e === "string" ? e : JSON.stringify(e))).join("\n");
}

describe("9.1 aicoop logs：stream-json を人が読める形にする", () => {
  it("開始（system init）：モデルとセッション", () => {
    const out = format([
      {
        type: "system",
        subtype: "init",
        session_id: "abcd1234-5678",
        model: "claude-sonnet-4-5",
        tools: ["Bash", "Read"],
      },
    ]);
    expect(out).toContain("開始");
    expect(out).toContain("claude-sonnet-4-5");
    expect(out).toContain("abcd1234");
  });

  it("Claude の発言（複数行は字下げ）", () => {
    const out = format([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "README を読みます。\n次に直します。" }] },
      },
    ]);
    expect(out).toMatch(/Claude：README を読みます。\n\s+次に直します。/);
  });

  it("道具の呼び出しは要点だけ（Bash はコマンド、Read はファイル）", () => {
    const out = format([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu1", name: "Bash", input: { command: "git status" } },
            { type: "tool_use", id: "tu2", name: "Read", input: { file_path: "/work/README.md" } },
            {
              type: "tool_use",
              id: "tu3",
              name: "mcp__aicoop__report_result",
              input: { summary: "PR を出した\n詳細" },
            },
          ],
        },
      },
    ]);
    expect(out).toContain("→ Bash：git status");
    expect(out).toContain("→ Read：/work/README.md");
    expect(out).toContain("→ 結果の報告（report_result）：PR を出した");
  });

  it("道具の結果は先頭の数行だけ。エラーは目立たせる", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const out = format([
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }],
        },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: long }] },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu1",
              is_error: true,
              content: [{ type: "text", text: "permission denied" }],
            },
          ],
        },
      },
    ]);
    expect(out).toContain("← Bash の結果");
    expect(out).toContain("line 0");
    expect(out).not.toContain("line 19");
    expect(out).toContain("ほか");
    expect(out).toContain("✗ Bash のエラー");
    expect(out).toContain("permission denied");
  });

  it("終わり（result）：成功・ターン数・時間。失敗なら理由", () => {
    expect(
      format([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 12,
          duration_ms: 488_000,
        },
      ]),
    ).toMatch(/終了.*成功.*12ターン.*8分8秒/);
    expect(
      format([{ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 100 }]),
    ).toContain("ターンの上限");
  });

  it("時刻があれば、timezone で前に付ける", () => {
    const out = format([
      {
        type: "assistant",
        timestamp: "2026-11-27T23:31:05.000Z",
        message: { content: [{ type: "text", text: "やあ" }] },
      },
    ]);
    expect(out).toMatch(/^08:31:05 /);
  });

  it("読めない行・知らない種類でも落ちない", () => {
    expect(format(["not json"])).toContain("not json");
    expect(format([{ type: "stream_event" }])).toContain("stream_event");
  });

  it("箱の中から来た文字列の制御符号は、そのままは出さない", () => {
    const out = format([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "a\u001b]0;pwned\u0007\u001b[2Jb" }] },
      },
      "\u001b[2Jraw",
    ]);
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0007");
  });
});
