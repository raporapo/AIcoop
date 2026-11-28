/**
 * 状態などの日本語の呼び名（11.7）。色だけに頼らないよう、記号も添える（5.8 の4）。
 * 呼び名は CLI（packages/cli/src/ui/labels.ts）とそろえる。
 */
import type {
  ApprovalSubjectType,
  GrantStatusView,
  HoldStatus,
  TaskView,
  UsageStatus,
} from "@aicoop/shared/api";

export type TaskStatus = TaskView["status"];
export type TriggerKind = TaskView["trigger_kind"];

/** 見た目の調子（CSS のクラス）。意味は記号と文でも伝える */
export type Tone = "ok" | "active" | "wait" | "bad" | "muted" | "attention";

export interface StatusLabel {
  readonly label: string;
  readonly symbol: string;
  readonly tone: Tone;
}

export const TASK_STATUS_LABELS: Readonly<Record<TaskStatus, StatusLabel>> = {
  queued: { label: "順番待ち", symbol: "◷", tone: "muted" },
  starting: { label: "起動中", symbol: "▶", tone: "active" },
  running: { label: "実行中", symbol: "▶", tone: "active" },
  done: { label: "完了", symbol: "✓", tone: "ok" },
  done_without_report: { label: "報告なしで終了", symbol: "△", tone: "wait" },
  failed: { label: "失敗", symbol: "✕", tone: "bad" },
  timeout: { label: "時間切れ", symbol: "✕", tone: "bad" },
  waiting_limit: { label: "利用枠待ち", symbol: "⏸", tone: "wait" },
  blocked_host_tool: { label: "道具待ち", symbol: "⏸", tone: "wait" },
  cancelled: { label: "取り消し", symbol: "−", tone: "muted" },
};

/** 一覧で選べる順（5.5.3 の図の順） */
export const TASK_STATUSES: readonly TaskStatus[] = [
  "queued",
  "starting",
  "running",
  "waiting_limit",
  "blocked_host_tool",
  "done",
  "done_without_report",
  "failed",
  "timeout",
  "cancelled",
];

const TERMINAL: ReadonlySet<TaskStatus> = new Set([
  "done",
  "done_without_report",
  "failed",
  "timeout",
  "cancelled",
]);

/** 終わった状態（取り消せない）。5.5.3 */
export function isTerminalTask(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}

export const TRIGGER_LABELS: Readonly<Record<TriggerKind, string>> = {
  manual: "手動",
  ceo: "CEO",
  review: "レビュー",
  ticket: "依頼票",
  on_hold_resolved: "保留の結果",
  github: "GitHub",
  cron: "定時",
};

export const HOLD_STATUS_LABELS: Readonly<Record<HoldStatus, StatusLabel>> = {
  pending_manager: { label: "部長のレビュー待ち", symbol: "◷", tone: "muted" },
  pending_owner: { label: "あなたの承認待ち", symbol: "●", tone: "attention" },
  approved: { label: "承認済み（送るところ）", symbol: "✓", tone: "active" },
  rejected: { label: "却下", symbol: "✕", tone: "muted" },
  expired: { label: "期限切れ（却下と同じ）", symbol: "−", tone: "muted" },
  replayed: { label: "送信済み", symbol: "✓", tone: "ok" },
  replay_failed: { label: "送信に失敗", symbol: "✕", tone: "bad" },
};

export const GRANT_STATUS_LABELS: Readonly<Record<GrantStatusView, StatusLabel>> = {
  pending_manager: { label: "部長のレビュー待ち", symbol: "◷", tone: "muted" },
  pending_owner: { label: "あなたの承認待ち", symbol: "●", tone: "attention" },
  active: { label: "有効", symbol: "✓", tone: "ok" },
  rejected: { label: "却下", symbol: "✕", tone: "muted" },
  expired: { label: "期限切れ", symbol: "−", tone: "muted" },
};

