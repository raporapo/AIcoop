/**
 * 設定の検証（6.10）で見つかった問題。
 * `E-` で始まるものはエラー（起動しない・読み直さない）、`W-` で始まるものは警告。
 */
export interface ConfigIssue {
  readonly code: `E-${string}` | `W-${string}`;
  readonly message: string;
  /** 問題のあった設定ファイル（分かるときだけ） */
  readonly source?: string;
  /** ファイルの中の場所（例：`operations.message.read.match.0.path`） */
  readonly path?: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export function isError(issue: ConfigIssue): boolean {
  return issue.code.startsWith("E-");
}
