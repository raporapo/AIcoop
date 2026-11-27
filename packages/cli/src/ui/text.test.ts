import { describe, expect, it } from "vitest";
import { cleanBlock, cleanLine, displayWidth, padEnd, truncate } from "./text.ts";

describe("表示の幅（日本語の表をそろえる）", () => {
  it("全角は2、半角は1と数える", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("開発部")).toBe(6);
    expect(displayWidth("dev（開発部）")).toBe(3 + 2 * 5);
    expect(displayWidth("ｱｲｳ")).toBe(3); // 半角カナ
  });

  it("色の符号は幅に数えない", () => {
    expect(displayWidth("\u001b[31m赤\u001b[39m")).toBe(2);
  });

  it("結合文字は幅0", () => {
    expect(displayWidth("e\u0301")).toBe(1);
  });

  it("padEnd は表示の幅でそろえる", () => {
    expect(padEnd("開発", 6)).toBe("開発  ");
    expect(padEnd("abc", 2)).toBe("abc");
  });

  it("truncate は幅に収まるように切り、… を付ける", () => {
    expect(truncate("あいうえお", 6)).toBe("あい…");
    expect(displayWidth(truncate("あいうえお", 6))).toBeLessThanOrEqual(6);
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

describe("外から来た文字列を端末に出す前に無害にする（箱の中のAIが書いた文章を含む）", () => {
  it("端末の制御符号（ESC など）を消し、見える印に置き換える", () => {
    const evil = "ok\u001b]0;title\u0007\u001b[2Jdone";
    const shown = cleanLine(evil);
    expect(shown).not.toContain("\u001b");
    expect(shown).not.toContain("\u0007");
    expect(shown).toContain("ok");
    expect(shown).toContain("done");
  });

  it("表示の向きを変える文字（Trojan Source）も消す", () => {
    expect(cleanLine("abc\u202edcba")).not.toContain("\u202e");
    expect(cleanLine("a\u2066b\u2069")).not.toMatch(/[\u2066-\u2069]/);
  });

  it("C1 の制御符号（\\u009b など）も消す", () => {
    expect(cleanLine("a\u009b2Jb")).not.toContain("\u009b");
  });

  it("cleanLine は改行とタブを空白にする。cleanBlock は改行を残す", () => {
    expect(cleanLine("a\nb\tc\r\nd")).toBe("a b c d");
    expect(cleanBlock("a\nb\r\nc")).toBe("a\nb\nc");
    expect(cleanBlock("a\tb")).toBe("a  b");
  });
});
