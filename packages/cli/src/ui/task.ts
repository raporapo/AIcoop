/**
 * タスク（9.2 の TaskView）の表示。目的・要約・ファイル名は外から来た文章を含むので、必ず無害化する。
 */
import type { TaskView } from "@aicoop/daemon";
import { TRIGGER_LABELS, taskStatusLabel } from "./labels.ts";
import type { Style } from "./style.ts";
import { cleanBlock, cleanLine, padEnd } from "./text.ts";
import { formatDuration, formatTime } from "./time.ts";

/** 見出しの幅（いちばん長い「完了の条件」に合わせる） */
const LABEL_WIDTH = 10;

function indentBlock(text: string, indent: string): string[] {
  return cleanBlock(text)
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => `${indent}${l}`);
}

/** 1件のタスクの詳細（aicoop run --wait の最後、aicoop logs の最後） */
export function renderTaskDetail(task: TaskView, tz: string, style: Style): string[] {
  const row = (label: string, value: string) => `    ${padEnd(label, LABEL_WIDTH)}  ${value}`;
  const at = (iso: string) => formatTime(iso, tz, { seconds: true });
  const trigger = `${TRIGGER_LABELS[task.trigger_kind] ?? task.trigger_kind}${task.trigger_id ? `（${cleanLine(task.trigger_id)}）` : ""}`;
  const lines = [
    `${style.bold(task.id)}  ${taskStatusLabel(task.status, style)}（${task.status}）`,
    row("社員", `${cleanLine(task.member_id)}（部署 ${cleanLine(task.group_id)}）`),
    row("目的", cleanLine(task.purpose)),
    row("完了の条件", cleanLine(task.done_when)),
    row("きっかけ", `${trigger}・スレッド ${cleanLine(task.thread)}`),
    row("作成", at(task.created_at)),
  ];
  if (task.started_at) lines.push(row("開始", at(task.started_at)));
  if (task.ended_at) {
    const took =
      task.started_at !== null
        ? `（${formatDuration(Date.parse(task.ended_at) - Date.parse(task.started_at))}）`
        : "";
    lines.push(row("終了", `${at(task.ended_at)}${took}`));
  }
  if (task.retry_at) lines.push(row("再開予定", formatTime(task.retry_at, tz)));
  if (task.error) lines.push(row(style.red("理由"), cleanLine(task.error)));
  if (task.result_summary !== null) {
    lines.push("", style.bold("結果（report_result）"), ...indentBlock(task.result_summary, "  "));
  }
  if (task.result_files && task.result_files.length > 0) {
    lines.push("", style.bold("ファイル（/work からの場所）"));
    for (const f of task.result_files) lines.push(`  ${cleanLine(f)}`);
  }
  return lines;
}