export const USAGE_LABELS: Readonly<Record<UsageStatus, StatusLabel>> = {
  allowed: { label: "使える", symbol: "✓", tone: "ok" },
  allowed_warning: { label: "残り少ない", symbol: "▲", tone: "wait" },
  rejected: { label: "止まっている（枠に達した）", symbol: "■", tone: "bad" },
};

export const SUBJECT_TYPE_LABELS: Readonly<Record<ApprovalSubjectType, string>> = {
  hold: "保留",
  grant: "一時権限",
  tool_pin: "道具の説明文",
  human_send: "人宛ての依頼",
  human_accept: "人宛ての依頼の受け入れ",
  human_result: "人宛ての依頼の結果",
};

/** 知らない値（新しい版の daemon など）は、そのままの値を見せる */
export function statusLabel<K extends string>(
  table: Readonly<Record<K, StatusLabel>>,
  value: string,
): StatusLabel {
  return (
    (table as Readonly<Record<string, StatusLabel | undefined>>)[value] ?? {
      label: value,
      symbol: "?",
      tone: "muted",
    }
  );
}

/** 操作（`<service>.<operation>`）の呼び名。知らないものは null（ID だけを見せる） */
const OPERATION_LABELS: Readonly<Record<string, string>> = {
  "gmail.message.send": "メールの送信",
  "gmail.message.read": "メールを読む",
  "gmail.draft.create": "下書きを作る",
  "gmail.draft.update": "下書きを直す",
  "github.pr.merge": "PR のマージ",
  "github.pr.create": "PR を出す",
  "github.git.push": "git push",
  "github.issue.comment": "Issue へのコメント",
  "github.repo.read": "リポジトリを読む",
  "web.read": "Web を読む",
};

/**
 * 保留の operation は、daemon の版によって `message.send`（service が別の列）のことも、
 * `gmail.message.send` のこともあるので、service があれば足して引く。
 */
export function operationId(operation: string, service?: string | null): string {
  if (service && !operation.startsWith(`${service}.`)) return `${service}.${operation}`;
  return operation;
}

export function operationLabel(operation: string, service?: string | null): string | null {
  const exact = OPERATION_LABELS[operationId(operation, service)];
  if (exact !== undefined) return exact;
  if (service) return null;
  // service が分からない（一覧の HoldView）ときは、1つに決まるときだけ呼び名を出す
  const found = Object.keys(OPERATION_LABELS).filter((k) => k.endsWith(`.${operation}`));
  return found.length === 1 && found[0] !== undefined ? (OPERATION_LABELS[found[0]] ?? null) : null;
}

/** 監査ログの種類（5.10 の3） */
export const AUDIT_KIND_LABELS: Readonly<Record<string, string>> = {
  "proxy.decision": "資格プロキシの判定",
  "proxy.passthrough": "素通しの通信",
  "gateway.call": "道具の呼び出し",
  "task.state": "タスクの状態",
  "hold.state": "保留の状態",
  "grant.state": "一時権限の状態",
  "ticket.state": "依頼票の状態",
  approval: "承認・却下の署名",
  "config.load": "設定の読み込み",
  "secret.change": "資格の登録・削除",
  "box.lifecycle": "箱の起動・停止",
  quarantine: "ファイルの隔離",
  "host_tool.state": "ホストの道具",
  "device.state": "端末",
  checkpoint: "古い記録の削除（つながりの印）",
};

/** 監査ログの actor（7.2）を読める形に */
export function actorLabel(actor: string): string {
  if (actor === "system") return "システム";
  if (actor === "owner:cli") return "オーナー（PC のコマンド）";
  if (actor.startsWith("owner:")) return `オーナー（端末 ${actor.slice("owner:".length)}）`;
  if (actor.startsWith("member:")) return `社員 ${actor.slice("member:".length)}`;
  if (actor.startsWith("manager:")) return `部長 ${actor.slice("manager:".length)}`;
  return actor;
}

/** decided_by（`manager:<id>` | `owner:<device_id>` | `system`） */
export function deciderLabel(by: string | null): string {
  if (by === null) return "—";
  return actorLabel(by);
}
