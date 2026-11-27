/**
 * ID：種類を表す接頭辞 + ULID（7.1）。
 *
 * - 同じ種類の ID は、作った順に文字列として並ぶ（同じミリ秒の中でも。ulid の monotonic を使う）
 * - 読むときは、接頭辞と ULID の形を厳しく確かめる。知らない接頭辞、壊れた ULID、
 *   小文字の ULID（正規の形ではない）は、どれも ID として認めない（拒否側に倒す）
 */
import { monotonicFactory } from "ulid";

export const ID_PREFIXES = {
  company: "c_",
  task: "t_",
  run: "r_",
  hold: "h_",
  grant: "g_",
  ticket: "k_",
  approval: "a_",
  device: "d_",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const KIND_BY_PREFIX: ReadonlyMap<string, IdKind> = new Map(
  (Object.entries(ID_PREFIXES) as [IdKind, string][]).map(([kind, prefix]) => [prefix, kind]),
);

/**
 * ULID の正規の形：Crockford の base32（I・L・O・U を使わない）の大文字26文字。
 * 先頭の文字は 0〜7（48ビットの時刻があふれない）。
 */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const ID_PATTERN = /^([a-z]_)([0-7][0-9A-HJKMNP-TV-Z]{25})$/;

// 1つのプロセスで1つのファクトリーを使う。時計が戻っても、前の ID より後ろに並ぶ
const nextUlid = monotonicFactory();

/**
 * 新しい ID を作る。
 * @param now 時刻（ミリ秒）。テストで同じミリ秒を作るときだけ渡す
 */
export function newId(kind: IdKind, now: number = Date.now()): string {
  const ulid = nextUlid(now);
  if (!ULID_PATTERN.test(ulid)) {
    // ulid のライブラリが正規の形でない値を返したら、黙って使わずに止める
    throw new Error("ULID を作れませんでした");
  }
  return `${ID_PREFIXES[kind]}${ulid}`;
}

/** ID の種類を返す。ID として読めなければ null */
export function idKind(value: unknown): IdKind | null {
  if (typeof value !== "string") return null;
  const m = ID_PATTERN.exec(value);
  if (!m) return null;
  return KIND_BY_PREFIX.get(m[1] as string) ?? null;
}

/** `value` が `kind` の ID か */
export function isId(value: unknown, kind: IdKind): value is string {
  return idKind(value) === kind;
}
