import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.ts";

// 正規化JSON：キーを辞書順に並べ、空白なし（5.8 の3の4、5.10 の2、5.3.5 の1）
describe("canonicalJson", () => {
  it("オブジェクトのキーを辞書順に並べ、空白を入れない", () => {
    expect(canonicalJson({ b: 1, a: "x", c: true })).toBe('{"a":"x","b":1,"c":true}');
  });

  it("入れ子のオブジェクトも辞書順に並べる", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] })).toBe(
      '{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}',
    );
  });

  it("キーを入れた順番が違っても、同じ文字列になる", () => {
    const a = { type: "hold", id: "h_1", decision: "approve" };
    const b = { decision: "approve", id: "h_1", type: "hold" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("配列の順番はそのまま保つ", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("文字列は JSON の書き方でエスケープする", () => {
    expect(canonicalJson({ s: 'a"b\\c\n' })).toBe('{"s":"a\\"b\\\\c\\n"}');
    expect(canonicalJson("日本語")).toBe('"日本語"');
  });

  it("null・真偽値・数値をそのまま書く", () => {
    expect(canonicalJson({ n: null, t: true, f: false, i: 42, x: 1.5, neg: -3 })).toBe(
      '{"f":false,"i":42,"n":null,"neg":-3,"t":true,"x":1.5}',
    );
  });

  it("値が undefined のプロパティは書かない（JSON.stringify と同じ）", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  describe("ハッシュの元にできない値は、黙って変換せずにエラーにする", () => {
    it.each([
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["bigint", 1n],
      ["関数", () => 1],
      ["Symbol", Symbol("s")],
      ["Date", new Date(0)],
      ["Map", new Map()],
      ["トップレベルの undefined", undefined],
    ])("%s", (_label, value) => {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    });

    it("配列の中の undefined", () => {
      expect(() => canonicalJson([1, undefined])).toThrow(TypeError);
    });

    it("循環参照", () => {
      const a: Record<string, unknown> = {};
      a.self = a;
      expect(() => canonicalJson(a)).toThrow(TypeError);
    });
  });

  it("同じオブジェクトが2か所に出てくるだけなら循環ではない", () => {
    const shared = { v: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });
});
