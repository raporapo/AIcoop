/**
 * aicoop コマンドの入口：全体のオプション・コマンドの特定・引数の読み取り・使い方・失敗の表示。
 */
import packageJson from "../package.json" with { type: "json" };
import { parseCommandArgs } from "./args.ts";
import type { CommandDef } from "./command.ts";
import type { CliContext } from "./context.ts";
import { CliError, UsageError } from "./errors.ts";
import { EXIT } from "./exit-codes.ts";
import { commandHelp, groupHelp, topHelp } from "./help.ts";
import { resolveHome } from "./home.ts";
import {
  COMMANDS,
  findCommand,
  GLOBAL_OPTIONS,
  GROUPS,
  NOT_COMMANDS,
  SYNONYMS,
} from "./registry.ts";
import { suggest } from "./suggest.ts";
import { createPrinter, type Printer } from "./ui/printer.ts";
import { shouldColor } from "./ui/style.ts";

export const VERSION: string = packageJson.version;

function printers(ctx: CliContext, noColorFlag: boolean): { out: Printer; err: Printer } {
  const color = (isTTY: boolean) => shouldColor({ isTTY, env: ctx.env, noColorFlag });
  return {
    out: createPrinter(ctx.stdout, color(ctx.stdout.isTTY)),
    err: createPrinter(ctx.stderr, color(ctx.stderr.isTTY)),
  };
}

/** コマンドを実行し、終了コードを返す（例外は投げない） */
export async function run(ctx: CliContext): Promise<number> {
  const argv = [...ctx.argv];
  const terminator = argv.indexOf("--");
  const noColor = (terminator < 0 ? argv : argv.slice(0, terminator)).includes("--no-color");
  const { out, err } = printers(ctx, noColor);
  try {
    return await dispatch(ctx, argv, out, noColor);
  } catch (e) {
    return reportError(e, err, ctx.env);
  }
}

const GLOBAL_WITH_VALUE = new Set(["--home"]);
const GLOBAL_FLAGS = new Set(["--no-color", "--help", "-h", "--version", "-V"]);

async function dispatch(
  ctx: CliContext,
  argv: string[],
  out: Printer,
  noColor: boolean,
): Promise<number> {
  // コマンドより前の、全体のオプション
  const leading: string[] = [];
  let i = 0;
  let wantsHelp = false;
  while (i < argv.length) {
    const arg = argv[i] as string;
    if (arg === "--" || !arg.startsWith("-") || arg === "-") break;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (name === "--version" || name === "-V") {
      out.line(`aicoop ${VERSION}`);
      return EXIT.ok;
    }
    if (name === "--help" || name === "-h") wantsHelp = true;
    if (GLOBAL_WITH_VALUE.has(name)) {
      if (!arg.includes("=") && i + 1 >= argv.length) {
        throw new UsageError(`${name} の値がありません`, [`${name} <dir> の形で書いてください`]);
      }
      leading.push(arg);
      if (!arg.includes("=") && i + 1 < argv.length) leading.push(argv[i + 1] as string);
      i += arg.includes("=") ? 1 : 2;
      continue;
    }
    if (!GLOBAL_FLAGS.has(name)) {
      const close = suggest(
        name,
        [...GLOBAL_WITH_VALUE, ...GLOBAL_FLAGS].filter((n) => n.startsWith("--")),
      );
      throw new UsageError(`知らないオプションです：${name}`, [
        ...(close.length > 0 ? [`もしかして ${close.join("、")}`] : []),
        "コマンドのオプションは、コマンドのあとに書きます（例：aicoop run <member> --purpose ...）",
      ]);
    }
    leading.push(arg);
    i++;
  }

  const word = argv[i];
  if (word === undefined || word === "--") {
    out.lines(topHelp(out.style, VERSION));
    return EXIT.ok;
  }

  if (word === "help") {
    return printHelpFor(
      argv.slice(i + 1).filter((a) => !a.startsWith("-")),
      out,
    );
  }

  let name = word;
  let rest = argv.slice(i + 1);
  // ないコマンドを続けて書いたもの（aicoop holds approve <id>）は、引数として読まずに案内する（9.1・P-4）
  const pair = rest[0] === undefined ? undefined : `${word} ${rest[0]}`;
  if (pair !== undefined && Object.hasOwn(NOT_COMMANDS, pair)) throw unknownCommand(pair);
  if (Object.hasOwn(GROUPS, word)) {
    const sub = rest[0];
    if (sub === undefined || sub.startsWith("-")) {
      if (wantsHelp || rest.includes("--help") || rest.includes("-h")) {
        out.lines(groupHelp(word, out.style));
        return EXIT.ok;
      }
      const subs = COMMANDS.filter((c) => c.name.startsWith(`${word} `)).map((c) => c.name);
      throw new UsageError(`aicoop ${word} のあとに、することを書いてください`, [
        ...subs.map((s) => `aicoop ${s}`),
        `くわしくは aicoop ${word} --help`,
      ]);
    }
    name = `${word} ${sub}`;
    rest = rest.slice(1);
  } else if (hasSubcommands(word) && rest[0] !== undefined && !rest[0].startsWith("-")) {
    // コマンドそのものでもあり、続けて書くこともあるもの（aicoop devices・aicoop devices revoke）
    const sub = `${word} ${rest[0]}`;
    if (findCommand(sub) === undefined) throw unknownCommand(sub, rest[1]);
    name = sub;
    rest = rest.slice(1);
  }

  const command = findCommand(name);
  if (command === undefined) throw unknownCommand(name, rest[0]);

  const parsed = parseCommandArgs(
    command.name,
    { options: [...command.options, ...GLOBAL_OPTIONS], positionals: command.positionals },
    [...leading, ...rest],
  );
  const colorOff = noColor || parsed.values["no-color"] === true;
  const printersFor = printers(ctx, colorOff);
  if (parsed.values.help === true || wantsHelp) {
    printersFor.out.lines(commandHelp(command, printersFor.out.style));
    return EXIT.ok;
  }

  const homeFlag = parsed.values.home;
  const home = await resolveHome(ctx, typeof homeFlag === "string" ? homeFlag : undefined);
  const { run: runCommand } = await command.load();
  return runCommand({
    ctx,
    command,
    values: parsed.values,
    positionals: parsed.positionals,
    home,
    out: printersFor.out,
    err: printersFor.err,
  });
}

