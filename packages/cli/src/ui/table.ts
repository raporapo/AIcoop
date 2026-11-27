/**
 * 列をそろえた表。セルは呼び出し側で無害化（cleanLine）してから渡す。色はセルに付けてよい。
 */
import type { Style } from "./style.ts";
import { displayWidth, padEnd, padStart, stripAnsi, truncate } from "./text.ts";

export interface Column {
  readonly header: string;
  readonly align?: "left" | "right";
  /** 端末の幅に収まらないとき、この列を切る（1つだけ付ける） */
  readonly flex?: boolean;
}

const GAP = "  ";

export function renderTable(
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
  options: { readonly style: Style; readonly width?: number | undefined },
): string[] {
  const widths = columns.map((c, i) =>
    Math.max(displayWidth(c.header), ...rows.map((r) => displayWidth(r[i] ?? ""))),
  );

  const flexIndex = columns.findIndex((c) => c.flex === true);
  if (options.width !== undefined && flexIndex >= 0) {
    const others = widths.reduce((sum, w, i) => (i === flexIndex ? sum : sum + w), 0);
    const available = options.width - others - GAP.length * (columns.length - 1);
    const current = widths[flexIndex] ?? 0;
    // 狭い端末でも、はみ出させない（切った列がとても狭くなっても）
    if (current > available) widths[flexIndex] = Math.max(available, 1);
  }

  const cell = (text: string, i: number, last: boolean) => {
    const width = widths[i] ?? 0;
    let shown = text;
    if (displayWidth(shown) > width) shown = truncate(stripAnsi(shown), width);
    if (columns[i]?.align === "right") return padStart(shown, width);
    return last ? shown : padEnd(shown, width);
  };
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => cell(c, i, i === cells.length - 1))
      .join(GAP)
      .trimEnd();

  const header = line(columns.map((c) => c.header));
  return [options.style.dim(header), ...rows.map((r) => line(columns.map((_, i) => r[i] ?? "")))];
}
