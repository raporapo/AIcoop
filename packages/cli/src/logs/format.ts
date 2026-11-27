/**
 * 実行の記録（Claude Code の stream-json。11.5）を、人が読める形にする（aicoop logs）。
 *
 * 記録は箱の中（4.5 の Z3）から来るので、どの文字列も無害化してから出す。
 * 形を知らない行・読めない行でも落とさず、分かる範囲で出す。
 */
import type { Style } from "../ui/style.ts";
import { cleanBlock, cleanLine, headLines, truncate } from "../ui/text.ts";
import { formatDuration, formatTime } from "../ui/time.ts";

/** 道具の結果は、先頭のこの行数だけ */
const RESULT_LINES = 4;
const LINE_WIDTH = 200;

const RESULT_SUBTYPES: Readonly<Record<string, string>> = {
  success: "成功",
  error_max_turns: "ターンの上限に達しました",
  error_during_execution: "実行中にエラーが起きました",
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function oneLine(text: string): string {
  const first = cleanLine(text.split("\n")[0] ?? "");
  return truncate(first, LINE_WIDTH);
}

function summarizeInput(name: string, input: unknown): string {
  const i = isObject(input) ? input : {};
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = str(i[k]);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const byName: Record<string, string | undefined> = {
    Bash: pick("command"),
    Read: pick("file_path"),
    Write: pick("file_path"),
    Edit: pick("file_path"),
    MultiEdit: pick("file_path"),
    NotebookEdit: pick("notebook_path"),
    Glob: pick("pattern"),
    Grep: [pick("pattern"), pick("path")].filter(Boolean).join("  "),
    WebFetch: pick("url"),
    WebSearch: pick("query"),
    Task: pick("description"),
    Agent: pick("description"),
    TodoWrite: "やることの一覧を更新",
    mcp__aicoop__report_result: pick("summary"),
  };
  const known = byName[name];
  if (known !== undefined && known !== "") return oneLine(known);
  let json: string;
  try {
    json = JSON.stringify(input) ?? "";
  } catch {
    json = "";
  }
  return truncate(cleanLine(json), 120);
}

function toolLabel(name: string): string {
  if (name === "mcp__aicoop__report_result") return "結果の報告（report_result）";
  return cleanLine(name);
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        isObject(c) && c.type === "text"
          ? (str(c.text) ?? "")
          : isObject(c)
            ? `（${str(c.type) ?? "?"}）`
            : "",
      )
      .join("\n");
  }
  return "";
}

export interface LogFormatter {
  /** 1行（JSON）を、表示する行にする */
  format(line: string): string[];
}

export function createLogFormatter(options: {
  readonly timeZone: string;
  readonly style: Style;
}): LogFormatter {
  const { style, timeZone } = options;
  /** tool_use の id → 道具の名前（結果の行に名前を出す） */
  const tools = new Map<string, string>();

  const indentRest = (lines: string[], indent: string) =>
    lines.map((l, i) => (i === 0 ? l : `${indent}${l}`));

  return {
    format(raw) {
      const line = raw.trim();
      if (line === "") return [];
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return [style.dim(`？ ${truncate(cleanLine(line), LINE_WIDTH)}`)];
      }
      if (!isObject(event)) return [style.dim(`？ ${truncate(cleanLine(line), LINE_WIDTH)}`)];

      const ts = str(event.timestamp) ?? str(event.ts);
      const prefix = ts ? `${style.dim(formatTime(ts, timeZone, { timeOnly: true }))} ` : "";
      const out: string[] = [];
      const push = (text: string) => out.push(`${prefix}${text}`);
      const type = str(event.type) ?? "?";
      const message = isObject(event.message) ? event.message : {};
      const content = Array.isArray(message.content) ? message.content : [];

      switch (type) {
        case "system": {
          const subtype = str(event.subtype) ?? "";
          if (subtype === "init") {
            const parts = [
              str(event.model) ? `モデル ${cleanLine(str(event.model) ?? "")}` : undefined,
              str(event.session_id)
                ? `セッション ${cleanLine((str(event.session_id) ?? "").slice(0, 8))}`
                : undefined,
              Array.isArray(event.tools) ? `道具 ${event.tools.length}個` : undefined,
            ].filter(Boolean);
            push(`${style.bold("● 開始")}  ${parts.join("・")}`);
          } else if (subtype === "compact_boundary") {
            push(style.dim("・ 会話の古い部分を要約しました"));
          } else {
            push(style.dim(`・ system：${cleanLine(subtype)}`));
          }
          break;
        }
        case "assistant": {
          for (const block of content) {
            if (!isObject(block)) continue;
            if (block.type === "text") {
              const text = cleanBlock(str(block.text) ?? "").replace(/\n+$/, "");
              if (text === "") continue;
              push(
                indentRest(`${style.magenta("Claude：")}${text}`.split("\n"), "        ").join(
                  "\n",
                ),
              );
            } else if (block.type === "tool_use") {
              const name = str(block.name) ?? "?";
              const id = str(block.id);
              if (id) tools.set(id, name);
              push(`${style.cyan(`→ ${toolLabel(name)}`)}：${summarizeInput(name, block.input)}`);
            }
          }
          break;
        }
        case "user": {
          if (typeof message.content === "string") {
            push(style.dim(`依頼：${oneLine(message.content)}`));
            break;
          }
          for (const block of content) {
            if (!isObject(block) || block.type !== "tool_result") continue;
            const name = toolLabel(tools.get(str(block.tool_use_id) ?? "") ?? "道具");
            const text = cleanBlock(resultText(block.content));
            const { lines, omitted } = headLines(text, RESULT_LINES);
            const shown = lines.map((l) => truncate(l, LINE_WIDTH));
            if (block.is_error === true) {
              push(`  ${style.red(`✗ ${name} のエラー`)}：${shown[0] ?? ""}`);
            } else {
              push(`  ${style.dim(`← ${name} の結果`)}：${shown[0] ?? ""}`);
            }
            for (const l of shown.slice(1)) out.push(`${prefix}      ${style.dim(l)}`);
            if (omitted > 0) out.push(`${prefix}      ${style.dim(`…ほか ${omitted}行`)}`);
          }
          break;
        }
        case "result": {
          const subtype = str(event.subtype) ?? "";
          const isError = event.is_error === true || subtype.startsWith("error");
          const parts = [
            RESULT_SUBTYPES[subtype] ?? cleanLine(subtype),
            typeof event.num_turns === "number" ? `${event.num_turns}ターン` : undefined,
            typeof event.duration_ms === "number" ? formatDuration(event.duration_ms) : undefined,
          ].filter(Boolean);
          push(
            isError
              ? style.red(`■ 終了  ${parts.join("・")}`)
              : style.green(`■ 終了  ${parts.join("・")}`),
          );
          break;
        }
        case "rate_limit_event": {
          const info = isObject(event.rate_limit_info) ? event.rate_limit_info : event;
          const status = str(info.status) ?? "?";
          const resets =
            str(info.resetsAt) ??
            (typeof info.resetsAt === "number"
              ? new Date(info.resetsAt * 1000).toISOString()
              : undefined);
          push(
            style.yellow(
              `! 利用枠：${cleanLine(status)}${resets ? `（${formatTime(resets, timeZone)} に戻る）` : ""}`,
            ),
          );
          break;
        }
        default:
          push(style.dim(`・ ${cleanLine(type)}`));
      }
      return out;
    },
  };
}
