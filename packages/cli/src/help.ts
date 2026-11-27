/**
 * 使い方（`aicoop --help`・`aicoop <コマンド> --help`・`aicoop help <コマンド>`）。11.7：日本語。
 */
import type { OptionSpec } from "./args.ts";
import type { CommandDef } from "./command.ts";
import { COMMANDS, findCommand, GLOBAL_OPTIONS, GROUPS, SECTION_TITLES } from "./registry.ts";
import type { Style } from "./ui/style.ts";
import { displayWidth, padEnd } from "./ui/text.ts";

function optionLabel(o: OptionSpec): string {
  const long = `--${o.name}${o.type === "string" ? ` ${o.value ?? "<値>"}` : ""}`;
  return o.short ? `-${o.short}, ${long}` : long;
}

function twoColumns(
  rows: readonly (readonly [string, string])[],
  minWidth = 0,
  indent = "  ",
): string[] {
  const width = Math.min(30, Math.max(minWidth, ...rows.map(([left]) => displayWidth(left))));
  return rows.map(([left, right]) =>
    displayWidth(left) > width
      ? `${indent}${left}\n${indent}${" ".repeat(width)}  ${right}`
      : `${indent}${padEnd(left, width)}  ${right}`,
  );
}

function optionRows(options: readonly OptionSpec[]): [string, string][] {
  return options
    .filter((o) => !o.hidden)
    .map((o) => [optionLabel(o), o.required ? `${o.description}（必須）` : o.description]);
}

const VERSION_OPTION: OptionSpec = {
  name: "version",
  short: "V",
  type: "boolean",
  description: "版を表示する",
};

export function topHelp(style: Style, version: string): string[] {
  const lines = [
    `${style.bold("aicoop")} ${version} — 自分のPCの中で「AIの会社」を動かす`,
    "",
    style.bold("使い方"),
    "  aicoop <コマンド> [オプション]",
    "",
  ];
  const globals = optionRows([...GLOBAL_OPTIONS, VERSION_OPTION]);
  const width = Math.max(
    ...COMMANDS.map((c) => displayWidth(c.name)),
    ...globals.map(([left]) => displayWidth(left)),
  );
  for (const [section, title] of Object.entries(SECTION_TITLES)) {
    const commands = COMMANDS.filter((c) => c.section === section);
    if (commands.length === 0) continue;
    lines.push(style.bold(title));
    lines.push(
      ...twoColumns(
        commands.map((c) => [c.name, c.summary]),
        width,
      ),
    );
    lines.push("");
  }
  lines.push(style.bold("全体のオプション"));
  lines.push(...twoColumns(globals, width));
  lines.push("");
  lines.push(style.bold("はじめての方へ"));
  lines.push("  aicoop init で雛形を作ると、次にすることが順に表示されます。");
  lines.push("");
  lines.push(`くわしくは ${style.cyan("aicoop <コマンド> --help")}（例：aicoop run --help）`);
  return lines;
}

export function groupHelp(group: string, style: Style): string[] {
  const commands = COMMANDS.filter((c) => c.name.startsWith(`${group} `));
  return [
    `${style.bold(`aicoop ${group}`)} — ${GROUPS[group] ?? ""}`,
    "",
    style.bold("使い方"),
    ...commands.flatMap((c) => c.usage.map((u) => `  aicoop ${u}`)),
    "",
    style.bold("コマンド"),
    ...twoColumns(commands.map((c) => [`${c.name}`, c.summary])),
    "",
    `くわしくは ${style.cyan(`aicoop ${commands[0]?.name ?? group} --help`)}`,
  ];
}

export function commandHelp(command: CommandDef, style: Style): string[] {
  const lines = [
    `${style.bold(`aicoop ${command.name}`)} — ${command.summary}`,
    "",
    style.bold("使い方"),
    ...command.usage.map((u) => `  aicoop ${u}`),
  ];
  if (command.description && command.description.length > 0) {
    lines.push("", ...command.description.map((d) => (d === "" ? "" : `  ${d}`)));
  }
  if (command.positionals.length > 0) {
    lines.push("", style.bold("引数"));
    lines.push(
      ...twoColumns(
        command.positionals.map((p) => [
          `<${p.name}>`,
          p.required ? p.description : `${p.description}（任意）`,
        ]),
      ),
    );
  }
  const visible = optionRows(command.options);
  if (visible.length > 0) {
    lines.push("", style.bold("オプション"), ...twoColumns(visible));
  }
  lines.push("", style.bold("全体のオプション"), ...twoColumns(optionRows(GLOBAL_OPTIONS)));
  if (command.examples.length > 0) {
    lines.push("", style.bold("例"));
    for (const e of command.examples) {
      lines.push(`  ${style.cyan(`aicoop ${e.command}`)}`, `      ${style.dim(e.note)}`);
    }
  }
  const related = command.related
    .map((name) => findCommand(name))
    .filter((c): c is CommandDef => c !== undefined);
  if (related.length > 0) {
    lines.push("", style.bold("関連するコマンド"));
    lines.push(...twoColumns(related.map((c) => [`aicoop ${c.name}`, c.summary])));
  }
  return lines;
}
