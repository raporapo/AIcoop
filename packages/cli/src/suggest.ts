/**
 * 打ち間違いの候補（「もしかして」）。コマンド名・オプション名・社員ID・状態などに使う。
 *
 * 比べる前に NFKC で正規化して小文字にする（全角の ｒｕｎ や大文字の INIT も拾う）。
 * 距離は「隣の2文字の入れ替え」を1回と数える編集距離（Damerau–Levenshtein の制限版）。
 */

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** 入れ替え（ab → ba）を1回と数える編集距離 */
export function editDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const rows = x.length + 1;
  const cols = y.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  const at = (i: number, j: number) => d[i]?.[j] ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1);
      }
      const row = d[i];
      if (row) row[j] = best;
    }
  }
  return at(rows - 1, cols - 1);
}

/**
 * `input` に近い候補を、近い順に `max` 個まで返す。
 * 許す距離は、長さ4までは1、8までは2、それより長ければ3。前方一致（2文字以上）も候補にする。
 */
export function suggest(input: string, candidates: readonly string[], max = 3): string[] {
  const x = normalize(input);
  if (x === "") return [];
  const length = [...x].length;
  const limit = length <= 4 ? 1 : length <= 8 ? 2 : 3;
  const scored: { candidate: string; score: number }[] = [];
  for (const candidate of new Set(candidates)) {
    const c = normalize(candidate);
    if (c === x) {
      scored.push({ candidate, score: 0 });
      continue;
    }
    const distance = editDistance(x, c);
    if (distance <= limit) {
      scored.push({ candidate, score: distance });
    } else if (length >= 2 && c.startsWith(x)) {
      // 前方一致は、距離のあるものより後ろ
      scored.push({ candidate, score: limit + 0.5 });
    }
  }
  return scored
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, max)
    .map((s) => s.candidate);
}
