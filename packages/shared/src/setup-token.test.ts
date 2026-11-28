import { describe, expect, it } from "vitest";
import {
  extractLoginUrl,
  extractSetupToken,
  isClaudeLoginUrl,
  setupTokenArgv,
  visibleText,
} from "./setup-token.ts";

const BODY = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcdAA";
const TOKEN = `sk-ant-oat01-${BODY}`;

const ESC = "\x1b";

describe("aicoop login：claude setup-token の画面の記録からトークンを取り出す", () => {
  it("ふつうの1行のトークンを取り出す", () => {
    expect(
      extractSetupToken(`Your OAuth token:\r\n\r\n${TOKEN}\r\n\r\nStore this token securely.\r\n`),
    ).toBe(TOKEN);
  });

  it("色・太字・カーソルの移動（空白の代わり）・OSC 8 のリンクを取り除いて読む", () => {
    const screen =
      `${ESC}[2K${ESC}[1G${ESC}[1mYour${ESC}[1COAuth${ESC}[1Ctoken${ESC}[22m\r\n` +
      `${ESC}]8;;https://example.com${ESC}\\${ESC}[32m${TOKEN}${ESC}[39m${ESC}]8;;${ESC}\\\r\n` +
      `${ESC}[?25h`;
    expect(extractSetupToken(screen)).toBe(TOKEN);
  });

  it("端末の幅で折り返されたトークンをつなぐ（字下げ・枠の線があっても）", () => {
    const a = TOKEN.slice(0, 50);
    const b = TOKEN.slice(50, 90);
    const c = TOKEN.slice(90);
    const screen = `│ ${a} │\r\n│ ${b}   │\r\n│ ${c}${" ".repeat(10)}│\r\n│${" ".repeat(20)}│\r\n│ Store this token securely │\r\n`;
    expect(extractSetupToken(screen)).toBe(TOKEN);
  });

  it("端末の幅が分かれば、幅いっぱいまで埋まった行だけを折り返しとしてつなぐ", () => {
    // 幅 60：1行目は幅いっぱい、次の行の「Done」はトークンの続きではない
    const a = TOKEN.slice(0, 60);
    const b = TOKEN.slice(60);
    expect(extractSetupToken(`${a}\n${b}\n`, 60)).toBe(TOKEN);
    expect(extractSetupToken(`${TOKEN}\nDone\n`, 200)).toBe(TOKEN);
  });

  it("トークンのあとの文章（空白を含む行）はつながない", () => {
    const screen = `${TOKEN}\nStore this token securely.\n`;
    expect(extractSetupToken(screen)).toBe(TOKEN);
  });

  it("何度も描き直されたときは、最後の画面のものを使う", () => {
    const old = `sk-ant-oat01-${"x".repeat(80)}`;
    expect(extractSetupToken(`${old}\r\n${ESC}[2J${ESC}[H${TOKEN}\r\n`)).toBe(TOKEN);
  });

  it("トークンが無い・短すぎる・途中で切れたものは null（貼り付けに切り替える）", () => {
    expect(
      extractSetupToken("Welcome to Claude Code\r\nOpening browser to sign in…\r\n"),
    ).toBeNull();
    expect(extractSetupToken("sk-ant-oat01-abc\r\n")).toBeNull();
    expect(extractSetupToken("")).toBeNull();
  });

  it("説明の文の中の「sk-ant-oat01-」の後ろに文が続くものは拾わない", () => {
    expect(extractSetupToken("Tokens look like sk-ant-oat01-... and last a year\r\n")).toBeNull();
  });

  it("5.14 の3の2：トークンのあとの文が列への移動（ESC[nG）で置かれていても、つなげない", () => {
    expect(extractSetupToken(`${TOKEN}${ESC}[100GStore${ESC}[106Gthis\r\n`)).toBe(TOKEN);
  });
});

describe("5.14 の3の2：claude setup-token の画面の記録から、ログイン用の URL を取り出す", () => {
  const SHORT = "https://claude.ai/oauth/authorize?IMeNLHJMkrH2UN_V5CAd50YPtDYRKh0F903qpeiMx3cE";
  // 本物の setup-token（2.1.332）の画面に似せたもの：語のあいだを列への移動（ESC[nG）で空け、URL は OSC 8 のリンク
  const screen =
    `${ESC}[1C${ESC}[1ABrowser didn't open?${ESC}[23GUse the URL${ESC}[35Gbelow${ESC}[41Gto${ESC}[44Gsign${ESC}[49Gin\r\r\n\r\r\n` +
    `${ESC}]8;id=387dd7;${SHORT}\x07${ESC}[38;5;246m${SHORT}${ESC}[39m${ESC}]8;;\x07\r\r\n\r\r\n` +
    `${ESC}[2GPaste${ESC}[8Gcode${ESC}[13Ghere${ESC}[18Gif${ESC}[21Gprompted\r\r\n`;

  it("リンク（OSC 8）の行き先から読む", () => {
    expect(extractLoginUrl(screen)).toBe(SHORT);
  });

  it("リンクがなければ、画面の文字から読む", () => {
    expect(extractLoginUrl(`Use the URL below\r\n${ESC}[38;5;246m${SHORT}${ESC}[39m\r\n`)).toBe(
      SHORT,
    );
  });

  it("列への移動は空白にする（語がつながらない）", () => {
    expect(visibleText(screen)).toContain("Paste code here if prompted");
  });

  it("ほかのホスト・http・ポート・ユーザー名つき・authorize でないものは拾わない（拒否側）", () => {
    for (const bad of [
      "https://evil.example/oauth/authorize?x",
      "http://claude.ai/oauth/authorize?x",
      "https://claude.ai:8443/oauth/authorize?x",
      "https://user@claude.ai/oauth/authorize?x",
      "https://claude.ai.evil.example/oauth/authorize?x",
      "https://claude.ai/login",
      `https://claude.ai/oauth/authorize?${"a".repeat(5000)}`,
    ]) {
      expect(isClaudeLoginUrl(bad), bad).toBe(false);
      expect(extractLoginUrl(`${ESC}]8;;${bad}\x07x${ESC}]8;;\x07\r\n${bad}\r\n`), bad).toBeNull();
    }
    expect(extractLoginUrl("Opening browser to sign in…\r\n")).toBeNull();
  });
});

describe("CL-24・5.14 の3の2：setup-token を擬似端末で動かす argv", () => {
  it("幅を渡さなければ、aicoop login と同じ", () => {
    expect(setupTokenArgv("linux", "/usr/bin/script", "/home/a/.local/bin/claude")).toEqual([
      "/usr/bin/script",
      "-q",
      "-e",
      "-f",
      "-c",
      "'/home/a/.local/bin/claude' setup-token",
      "/dev/null",
    ]);
  });

  it("幅を渡すと、先に stty で広げる（引用符を含むパスも壊さない）", () => {
    expect(setupTokenArgv("linux", "/usr/bin/script", "/x/it's/claude", 2000)).toEqual([
      "/usr/bin/script",
      "-q",
      "-e",
      "-f",
      "-c",
      "stty cols 2000 rows 50 2>/dev/null; exec '/x/it'\\''s/claude' setup-token",
      "/dev/null",
    ]);
    expect(setupTokenArgv("darwin", "/usr/bin/script", "/x/claude", 2000)).toEqual([
      "/usr/bin/script",
      "-q",
      "/dev/null",
      "/bin/sh",
      "-c",
      'stty cols 2000 rows 50 2>/dev/null; exec "$0" setup-token',
      "/x/claude",
    ]);
  });
});
