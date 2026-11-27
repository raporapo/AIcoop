/**
 * ログの伏せ字（11.5）。
 *
 * 実行の記録（`logs/runs/<run_id>.jsonl`）やタスクの `error` に書く前に、
 * - 本物の資格（Anthropic のトークン、発行したトークンなど）の値
 * - 仮の札（Gondolin の `GONDOLIN_SECRET_<16進>`）
 * を伏せ字にする。Claude Code が `env` を表示したり、エラーに値を含めたりしても、ログに残さない。
 */

/** 本物の資格の伏せ字 */
export const SECRET_MASK = "****";

/** 仮の札の伏せ字（11.5 の例のとおり） */
export const PLACEHOLDER_MASK = "GONDOLIN_SECRET_****";

const PLACEHOLDER = /GONDOLIN_SECRET_[0-9A-Za-z]+/g;

/** これより短い値は伏せ字にしない（「a」のような値で、行のすべてが伏せ字になるのを防ぐ） */
const MIN_SECRET_LENGTH = 4;

export type Redactor = (text: string) => string;

/**
 * 伏せ字にする関数を作る。値は、そのままの形と、JSON の文字列の中での形（エスケープしたもの）の
 * 両方を探す。長い値から先に置き換えるので、短い値を含む長い値の一部が残ることはない。
 */
export function createRedactor(secrets: readonly string[]): Redactor {
  const needles = new Set<string>();
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) continue;
    needles.add(secret);
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) needles.add(escaped);
  }
  const ordered = [...needles].sort((a, b) => b.length - a.length);

  return (text) => {
    let out = text;
    for (const needle of ordered) {
      if (out.includes(needle)) out = out.split(needle).join(SECRET_MASK);
    }
    return out.replace(PLACEHOLDER, PLACEHOLDER_MASK);
  };
}
