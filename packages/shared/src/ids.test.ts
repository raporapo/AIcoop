import { describe, expect, it } from "vitest";
import { ID_PREFIXES, type IdKind, idKind, isId, newId } from "./ids.ts";

const KINDS: readonly [IdKind, string][] = [
  ["company", "c_"],
  ["task", "t_"],
  ["run", "r_"],
  ["hold", "h_"],
  ["grant", "g_"],
  ["ticket", "k_"],
  ["approval", "a_"],
  ["device", "d_"],
  // 5.14：設定・資格の画面の、署名を待つ変更（メモリだけ。state.db には入れない）
  ["change", "x_"],
];

// ID：種類を表す接頭辞 + ULID（7.1）
describe("newId", () => {
  it.each(KINDS)("7.1：%s の ID は接頭辞 %s + ULID（26文字）", (kind, prefix) => {
    const id = newId(kind);
    expect(id.startsWith(prefix)).toBe(true);
    expect(id).toMatch(/^[a-z]_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ID_PREFIXES[kind]).toBe(prefix);
  });

  it("7.1：接頭辞は種類ごとに違う（取り違えて読めない）", () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("7.1：同じミリ秒に作っても、作った順に並ぶ（monotonic）", () => {
    const t = Date.parse("2026-11-28T00:00:00.000Z");
    const ids = Array.from({ length: 1000 }, () => newId("task", t));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("7.1：時刻が進めば、あとの ID ほど後ろに並ぶ", () => {
    const a = newId("task", Date.parse("2026-11-28T00:00:00.000Z"));
    const b = newId("task", Date.parse("2026-11-28T00:00:00.001Z"));
    expect(a < b).toBe(true);
  });

  it("時計が戻っても、あとで作った ID は前の ID より後ろに並ぶ", () => {
    const a = newId("task", Date.parse("2026-11-28T00:00:01.000Z"));
    const b = newId("task", Date.parse("2026-11-28T00:00:00.000Z"));
    expect(a < b).toBe(true);
  });
});

describe("isId・idKind", () => {
  it.each(KINDS)("作った %s の ID は、その種類として読める", (kind) => {
    const id = newId(kind);
    expect(isId(id, kind)).toBe(true);
    expect(idKind(id)).toBe(kind);
  });

  it("別の種類の ID は、その種類として読めない（保留の ID を一時権限として扱わない）", () => {
    const hold = newId("hold");
    expect(isId(hold, "grant")).toBe(false);
    expect(isId(hold, "task")).toBe(false);
  });

  it("設計書の例の会社 ID を読める（6.2）", () => {
    expect(idKind("c_01JD6V8X3S0Q5W7KQ9M2T4R6YB")).toBe("company");
  });

  describe("知らない接頭辞や壊れた ULID は偽にする", () => {
    const ulid = "01JD6V8X3S0Q5W7KQ9M2T4R6YB";
    it.each([
      ["知らない接頭辞", `z_${ulid}`],
      ["接頭辞なし", ulid],
      ["接頭辞が大文字", `T_${ulid}`],
      ["区切りの _ がない", `t${ulid}`],
      ["区切りが2つ", `t__${ulid}`],
      ["短い", `t_${ulid.slice(0, 25)}`],
      ["長い", `t_${ulid}0`],
      ["Crockford の base32 にない文字（I）", `t_01JD6V8X3S0Q5W7KQ9M2T4R6YI`],
      ["Crockford の base32 にない文字（L）", `t_01JD6V8X3S0Q5W7KQ9M2T4R6YL`],
      ["Crockford の base32 にない文字（O）", `t_01JD6V8X3S0Q5W7KQ9M2T4R6YO`],
      ["Crockford の base32 にない文字（U）", `t_01JD6V8X3S0Q5W7KQ9M2T4R6YU`],
      ["小文字（正規の形ではない）", `t_${ulid.toLowerCase()}`],
      ["時刻の部分があふれる（先頭が 8 以上）", `t_8${ulid.slice(1)}`],
      ["前後に空白", ` t_${ulid}`],
      ["末尾の改行", `t_${ulid}\n`],
      ["パスの区切りを含む", `t_../${ulid.slice(3)}`],
      ["空文字", ""],
    ])("%s", (_label, value) => {
      expect(idKind(value)).toBeNull();
      expect(isId(value, "task")).toBe(false);
    });

    it.each([
      ["数値", 1],
      ["null", null],
      ["undefined", undefined],
      ["オブジェクト", { id: `t_${ulid}` }],
    ])("文字列でない値（%s）", (_label, value) => {
      expect(idKind(value)).toBeNull();
      expect(isId(value, "task")).toBe(false);
    });
  });
});
