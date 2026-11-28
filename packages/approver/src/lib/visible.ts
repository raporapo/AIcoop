/**
 * 外から来た文章（メールの本文・Issue・AI 社員の報告など）を画面に出す前に、見えない文字と
 * 向きを変える文字を、見える印（`[U+202E]` など）に置き換える（5.8 の4）。
 *
 * 範囲は daemon の report_result の検査（H-11）・CLI の無害化（CL-20）と同じものに、ゼロ幅・タグ文字・
 * 行区切り・対にならないサロゲートなどを足したもの。文字そのものは画面に出さないので、
 * 向きを変える文字でまわりの表示が入れ替わることもない。
 */

export type VisibleSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "hidden"; readonly code: string; readonly label: string };

export interface RevealedText {
  readonly segments: readonly VisibleSegment[];
  /** 印にした文字の数 */
  readonly hiddenCount: number;
  /** 向きを変える文字が入っていたか */
  readonly hasBidi: boolean;
}

/** 向きを変える文字（Unicode の双方向の書式文字） */
function isBidiControl(cp: number): boolean {
  return (
    cp === 0x061c ||
    cp === 0x200e ||
    cp === 0x200f ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

/** 見えない（幅のない・空白に見えない）のに、文字として入るもの */
const INVISIBLE_LETTERS = new Set([0x034f, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x3164, 0xffa0]);

const FORMAT_CHAR = /^\p{Cf}$/u;

function classify(ch: string, cp: number): string | null {
  if (ch === "\n" || ch === "\t") return null;
  if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return "制御文字";
  if (isBidiControl(cp)) return "向きを変える文字";
  if (cp === 0x2028) return "行区切り";
  if (cp === 0x2029) return "段落区切り";
  if (cp >= 0xd800 && cp <= 0xdfff) return "壊れた文字";
  if (INVISIBLE_LETTERS.has(cp) || FORMAT_CHAR.test(ch)) return "見えない文字";
  return null;
}

function codeOf(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function revealInvisible(input: string): RevealedText {
  // CRLF は改行1つにそろえる（単独の CR は、行の頭に戻って上書きに見せられるので印にする）
  const text = input.replace(/\r\n/g, "\n");
  const segments: VisibleSegment[] = [];
  let buffer = "";
  let hiddenCount = 0;
  let hasBidi = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const label = classify(ch, cp);
    if (label === null) {
      buffer += ch;
      continue;
    }
    if (buffer !== "") {
      segments.push({ kind: "text", text: buffer });
      buffer = "";
    }
    segments.push({ kind: "hidden", code: codeOf(cp), label });
    hiddenCount++;
    if (label === "向きを変える文字") hasBidi = true;
  }
  if (buffer !== "") segments.push({ kind: "text", text: buffer });
  return { segments, hiddenCount, hasBidi };
}

/** 印にした形の文字列（`aria-label`・title・確認の文などに使う） */
export function revealedString(input: string): string {
  return revealInvisible(input)
    .segments.map((s) => (s.kind === "text" ? s.text : `[${s.code}]`))
    .join("");
}
