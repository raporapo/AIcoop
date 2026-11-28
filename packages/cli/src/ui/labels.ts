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

/** 保留の状態（7.2 の holds.status、5.7.1） */
export const HOLD_STATUSES = [
  "pending_manager",
  "pending_owner",
  "approved",
  "rejected",
  "expired",
  "replayed",
  "replay_failed",
] as const;

export const HOLD_STATUS_LABELS: Readonly<Record<(typeof HOLD_STATUSES)[number], string>> = {
  pending_manager: "部長のレビュー待ち",
  pending_owner: "オーナーの承認待ち",
  approved: "承認済み（送信中）",
  rejected: "却下",
  expired: "期限切れ",
  replayed: "送信済み",
  replay_failed: "送信に失敗",
};

/** 一時権限の状態（7.2 の grants.status、5.7.3） */
export const GRANT_STATUSES = [
  "pending_manager",
  "pending_owner",
  "active",
  "rejected",
  "expired",
] as const;

export const GRANT_STATUS_LABELS: Readonly<Record<(typeof GRANT_STATUSES)[number], string>> = {
  pending_manager: "部長のレビュー待ち",
  pending_owner: "オーナーの承認待ち",
  active: "有効",
  rejected: "却下",
  expired: "期限切れ",
};

/** 一覧の表に出す短い呼び名（80桁の端末に収める） */
export const DECISION_SHORT_LABELS: Readonly<Record<string, string>> = {
  pending_manager: "部長待ち",
  pending_owner: "承認待ち",
  approved: "送信中",
  rejected: "却下",
  expired: "期限切れ",
  replayed: "送信済み",
  replay_failed: "送信失敗",
  active: "有効",
};

/** 保留・一時権限の状態の呼び名と色（`short` なら一覧の表の短い呼び名） */
export function decisionStatusLabel(status: string, style: Style, short = false): string {
  const label =
    (short ? DECISION_SHORT_LABELS[status] : undefined) ??
    (HOLD_STATUS_LABELS as Record<string, string | undefined>)[status] ??
    (GRANT_STATUS_LABELS as Record<string, string | undefined>)[status] ??
    status;
  switch (status) {
    case "pending_owner":
      return style.yellow(label);
    case "replayed":
    case "active":
      return style.green(label);
    case "replay_failed":
      return style.red(label);
    case "approved":
    case "pending_manager":
      return style.cyan(label);
    default:
      return style.dim(label);
  }
}

export const USAGE_LABELS: Readonly<Record<string, string>> = {
  allowed: "使える",
  allowed_warning: "残り少ない",
  rejected: "止まっている（枠に達した）",
};
