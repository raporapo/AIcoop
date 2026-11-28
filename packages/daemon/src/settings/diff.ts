/**
 * 設定の画面の差分（5.14 の4の3）：2つの中身から unified diff（前後3行）を作る。
 *
 * 行の比べ方は Myers の差分。変更が大きすぎる（編集の距離が MAX_EDIT_DISTANCE を超える）ときは、
 * 「前をすべて消して、後をすべて足す」差分にする（計算の時間とメモリを抑えるため。差分としては正しい）。
 */

const CONTEXT = 3;
const MAX_EDIT_DISTANCE = 2000;

interface Line {
  readonly text: string;
  /** 行の終わりに改行がある */
  readonly eol: boolean;
}

type Op = { readonly kind: " " | "-" | "+"; readonly line: Line };

function splitLines(text: string): Line[] {
  if (text === "") return [];
  const parts = text.split("\n");
  const last = parts.pop() as string;
  const lines: Line[] = parts.map((t) => ({ text: t, eol: true }));
  if (last !== "") lines.push({ text: last, eol: false });
  return lines;
}

const same = (a: Line, b: Line) => a.text === b.text && a.eol === b.eol;

/** Myers の差分。距離が上限を超えたら null */
function myers(a: readonly Line[], b: readonly Line[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const trace: Int32Array[] = [];
  let v: Int32Array = new Int32Array(2 * max + 3);
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAX_EDIT_DISTANCE); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
        x = v[offset + k + 1] as number;
      } else {
        x = (v[offset + k - 1] as number) + 1;
      }
      let y = x - k;
      while (x < n && y < m && same(a[x] as Line, b[y] as Line)) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;

  // たどり直す
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    v = trace[d] as Int32Array;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
        ? k + 1
        : k - 1;
    const prevX = v[offset + prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: " ", line: a[x] as Line });
    }
    if (x === prevX) {
      y--;
      ops.push({ kind: "+", line: b[y] as Line });
    } else {
      x--;
      ops.push({ kind: "-", line: a[x] as Line });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: " ", line: a[x] as Line });
  }
  return ops.reverse();
}

function range(start: number, count: number): string {
  // 数が0なら、前の行の番号（GNU diff と同じ）
  const s = count === 0 ? start - 1 : start;
  return count === 1 ? `${s}` : `${s},${count}`;
}

function formatLine(op: Op): string {
  const text = `${op.kind}${op.line.text}\n`;
  return op.line.eol ? text : `${text}\\ No newline at end of file\n`;
}

/**
 * unified diff。`before` が null なら新しいファイル（`--- /dev/null`）。
 * 中身が同じなら、見出しの2行だけ
 */
export function unifiedDiff(path: string, before: string | null, after: string): string {
  const a = splitLines(before ?? "");
  const b = splitLines(after);
  const ops = myers(a, b) ?? [
    ...a.map((line): Op => ({ kind: "-", line })),
    ...b.map((line): Op => ({ kind: "+", line })),
  ];
  let out = `--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ b/${path}\n`;

  const changed: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind !== " ") changed.push(i);
  });
  if (changed.length === 0) return out;

  // 変更の位置から、前後3行の塊をつくる（近いものはまとめる）
  const hunks: Array<{ start: number; end: number }> = [];
  for (const i of changed) {
    const start = Math.max(0, i - CONTEXT);
    const end = Math.min(ops.length, i + CONTEXT + 1);
    const last = hunks[hunks.length - 1];
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end);
    else hunks.push({ start, end });
  }

  // 塊の始まりの行の番号を数えるため、ops を先頭から数える
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;
  for (const h of hunks) {
    for (; cursor < h.start; cursor++) {
      const op = ops[cursor] as Op;
      if (op.kind !== "+") oldLine++;
      if (op.kind !== "-") newLine++;
    }
    const slice = ops.slice(h.start, h.end);
    const oldCount = slice.filter((o) => o.kind !== "+").length;
    const newCount = slice.filter((o) => o.kind !== "-").length;
    out += `@@ -${range(oldLine, oldCount)} +${range(newLine, newCount)} @@\n`;
    for (const op of slice) out += formatLine(op);
  }
  return out;
}
