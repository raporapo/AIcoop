import { describe, expect, it } from "vitest";
import { createRedactor, PLACEHOLDER_MASK, SECRET_MASK } from "./redact.ts";

describe("11.5：ログに書く前に、本物の資格と仮の札を伏せ字にする", () => {
  const token = "sk-ant-oat01-REALTOKENabcdefghijklmnop";
  const issued = "ghs_ISSUEDinstallationTOKEN0123456789";

  it("本物の資格（Anthropic のトークン・発行したトークン）の値は、行のどこにあっても伏せ字になる", () => {
    const redact = createRedactor([token, issued]);
    const line = JSON.stringify({ type: "assistant", text: `env: ${token} / ${issued}${issued}` });
    const out = redact(line);
    expect(out).not.toContain(token);
    expect(out).not.toContain(issued);
    expect(out).toContain(SECRET_MASK);
    // JSON の行の形は崩さない
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it('JSON の文字列の中で書き換わった形（\\n・\\" などのエスケープ）でも伏せ字になる', () => {
    const pem = 'key-with"quote\nand-newline-0123456789';
    const redact = createRedactor([pem]);
    const line = JSON.stringify({ text: `leak ${pem} end` });
    expect(line).not.toContain(pem);
    const out = redact(line);
    expect(out).not.toContain(JSON.stringify(pem).slice(1, -1));
    expect(out).toContain(SECRET_MASK);
  });

  it("仮の札（GONDOLIN_SECRET_...）は GONDOLIN_SECRET_**** になる", () => {
    const redact = createRedactor([]);
    const placeholder = `GONDOLIN_SECRET_${"ab12".repeat(12)}`;
    expect(redact(`GITHUB_TOKEN=${placeholder}`)).toBe(`GITHUB_TOKEN=${PLACEHOLDER_MASK}`);
  });

  it("長い値が短い値を含んでいても、長い方を先に伏せ字にする（一部が残らない）", () => {
    const short = "abcd1234";
    const long = `${short}-and-more-secret`;
    const redact = createRedactor([short, long]);
    const out = redact(`x ${long} y ${short} z`);
    expect(out).not.toContain("and-more-secret");
    expect(out).not.toContain(short);
  });

  it("空や短すぎる値（4文字未満）では、行を書き換えない（あらゆる文字が伏せ字になるのを防ぐ）", () => {
    const redact = createRedactor(["", "ab"]);
    expect(redact("abc ab ab")).toBe("abc ab ab");
  });

  it("資格がないときは、行をそのまま返す", () => {
    const redact = createRedactor([]);
    expect(redact('{"type":"system"}')).toBe('{"type":"system"}');
  });
});
