/**
 * ローカルHTTP API（9.2）の形と、state.db の行からの変換。
 * 型そのものは `@aicoop/shared/api`（承認アプリからも読む）にあり、ここから同じものを出す。
 */

import type { SecretKind } from "@aicoop/shared";
import type {
  RunEndReason as ApiRunEndReason,
  UsageStatus as ApiUsageStatus,
  RunView,
  SecretKindName,
  TaskView,
} from "@aicoop/shared/api";
import type { Run } from "../db/runs.ts";
import type { RunEndReason, UsageStatus } from "../db/schema.ts";
import type { Task } from "../db/tasks.ts";

export * from "@aicoop/shared/api";

// state.db の列の型と、API の型が食い違ったら、ここで型の誤りになる
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _endReason: Same<RunEndReason, ApiRunEndReason> = true;
const _usage: Same<UsageStatus, ApiUsageStatus> = true;
const _secretKind: Same<SecretKind, SecretKindName> = true;
void _endReason;
void _usage;
void _secretKind;

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
