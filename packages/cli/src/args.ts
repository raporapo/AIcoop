/**
 * 引数の読み取り。`node:util` の `parseArgs` で字句に分け（tokens）、誤りは自分で日本語にする。
 *
 * parseArgs の strict モードの誤りは英語で、どのオプションの誤りかも取り出しにくいので、
 * strict: false で字句だけを受け取り、知らないオプション・値の有無・重なりをここで確かめる。
 */
import { parseArgs } from "node:util";
import { UsageError } from "./errors.ts";
import { suggest } from "./suggest.ts";

export interface OptionSpec {
  /** `--` を除いた長い名前 */
  readonly name: string;
  readonly short?: string;
  readonly type: "string" | "boolean";
  /** 使い方に出す値の名前（例：`<文>`） */
  readonly value?: string;
  readonly description: string;
  /** なければ使い方の誤り（--help のときは責めない） */
  readonly required?: boolean;
  /** 使い方（--help）に出さない */
  readonly hidden?: boolean;
}

export interface PositionalSpec {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

export interface ArgSpec {
  readonly options: readonly OptionSpec[];
  readonly positionals: readonly PositionalSpec[];
}

export interface ParsedArgs {
  readonly values: Readonly<Record<string, string | boolean | undefined>>;
  readonly positionals: readonly string[];
}

/** オプションの形をしたもの（`--foo`、`-f`）。値の「- 一つ目」や「-5」はオプションとみなさない */
const OPTION_LIKE = /^--?[A-Za-z]/;

/** 日本語入力のまま打った「－－」「ーー」「−−」など */
const FULLWIDTH_DASHES = /^[－ー―‐−–—]{1,2}(?=\S)/;

const QUOTE_HINT = '空白を含む文は "..." で囲んでください（例：--purpose "README を直す"）';

export function parseCommandArgs(
  command: string,
  spec: ArgSpec,
  args: readonly string[],
): ParsedArgs {
  const byName = new Map(spec.options.map((o) => [o.name, o]));
  const longNames = spec.options.filter((o) => !o.hidden).map((o) => `--${o.name}`);
  const helpFor = `くわしくは aicoop ${command} --help`;

  const parsed = parseArgs({
    args: [...args],
    options: Object.fromEntries(
      spec.options.map((o) => [
        o.name,
        o.short ? { type: o.type, short: o.short } : { type: o.type },
      ]),
    ),
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  const values: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  let afterTerminator = false;

  for (const token of parsed.tokens ?? []) {
    if (token.kind === "option-terminator") {
      afterTerminator = true;
      continue;
    }
    if (token.kind === "positional") {
      if (!afterTerminator) rejectFullwidthOption(token.value, longNames, helpFor);
      positionals.push(token.value);
      continue;
    }
    const option = byName.get(token.name);
    if (
      option === undefined ||
      (token.rawName.startsWith("--") && token.rawName !== `--${option.name}`)
    ) {
      const close = suggest(token.rawName, longNames);
      throw new UsageError(`知らないオプションです：${token.rawName}`, [
        ...(close.length > 0 ? [`もしかして ${close.join("、")}`] : []),
        helpFor,
      ]);
    }
    const shown = `--${option.name}`;
    if (Object.hasOwn(values, option.name)) {
      throw new UsageError(`${shown} が2回あります。1回だけ書いてください`, [helpFor]);
    }
    if (option.type === "boolean") {
      if (token.value !== undefined) {
        throw new UsageError(`${shown} は値をとりません（${token.rawName}=${token.value}）`, [
          `${shown} だけを書いてください`,
        ]);
      }
      values[option.name] = true;
      continue;
    }
    const value = token.value;
    if (value === undefined || (!token.inlineValue && OPTION_LIKE.test(value))) {
      throw new UsageError(`${shown} の値がありません`, [
        `${shown} ${option.value ?? "<値>"} の形で書いてください。${QUOTE_HINT}`,
      ]);
    }
    values[option.name] = value;
  }

  if (values.help === true) return { values, positionals };

  const required = spec.positionals.filter((p) => p.required);
  if (positionals.length < required.length) {
    const missing = required.slice(positionals.length);
    throw new UsageError(`${missing.map((p) => `<${p.name}>`).join(" ")} がありません`, [
      ...missing.map((p) => `<${p.name}>：${p.description}`),
      helpFor,
    ]);
  }
  if (positionals.length > spec.positionals.length) {
    const extra = positionals.slice(spec.positionals.length);
    throw new UsageError(`余分な引数があります：${extra.join(" ")}`, [QUOTE_HINT, helpFor]);
  }
  const missingOptions = spec.options.filter((o) => o.required && values[o.name] === undefined);
  if (missingOptions.length > 0) {
    const names = missingOptions.map((o) => `--${o.name}`).join("・");
    throw new UsageError(`${names} がありません（必須です）`, [
      ...missingOptions.map((o) => `--${o.name} ${o.value ?? "<値>"}：${o.description}`),
      helpFor,
    ]);
  }
  return { values, positionals };
}

function rejectFullwidthOption(value: string, longNames: readonly string[], helpFor: string): void {
  const match = FULLWIDTH_DASHES.exec(value);
  if (!match) return;
  const name = value.slice(match[0].length).normalize("NFKC");
  const fixed = `--${name}`;
  const close = longNames.includes(fixed) ? [fixed] : suggest(fixed, longNames);
  throw new UsageError(`「${value}」の「${match[0]}」は全角の記号です。半角の - にしてください`, [
    ...(close.length > 0 ? [`もしかして ${close.join("、")}`] : []),
    helpFor,
  ]);
}
