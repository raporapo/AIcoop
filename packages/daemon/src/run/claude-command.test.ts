import { describe, expect, it } from "vitest";
import { BOX_ENV, claudeArgv, claudeExecEnv, isSafeSessionId } from "./claude-command.ts";

describe("5.4.2：claude -p の起動のしかた（vm の箱）", () => {
  it("引数は設計書のとおり（--resume なし）", () => {
    expect(
      claudeArgv({ prompt: "# 今回のタスク\n…", model: "sonnet", maxTurns: 100, resume: null }),
    ).toEqual([
      "claude",
      "-p",
      "# 今回のタスク\n…",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
      "--max-turns",
      "100",
      "--mcp-config",
      "/etc/aicoop/mcp.json",
      "--strict-mcp-config",
      "--disallowedTools",
      "WebSearch",
      "--dangerously-skip-permissions",
    ]);
  });

  it("T-3：WebSearch は道具の一覧から外す（資格プロキシを通らない。Web は web.read の許可で読む）", () => {
    const argv = claudeArgv({ prompt: "p", model: "sonnet", maxTurns: 1, resume: null });
    const i = argv.indexOf("--disallowedTools");
    expect(i).toBeGreaterThan(0);
    expect(argv[i + 1]).toBe("WebSearch");
  });

  it("5.4.5 の4：続きから始めるときだけ --resume <session_id> を付ける", () => {
    const argv = claudeArgv({
      prompt: "p",
      model: "opus",
      maxTurns: 5,
      resume: "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab",
    });
    expect(argv.slice(-2)).toEqual(["--resume", "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab"]);
  });

  it("オプションに見えるセッションID・モデルは使わない（引数の取り違えを防ぐ）", () => {
    expect(() =>
      claudeArgv({ prompt: "p", model: "sonnet", maxTurns: 5, resume: "--settings=/x" }),
    ).toThrow();
    expect(() => claudeArgv({ prompt: "p", model: "-x", maxTurns: 5, resume: null })).toThrow();
    expect(() => claudeArgv({ prompt: "p", model: "sonnet", maxTurns: 0, resume: null })).toThrow();
  });

  it("環境変数：HOME=/home/agent と不要な通信を止める設定は箱に、Claude のトークンは claude の実行にだけ渡す", () => {
    expect(BOX_ENV).toEqual({
      HOME: "/home/agent",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      IS_SANDBOX: "1",
    });
    expect(claudeExecEnv("sk-ant-oat01-x")).toEqual({
      HOME: "/home/agent",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      IS_SANDBOX: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x",
    });
  });

  it("vm の箱の中の claude は root で動く。--dangerously-skip-permissions は root では断られるので、箱の中であることを IS_SANDBOX=1 で伝える（P1 の結合テストで、本物の Claude Code が起動しなかった不具合）", () => {
    expect(claudeArgv({ prompt: "p", model: "sonnet", maxTurns: 1, resume: null })).toContain(
      "--dangerously-skip-permissions",
    );
    expect(claudeExecEnv("t").IS_SANDBOX).toBe("1");
  });
});

describe("セッションIDの形（箱の中から来る値なので確かめる）", () => {
  it("UUID の形は使える", () => {
    expect(isSafeSessionId("0b1c2d3e-aaaa-bbbb-cccc-1234567890ab")).toBe(true);
  });
  it("- で始まるもの・空白・区切り文字・長すぎるものは使わない", () => {
    for (const bad of ["", "-x", "a b", "a/b", "a\nb", "x".repeat(129), "../x"]) {
      expect(isSafeSessionId(bad)).toBe(false);
    }
  });
});
