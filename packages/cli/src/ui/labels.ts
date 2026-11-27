/**
 * 状態などの日本語の呼び名（11.7）と、色。
 */
import type { TaskStatus } from "@aicoop/shared";
import type { Style } from "./style.ts";

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
  queued: "順番待ち",
  starting: "起動中",
  running: "実行中",
  done: "完了",
  done_without_report: "報告なしで終了",
  failed: "失敗",
  timeout: "時間切れ",
  waiting_limit: "利用枠待ち",
  blocked_host_tool: "道具待ち",
  cancelled: "取り消し",
};

export function taskStatusLabel(status: string, style: Style): string {
  const label = (TASK_STATUS_LABELS as Record<string, string | undefined>)[status] ?? status;
  switch (status) {
    case "done":
      return style.green(label);
    case "running":
    case "starting":
      return style.cyan(label);
    case "failed":
    case "timeout":
      return style.red(label);
    case "done_without_report":
    case "waiting_limit":
    case "blocked_host_tool":
      return style.yellow(label);
    default:
      return style.dim(label);
  }
}

export const TRIGGER_LABELS: Readonly<Record<string, string>> = {
  manual: "手動",
  ceo: "CEO",
  review: "レビュー",
  ticket: "依頼票",
  on_hold_resolved: "保留の結果",
  github: "GitHub",
  cron: "定時",
};

export const USAGE_LABELS: Readonly<Record<string, string>> = {
  allowed: "使える",
  allowed_warning: "残り少ない",
  rejected: "止まっている（枠に達した）",
};
