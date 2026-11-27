/**
 * コマンドの形。`registry.ts` に、使い方（ヘルプ）と、実行する関数の読み込み先を並べる。
 */
import type { OptionSpec, ParsedArgs, PositionalSpec } from "./args.ts";
import type { CliContext } from "./context.ts";
import type { Printer } from "./ui/printer.ts";

export type CommandSection = "setup" | "daemon" | "secret" | "work" | "record";

export interface CommandExample {
  readonly command: string;
  readonly note: string;
}

export interface CommandInput {
  readonly ctx: CliContext;
  readonly command: CommandDef;
  readonly values: ParsedArgs["values"];
  readonly positionals: readonly string[];
  /** 設定の置き場所（`--home`、なければ AICOOP_HOME、なければ ~/.aicoop）。絶対パス */
  readonly home: string;
  /** 標準出力（結果） */
  readonly out: Printer;
  /** 標準エラー（進み具合・案内・警告） */
  readonly err: Printer;
}

export type CommandRun = (input: CommandInput) => Promise<number>;

export interface CommandDef {
  /** `secret set` のように、空白で区切った名前 */
  readonly name: string;
  readonly section: CommandSection;
  /** 一覧に出す1行の説明 */
  readonly summary: string;
  /** `aicoop ` を除いた使い方の行 */
  readonly usage: readonly string[];
  readonly description?: readonly string[];
  readonly options: readonly OptionSpec[];
  readonly positionals: readonly PositionalSpec[];
  readonly examples: readonly CommandExample[];
  /** 関連するコマンドの名前 */
  readonly related: readonly string[];
  readonly load: () => Promise<{ readonly run: CommandRun }>;
}
