/**
 * 正規化JSON（キーを辞書順に並べ、空白なし）。
 *
 * 承認の payload（5.8 の3の4）、監査ログのハッシュ（5.10 の2）、道具の説明文の固定（5.3.5 の1）で、
 * 「同じ内容なら必ず同じバイト列になる」ことを保証するために使う。
 *
 * - キーの順は UTF-16 のコード単位の順（RFC 8785 と同じ）
 * - 値が undefined のプロパティは書かない（JSON.stringify と同じ）
 * - JSON にそのまま書けない値（NaN・bigint・Date・Map・循環参照など）は、黙って変換せずに TypeError にする
 */
export function canonicalJson(value: unknown): string {
  return write(value, new Set());
}

function write(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`正規化JSONにできない数値です: ${value}`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`正規化JSONにできない値です: ${typeof value}`);
  }

  if (ancestors.has(value)) {
    throw new TypeError("正規化JSONにできない値です: 循環参照");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item, i) => {
        if (item === undefined) {
          throw new TypeError(`正規化JSONにできない値です: 配列の ${i} 番目が undefined`);
        }
        return write(item, ancestors);
      });
      return `[${items.join(",")}]`;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(
        `正規化JSONにできない値です: ${proto?.constructor?.name ?? "不明"} のインスタンス`,
      );
    }

    const record = value as Record<string, unknown>;
    const members: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const v = record[key];
      if (v === undefined) continue;
      members.push(`${JSON.stringify(key)}:${write(v, ancestors)}`);
    }
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
