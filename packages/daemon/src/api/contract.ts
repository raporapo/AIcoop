/**
 * ローカルHTTP API の形（9.2）。サーバー（daemon）とクライアント（CLI・承認アプリ）が共に使う。
 *
 * - `http://127.0.0.1:<daemon.port>/api/v1/` で受ける。`127.0.0.1` 以外では待ち受けない（4.3 の2）
 * - CLI は `~/.aicoop/runtime/api_token`（0600。daemon の起動ごとに作り直す）を
 *   `Authorization: Bearer <token>` で送る
 * - JSON のキーは snake_case（state.db の列名と同じ）。時刻は UTC の ISO 8601
 * - 失敗したときは、HTTP のステータスと `ApiError` を返す。`message` は利用者に見せる日本語
 */
import type { BoxKind, ConfigIssue, TaskStatus, TriggerKind } from "@aicoop/shared";
import type { Run } from "../db/runs.ts";
import type { RunEndReason, UsageStatus } from "../db/schema.ts";
import type { Task } from "../db/tasks.ts";

export const API_PREFIX = "/api/v1";

/** CLI が daemon を見つけるために、daemon が `runtime/daemon.json` に書くもの */
export interface DaemonInfo {
  readonly pid: number;
  readonly port: number;
  readonly started_at: string;
  readonly home: string;
  readonly version: string;
}

export type ApiErrorCode =
  /** トークンがない・違う */
  | "unauthorized"
  /** Host ヘッダーが 127.0.0.1・localhost ではない（DNS リバインディング対策） */
  | "forbidden_host"
  | "not_found"
  /** 入力が型・上限に合わない */
  | "invalid_input"
  /** 知らない社員・人間の社員など、タスクを作れない相手 */
  | "unknown_member"
  /** その状態ではできない（終わったタスクの取り消しなど） */
  | "invalid_state"
  /** 設定にエラーがある（reload） */
  | "config_invalid"
  | "internal";

export interface ApiError {
  readonly error: ApiErrorCode;
  readonly message: string;
  /** config_invalid のとき */
  readonly issues?: readonly ConfigIssue[];
}

export interface TaskView {
  readonly id: string;
  readonly member_id: string;
  readonly group_id: string;
  readonly trigger_kind: TriggerKind;
  readonly trigger_id: string | null;
  readonly priority: number;
  readonly thread: string;
  readonly status: TaskStatus;
  readonly purpose: string;
  readonly context: string;
  readonly context_untrusted: boolean;
  readonly done_when: string;
  readonly reply_as: "file" | "task";
  readonly ticket_id: string | null;
  readonly review_subject: string | null;
  readonly hold_id: string | null;
  readonly timeout_minutes: number;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly retry_at: string | null;
  readonly result_summary: string | null;
  readonly result_files: readonly string[] | null;
  readonly error: string | null;
}

export interface RunView {
  readonly id: string;
  readonly task_id: string;
  readonly group_id: string;
  readonly member_id: string;
  readonly box_kind: BoxKind;
  readonly session_id: string | null;
  readonly gateway_port: number;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly exit_code: number | null;
  readonly end_reason: RunEndReason | null;
  readonly log_path: string;
}

export interface UsageView {
  readonly status: UsageStatus;
  readonly resets_at: string | null;
  readonly rate_limit_type: string | null;
  readonly utilization: number | null;
  readonly updated_at: string;
}

export interface RunningBoxView {
  readonly group_id: string;
  readonly member_id: string;
  readonly task_id: string;
  readonly run_id: string | null;
  readonly box_kind: BoxKind;
  readonly started_at: string;
}

export interface TriggerView {
  readonly id: string;
  readonly type: string;
  readonly member: string;
  readonly enabled: boolean;
  /** cron だけ。次に起きる時刻 */
  readonly next_run_at: string | null;
}

