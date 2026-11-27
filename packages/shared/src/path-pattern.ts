/**
 * サービス定義のパスのパターン（5.2.3 の3・4）。
 *
 * - `*`    ：パスの1区切り（`/` を含まない1つ以上の文字）。区切り全体にだけ書ける
 * - `**`   ：パスの0個以上の区切り。末尾にだけ書ける。`/**` で終わるパターンは、その手前までのパスそのものにも一致する
 * - `{name}`：パラメーター。何区切りを取るかは、サービス定義の `params` で決める（例：`repo` は2区切り）
 * - クエリ文字列は照合に使わない
 *
 * 解釈が分かれるパス（`.`・`..` の区切り、エンコードした `.`・`/`・`\`、`\`、制御文字）は、
 * どのパターンにも一致させない。外のサーバーがパスを正規化したときに、
 * 判定したものと違うリソースに届いてしまうのを防ぐため（P-3「書いていないことは禁止」）。
 */

export class PathPatternError extends Error {
  override name = "PathPatternError";
}

export interface PathPattern {
  /** 元のパターン文字列 */
  readonly source: string;
  /** 一致すればパラメーターの値を、一致しなければ null を返す */
  match(path: string): Record<string, string> | null;
}

const PARAM_NAME = /^[a-z][a-z0-9_]*$/;

export function compilePathPattern(
  pattern: string,
  paramSegments: Readonly<Record<string, number>>,
): PathPattern {
  if (!pattern.startsWith("/")) {
    throw new PathPatternError(`パターンは / で始めてください: ${pattern}`);
  }

  const names: string[] = [];
  const segments = pattern.slice(1).split("/");
  let regex = "";

  segments.forEach((segment, i) => {
    const isLast = i === segments.length - 1;
    if (segment === "**") {
      if (!isLast) {
        throw new PathPatternError(`** は末尾にだけ書けます: ${pattern}`);
      }
      regex += "(?:/.*)?";
      return;
    }
    if (segment.includes("**")) {
      throw new PathPatternError(`** は区切り全体として書いてください: ${pattern}`);
    }
    if (segment === "*") {
      regex += "/[^/]+";
      return;
    }
    if (segment.includes("*")) {
      throw new PathPatternError(`* は区切り全体として書いてください: ${pattern}`);
    }
    regex += `/${compileSegment(segment, pattern, paramSegments, names)}`;
  });

  const re = new RegExp(`^${regex}$`);

  return {
    source: pattern,
    match(path: string): Record<string, string> | null {
      const target = stripQueryAndFragment(path);
      if (!isUnambiguousPath(target)) return null;
      const m = re.exec(target);
      if (!m) return null;
      const values: Record<string, string> = {};
      names.forEach((name, i) => {
        values[name] = m[i + 1] as string;
      });
      return values;
    },
  };
}

function compileSegment(
  segment: string,
  pattern: string,
  paramSegments: Readonly<Record<string, number>>,
  names: string[],
): string {
  let out = "";
  let rest = segment;
  while (rest.length > 0) {
    const open = rest.indexOf("{");
    const close = rest.indexOf("}");
    if (open === -1) {
      if (close !== -1) throw new PathPatternError(`} の対応がありません: ${pattern}`);
      out += escapeRegExp(rest);
      break;
    }
    if (close !== -1 && close < open) {
      throw new PathPatternError(`} の対応がありません: ${pattern}`);
    }
    const end = rest.indexOf("}", open);
    if (end === -1) throw new PathPatternError(`{ が閉じていません: ${pattern}`);

    out += escapeRegExp(rest.slice(0, open));
    const name = rest.slice(open + 1, end);
    if (!PARAM_NAME.test(name)) {
      throw new PathPatternError(`パラメーター名が不正です: {${name}}（${pattern}）`);
    }
    const count = Object.hasOwn(paramSegments, name) ? paramSegments[name] : undefined;
    if (count === undefined || !Number.isInteger(count) || count < 1) {
      throw new PathPatternError(`params に定義のないパラメーターです: {${name}}（${pattern}）`);
    }
    if (names.includes(name)) {
      throw new PathPatternError(`同じパラメーターが2回出てきます: {${name}}（${pattern}）`);
    }
    names.push(name);
    out += `([^/]+${"(?:/[^/]+)".repeat(count - 1)})`;
    rest = rest.slice(end + 1);
  }
  return out;
}

function stripQueryAndFragment(path: string): string {
  const cut = path.search(/[?#]/);
  return cut === -1 ? path : path.slice(0, cut);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を含むパスを拒否するため
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ENCODED_SEPARATORS = /%(2e|2f|5c)/i;

function isUnambiguousPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  if (CONTROL_CHARS.test(path)) return false;
  if (ENCODED_SEPARATORS.test(path)) return false;
  return path
    .slice(1)
    .split("/")
    .every((segment) => segment !== "." && segment !== "..");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}
