import { describe, expect, it } from "vitest";
import { extractSetupToken } from "./setup-token.ts";

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
});
