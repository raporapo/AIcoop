/**
 * タスクの状態と、許される変化（5.5.3、7.2 の tasks.status）。
 *
 * 5.5.3 の図にある変化に、設計書のほかの節から要る次の変化を足す。これ以外の変化は許さない。
 * - `starting → queued`：制御サーバーの再起動（8.6 の3）
 * - `starting → failed`：箱の起動に失敗した
 * - `starting`・`running`・`waiting_limit`・`blocked_host_tool → cancelled`：
 *   `aicoop cancel` は「動いていれば止める」（9.1）。終わっていないタスクは取り消せる
 */

export const TASK_STATUSES = [
  "queued",
  "starting",
  "running",
  "done",
  "done_without_report",
  "failed",
  "timeout",
  "waiting_limit",
  "blocked_host_tool",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

const TRANSITIONS: ReadonlyMap<TaskStatus, ReadonlySet<TaskStatus>> = new Map<
  TaskStatus,
  ReadonlySet<TaskStatus>
>([
  ["queued", new Set<TaskStatus>(["starting", "cancelled"])],
  ["starting", new Set<TaskStatus>(["running", "queued", "failed", "cancelled"])],
  [
    "running",
    new Set<TaskStatus>([
      "done",
      "done_without_report",
      "failed",
      "timeout",
      "waiting_limit",
      "blocked_host_tool",
      "cancelled",
    ]),
  ],
  ["waiting_limit", new Set<TaskStatus>(["queued", "cancelled"])],
  ["blocked_host_tool", new Set<TaskStatus>(["queued", "cancelled"])],
  ["done", new Set<TaskStatus>()],
  ["done_without_report", new Set<TaskStatus>()],
  ["failed", new Set<TaskStatus>()],
  ["timeout", new Set<TaskStatus>()],
  ["cancelled", new Set<TaskStatus>()],
]);

const STATUS_SET: ReadonlySet<string> = new Set(TASK_STATUSES);

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

/** 終わった状態（ここから先へは変われない） */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TRANSITIONS.get(status)?.size === 0;
}

/** `from` から `to` へ変わってよいか */
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  if (!isTaskStatus(from) || !isTaskStatus(to)) return false;
  return TRANSITIONS.get(from)?.has(to) ?? false;
}
