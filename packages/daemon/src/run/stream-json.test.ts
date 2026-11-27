import { describe, expect, it } from "vitest";
import { parseStreamLine, usageLimitInResult } from "./stream-json.ts";

describe("Claude Code の stream-json を1行ずつ読む（5.4.5・5.4.6・5.5.6）", () => {
  it("5.4.5 の3：最初の system（subtype: init）の session_id を読む", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab",
      tools: ["mcp__aicoop__report_result"],
    });
    expect(parseStreamLine(line)).toEqual({
      kind: "init",
      sessionId: "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab",
    });
  });

  it("init でも session_id が文字列でなければ読まない", () => {
    expect(parseStreamLine('{"type":"system","subtype":"init","session_id":42}')).toEqual({
      kind: "other",
    });
  });

  it("5.4.6 の1：rate_limit_event の状態・再開予定時刻（UNIX 秒）・枠の種類・使用率を読む", () => {
    const line = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1_764_302_400,
        rateLimitType: "five_hour",
        utilization: 0.97,
      },
    });
    expect(parseStreamLine(line)).toEqual({
      kind: "rate_limit",
      status: "rejected",
      resetsAt: new Date(1_764_302_400_000).toISOString(),
      rateLimitType: "five_hour",
      utilization: 0.97,
    });
  });

  it("rate_limit_event の再開予定時刻はミリ秒・ISO の文字列でも読み、読めなければ null", () => {
    const ms = parseStreamLine(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: 1_764_302_400_000 },
      }),
    );
    expect(ms).toMatchObject({ resetsAt: "2025-11-28T04:00:00.000Z" });
    const iso = parseStreamLine(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed_warning", resetsAt: "2026-11-28T05:00:00Z" },
      }),
    );
    expect(iso).toMatchObject({ status: "allowed_warning", resetsAt: "2026-11-28T05:00:00.000Z" });
    const bad = parseStreamLine(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed", resetsAt: "x" },
      }),
    );
    expect(bad).toMatchObject({ resetsAt: null, rateLimitType: null, utilization: null });
  });

  it("知らない状態の rate_limit_event は使わない。使用率は 0〜1 のときだけ使う", () => {
    expect(
      parseStreamLine(
        JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "weird" } }),
      ),
    ).toEqual({ kind: "other" });
    expect(
      parseStreamLine(
        JSON.stringify({
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed", utilization: 85 },
        }),
      ),
    ).toMatchObject({ utilization: null });
  });

  it("5.5.6：result の成否・種類・本文を読む", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "max turns",
    });
    expect(parseStreamLine(line)).toEqual({
      kind: "result",
      isError: true,
      subtype: "error_max_turns",
      text: "max turns",
    });
  });

  it("JSON でない行・オブジェクトでない行は other（落ちない）", () => {
    expect(parseStreamLine("not json")).toEqual({ kind: "other" });
    expect(parseStreamLine("[1,2]")).toEqual({ kind: "other" });
    expect(parseStreamLine("")).toEqual({ kind: "other" });
  });
});

describe("5.4.6 の2：結果のエラーの文言から、利用枠の上限を見分ける", () => {
  it("「usage limit reached|<UNIX 秒>」から再開予定時刻を読む", () => {
    expect(usageLimitInResult("Claude AI usage limit reached|1764302400")).toEqual({
      resetsAt: new Date(1_764_302_400_000).toISOString(),
    });
  });

  it("時刻のない文言（hit your limit・limit reached）は、再開予定時刻なしで上限とみなす", () => {
    expect(usageLimitInResult("You've hit your limit · resets 2am")).toEqual({ resetsAt: null });
    expect(usageLimitInResult("5-hour limit reached ∙ resets 3pm")).toEqual({ resetsAt: null });
  });

  it("上限と関係のないエラーは null", () => {
    expect(usageLimitInResult("Error: tool failed")).toBeNull();
    expect(usageLimitInResult("")).toBeNull();
  });
});