/** `GET /status` */
export interface StatusResponse {
  readonly company: { readonly id: string; readonly name: string };
  readonly daemon: DaemonInfo & { readonly config_loaded_at: string };
  readonly boxes: {
    readonly max_concurrent: number;
    readonly running: readonly RunningBoxView[];
  };
  /** 状態ごとのタスクの数（0 の状態も入れる） */
  readonly tasks: Readonly<Record<TaskStatus, number>>;
  readonly usage: UsageView | null;
  readonly holds: { readonly pending: number };
  readonly triggers: readonly TriggerView[];
  /** 設定の警告（6.10 の W-xxx） */
  readonly warnings: readonly ConfigIssue[];
}

/** `GET /tasks?status=<状態,状態>&limit=<1〜500、既定100>`。新しい順 */
export interface ListTasksResponse {
  readonly tasks: readonly TaskView[];
}

/** `POST /tasks`（手動のタスク。トリガー manual、9.1 の aicoop run） */
export interface CreateTaskRequest {
  readonly member: string;
  readonly purpose: string;
  readonly done_when: string;
  readonly context?: string;
  readonly thread?: string;
  /** 1〜55。なければ aicoop.yaml の task.timeout_minutes */
  readonly timeout_minutes?: number;
}

/** `POST /tasks` は 201 */
export interface CreateTaskResponse {
  readonly task: TaskView;
}

/** `GET /tasks/{id}` */
export interface GetTaskResponse {
  readonly task: TaskView;
  /** 古い順 */
  readonly runs: readonly RunView[];
}

/** `POST /tasks/{id}/cancel` */
export interface CancelTaskResponse {
  readonly task: TaskView;
  /** 動いていた（箱を止めた）なら true */
  readonly was_active: boolean;
}

/** `POST /reload`（設定を読み直す。エラーなら 422 と config_invalid で、前の設定のまま） */
export interface ReloadResponse {
  readonly ok: true;
  readonly warnings: readonly ConfigIssue[];
  /** 読み直した設定ファイルごとの SHA-256 */
  readonly files: Readonly<Record<string, string>>;
}

export interface AuditEntryView {
  readonly seq: number;
  readonly ts: string;
  readonly actor: string;
  readonly kind: string;
  readonly subject: string;
  readonly data: unknown;
}

/** `GET /audit?after=<seq>&limit=<1〜1000、既定200>`。古い順 */
export interface ListAuditResponse {
  readonly entries: readonly AuditEntryView[];
}

export interface HoldView {
  readonly id: string;
  readonly task_id: string;
  readonly member_id: string;
  readonly group_id: string;
  readonly operation: string;
  readonly status: string;
  readonly summary: unknown;
  readonly created_at: string;
  readonly expires_at: string;
}

/** `GET /holds` */
export interface ListHoldsResponse {
  readonly holds: readonly HoldView[];
}

/** `GET /usage` */
export interface UsageResponse {
  readonly usage: UsageView | null;
}

/** `POST /shutdown`（aicoop stop。動いている実行を止めてから終わる） */
export interface ShutdownResponse {
  readonly ok: true;
}

// ---- state.db の行から API の形へ ----

export function toTaskView(task: Task): TaskView {
  return {
    id: task.id,
    member_id: task.memberId,
    group_id: task.groupId,
    trigger_kind: task.triggerKind,
    trigger_id: task.triggerId,
    priority: task.priority,
    thread: task.thread,
    status: task.status,
    purpose: task.purpose,
    context: task.context,
    context_untrusted: task.contextUntrusted,
    done_when: task.doneWhen,
    reply_as: task.replyAs,
    ticket_id: task.ticketId,
    review_subject: task.reviewSubject,
    hold_id: task.holdId,
    timeout_minutes: task.timeoutMinutes,
    created_at: task.createdAt,
    started_at: task.startedAt,
    ended_at: task.endedAt,
    retry_at: task.retryAt,
    result_summary: task.resultSummary,
    result_files: parseFiles(task.resultFiles),
    error: task.error,
  };
}

function parseFiles(json: string | null): string[] | null {
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

export function toRunView(run: Run): RunView {
  return {
    id: run.id,
    task_id: run.taskId,
    group_id: run.groupId,
    member_id: run.memberId,
    box_kind: run.boxKind,
    session_id: run.sessionId,
    gateway_port: run.gatewayPort,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    exit_code: run.exitCode,
    end_reason: run.endReason,
    log_path: run.logPath,
  };
}
