import { describe, expect, test } from "vitest";
import { revealInvisible } from "./visible.ts";

function shown(text: string): string {
  return revealInvisible(text)
    .segments.map((s) => (s.kind === "text" ? s.text : `[${s.code}]`))
    .join("");
}

describe("外から来た文章の見えない文字を見える形にする（5.8 の4、H-11・CL-20 と同じ範囲）", () => {
  test("ふつうの文章・改行・タブはそのまま", () => {
    const r = revealInvisible("いつもお世話に\nなっております。\tよろしく");
    expect(r.segments).toEqual([
      { kind: "text", text: "いつもお世話に\nなっております。\tよろしく" },
    ]);
    expect(r.hiddenCount).toBe(0);
    expect(r.hasBidi).toBe(false);
  });

  test("向きを変える文字（U+202E など）は、文字そのものを出さずに印にする", () => {
    const r = revealInvisible("invoice\u{202E}fdp.exe");
    expect(shown("invoice\u{202E}fdp.exe")).toBe("invoice[U+202E]fdp.exe");
    expect(r.hasBidi).toBe(true);
    expect(r.hiddenCount).toBe(1);
    // 印の中に元の文字が残っていない
    expect(JSON.stringify(r.segments)).not.toContain("\u{202E}");
    for (const cp of [0x061c, 0x200e, 0x200f, 0x202a, 0x202d, 0x2066, 0x2069]) {
      expect(revealInvisible(`a${String.fromCodePoint(cp)}b`).hasBidi).toBe(true);
    }
  });

  test("制御文字（C0・DEL・C1）・ゼロ幅・タグ文字・行区切りは印にする", () => {
    expect(shown("a\u{0000}b\u{0007}c\u{001B}[31m")).toBe("a[U+0000]b[U+0007]c[U+001B][31m");
    expect(shown("a\u{007F}b\u{0085}c")).toBe("a[U+007F]b[U+0085]c");
    expect(shown("ad\u{200B}min")).toBe("ad[U+200B]min");
    expect(shown("x\u{FEFF}y\u{2060}z")).toBe("x[U+FEFF]y[U+2060]z");
    expect(shown("t\u{E0041}\u{E0042}")).toBe("t[U+E0041][U+E0042]");
    expect(shown("1\u{2028}2\u{2029}3")).toBe("1[U+2028]2[U+2029]3");
    expect(shown("ﾊﾝ\u{3164}ｸﾞﾙ")).toBe("ﾊﾝ[U+3164]ｸﾞﾙ");
  });

  test("CRLF は改行1つにそろえ、単独の CR は印にする", () => {
    expect(shown("一行目\r\n二行目")).toBe("一行目\n二行目");
    expect(shown("上書き\rされる")).toBe("上書き[U+000D]される");
  });

  test("壊れた文字（対にならないサロゲート）は印にする", () => {
    expect(shown("a\u{D800}b")).toBe("a[U+D800]b");
    // 絵文字（正しいサロゲートの対）はそのまま
    expect(shown("😀")).toBe("😀");
  });

  test("印には、種類の日本語の説明が付く", () => {
    const [, mark] = revealInvisible("a\u{202E}").segments;
    expect(mark).toEqual({ kind: "hidden", code: "U+202E", label: "向きを変える文字" });
    const [, zw] = revealInvisible("a\u{200B}").segments;
    expect(zw).toMatchObject({ kind: "hidden", label: "見えない文字" });
    const [, ctl] = revealInvisible("a\u{0007}").segments;
    expect(ctl).toMatchObject({ kind: "hidden", label: "制御文字" });
  });
});