function printHelpFor(words: readonly string[], out: Printer): number {
  const name = words.join(" ");
  if (name === "") {
    out.lines(topHelp(out.style, VERSION));
    return EXIT.ok;
  }
  if (Object.hasOwn(GROUPS, name)) {
    out.lines(groupHelp(name, out.style));
    return EXIT.ok;
  }
  const command = findCommand(name);
  if (command === undefined) throw unknownCommand(name);
  out.lines(commandHelp(command, out.style));
  return EXIT.ok;
}

/** 名前のあとに続けて書くコマンドがあるか（`devices` → `devices revoke`） */
function hasSubcommands(word: string): boolean {
  return COMMANDS.some((c) => c.name.startsWith(`${word} `));
}

/** `next` は、知らない名前のすぐ後ろの語（`aicoop scret list` の list） */
function unknownCommand(name: string, next?: string): UsageError {
  if (Object.hasOwn(NOT_COMMANDS, name)) {
    return new UsageError(`知らないコマンドです：${name}`, [...(NOT_COMMANDS[name] ?? [])]);
  }
  const synonym = Object.hasOwn(SYNONYMS, name) ? SYNONYMS[name] : undefined;
  const group = name.split(" ")[0] ?? "";
  const candidates: string[] =
    hasSubcommands(group) && name.includes(" ")
      ? COMMANDS.filter((c) => c.name === group || c.name.startsWith(`${group} `)).map(
          (c: CommandDef) => c.name,
        )
      : [...COMMANDS.map((c) => c.name), ...Object.keys(GROUPS)];
  const close = (synonym !== undefined ? [synonym] : suggest(name, candidates)).map((c) =>
    // まとまりの名前の打ち間違いなら、続く語まで含めて案内する（aicoop secret list）
    Object.hasOwn(GROUPS, c) && next !== undefined && findCommand(`${c} ${next}`)
      ? `${c} ${next}`
      : c,
  );
  return new UsageError(`知らないコマンドです：${name}`, [
    ...(close.length > 0 ? [`もしかして ${close.map((c) => `aicoop ${c}`).join("、")}`] : []),
    "コマンドの一覧は aicoop --help",
  ]);
}

function reportError(
  error: unknown,
  err: Printer,
  env: Readonly<Record<string, string | undefined>>,
): number {
  if (error instanceof CliError) {
    err.line(`${err.style.red("エラー：")}${error.headline}`);
    for (const hint of error.hints) err.line(`  ${hint}`);
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  err.line(`${err.style.red("思いがけないエラーが起きました：")}${message}`);
  if ((env.AICOOP_DEBUG ?? "") !== "" && error instanceof Error && error.stack) {
    err.line(err.style.dim(error.stack));
  } else {
    err.line("  環境変数 AICOOP_DEBUG=1 を付けて実行すると、くわしい情報が出ます");
  }
  return EXIT.failure;
}
