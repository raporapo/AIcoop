/**
 * 端末に出す文字列の幅と、外から来た文字列の無害化。
 *
 * - 幅：全角（東アジアの広い文字）を2、結合文字を0と数える。色の符号は数えない
 * - 無害化：タスクの目的・要約・実行の記録は、箱の中のAI（乗っ取られている前提。4.5 の Z3）や
 *   外の人が書いた文章を含む。端末の制御符号（画面を消す、題名を変える、表示を偽る）や、
 *   表示の向きを変える文字をそのまま出すと、オーナーの画面を偽れるので、見える印に置き換える
 */

// biome-ignore lint/suspicious/noControlCharactersInRegex: 端末の色の符号（ESC）を見つけるための式
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** 端末を操る文字：C0（タブ・改行を除く）、DEL、C1、表示の向きを変える文字、見えない区切り */
const CONTROL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を見つけて消すための式
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

const REPLACEMENT = "\ufffd";

/** 1行に収める（改行・タブは空白に） */
export function cleanLine(text: string): string {
  return text.replace(/\r\n|[\r\n\t]/g, " ").replace(CONTROL, REPLACEMENT);
}

/** 複数行のまま出す（CRLF は LF に、タブは空白2つに） */
export function cleanBlock(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(CONTROL, REPLACEMENT);
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0xfeff ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isZeroWidth(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch);
  return width;
}

export function padEnd(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

export function padStart(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? " ".repeat(gap) + text : text;
}

/** 表示の幅が `width` に収まるように切る（色の符号を含まない文字列に使う） */
export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  if (width <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return `${out}…`;
}

/** 複数行の文章を、先頭の `maxLines` 行に切る。切ったら残りの行数を返す */
export function headLines(
  text: string,
  maxLines: number,
): { readonly lines: string[]; readonly omitted: number } {
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length <= maxLines) return { lines, omitted: 0 };
  return { lines: lines.slice(0, maxLines), omitted: lines.length - maxLines };
}
