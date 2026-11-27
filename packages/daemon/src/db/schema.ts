/**
 * state.db の表（7.2）の Drizzle のスキーマ。列名は設計書のとおり。
 *
 * 表を作る SQL は `migrations.ts` に書く（こちらと同じ列であることをテストで確かめる）。
 * 時刻は UTC の ISO 8601 文字列、JSON は文字列で保存する（7.1）。
 */
import type { BoxKind, TaskStatus, TriggerKind } from "@aicoop/shared";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id").notNull(),
    groupId: text("group_id").notNull(),
    triggerKind: text("trigger_kind").$type<TriggerKind>().notNull(),
    triggerId: text("trigger_id"),
    priority: integer("priority").notNull(),
    thread: text("thread").notNull(),
    status: text("status").$type<TaskStatus>().notNull(),
    purpose: text("purpose").notNull(),
    context: text("context").notNull(),
    doneWhen: text("done_when").notNull(),
    contextUntrusted: integer("context_untrusted", { mode: "boolean" }).notNull(),
    replyAs: text("reply_as").$type<"file" | "task">().notNull(),
    ticketId: text("ticket_id"),
    reviewSubject: text("review_subject"),
    holdId: text("hold_id"),
    timeoutMinutes: integer("timeout_minutes").notNull(),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    retryAt: text("retry_at"),
    resultSummary: text("result_summary"),
    /** JSON の配列 */
    resultFiles: text("result_files"),
    error: text("error"),
  },
  (t) => [index("tasks_status_order").on(t.status, t.priority, t.createdAt)],
);

export type RunEndReason = "exited" | "timeout" | "killed" | "daemon_restart";

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    groupId: text("group_id").notNull(),
    memberId: text("member_id").notNull(),
    boxKind: text("box_kind").$type<BoxKind>().notNull(),
    sessionId: text("session_id"),
    gatewayPort: integer("gateway_port").notNull(),
    startedAt: text("started_at").notNull(),
    /** 終わるまでは null */
    endedAt: text("ended_at"),
    exitCode: integer("exit_code"),
    /** 終わるまでは null */
    endReason: text("end_reason").$type<RunEndReason>(),
    logPath: text("log_path").notNull(),
  },
  (t) => [index("runs_task").on(t.taskId)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    memberId: text("member_id").notNull(),
    thread: text("thread").notNull(),
    sessionId: text("session_id").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.thread] })],
);

export const holds = sqliteTable(
  "holds",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    taskId: text("task_id").notNull(),
    memberId: text("member_id").notNull(),
    groupId: text("group_id").notNull(),
    thread: text("thread").notNull(),
    service: text("service").notNull(),
    operation: text("operation").notNull(),
    /** JSON */
    params: text("params").notNull(),
    requestPath: text("request_path").notNull(),
    requestBytes: integer("request_bytes").notNull(),
    /** JSON（5.7.1） */
    summary: text("summary").notNull(),
    managerComment: text("manager_comment"),
    status: text("status")
      .$type<
        | "pending_manager"
        | "pending_owner"
        | "approved"
        | "rejected"
        | "expired"
        | "replayed"
        | "replay_failed"
      >()
      .notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    decidedAt: text("decided_at"),
    decidedBy: text("decided_by"),
    responseStatus: integer("response_status"),
    responsePath: text("response_path"),
  },
  (t) => [index("holds_member_status").on(t.memberId, t.status)],
);

export const grants = sqliteTable(
  "grants",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id").notNull(),
    service: text("service").notNull(),
    operation: text("operation").notNull(),
    /** JSON */
    params: text("params").notNull(),
    mode: text("mode").$type<"allow" | "hold">().notNull(),
    reason: text("reason").notNull(),
    durationHours: integer("duration_hours").notNull(),
    status: text("status")
      .$type<"pending_manager" | "pending_owner" | "active" | "rejected" | "expired">()
      .notNull(),
    createdAt: text("created_at").notNull(),
    startsAt: text("starts_at"),
    expiresAt: text("expires_at"),
    decidedBy: text("decided_by"),
  },
  (t) => [index("grants_member_status").on(t.memberId, t.status)],
);

export const tickets = sqliteTable(
  "tickets",
  {
    id: text("id").primaryKey(),
    fromGroup: text("from_group").notNull(),
    fromMember: text("from_member").notNull(),
    fromTaskId: text("from_task_id").notNull(),
    fromThread: text("from_thread").notNull(),
    toGroup: text("to_group").notNull(),
    purpose: text("purpose").notNull(),
    context: text("context").notNull(),
    doneWhen: text("done_when").notNull(),
    replyAs: text("reply_as").$type<"file" | "task">().notNull(),
    depth: integer("depth").notNull(),
    thread: text("thread").notNull(),
    status: text("status")
      .$type<"pending_review" | "accepted" | "rejected" | "done" | "failed">()
      .notNull(),
    assignedMember: text("assigned_member"),
    createdAt: text("created_at").notNull(),
    doneAt: text("done_at"),
  },
  (t) => [index("tickets_status").on(t.status)],
);

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  subjectType: text("subject_type")
    .$type<"hold" | "grant" | "tool_pin" | "human_send" | "human_accept" | "human_result">()
    .notNull(),
  subjectId: text("subject_id").notNull(),
  decision: text("decision").$type<"approve" | "reject">().notNull(),
  deviceId: text("device_id").notNull(),
  /** 署名した payload（JSON。5.8） */
  payload: text("payload").notNull(),
  /** WebAuthn の署名（JSON） */
  assertion: text("assertion").notNull(),
  verifiedAt: text("verified_at").notNull(),
});

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").$type<"phone" | "pc">().notNull(),
  /** 中継経由の端末のみ */
  x25519PublicKey: text("x25519_public_key"),
  webauthnCredentialId: text("webauthn_credential_id").notNull().unique("devices_credential"),
  webauthnPublicKey: text("webauthn_public_key").notNull(),
  signCount: integer("sign_count").notNull(),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
});

export type UsageStatus = "allowed" | "allowed_warning" | "rejected";

export const usageState = sqliteTable("usage_state", {
  /** 常に `owner` */
  accountId: text("account_id").primaryKey(),
  status: text("status").$type<UsageStatus>().notNull(),
  resetsAt: text("resets_at"),
  rateLimitType: text("rate_limit_type"),
  /** 0〜1。取れたときだけ */
  utilization: real("utilization"),
  updatedAt: text("updated_at").notNull(),
});

export const toolPins = sqliteTable(
  "tool_pins",
  {
    serverId: text("server_id").notNull(),
    toolName: text("tool_name").notNull(),
    hash: text("hash").notNull(),
    /** 初めて見せたときは承認なしで記録する（5.3.5 の1） */
    approvedAt: text("approved_at"),
    approvalId: text("approval_id"),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.toolName] })],
);

export const hostToolState = sqliteTable("host_tool_state", {
  toolId: text("tool_id").primaryKey(),
  status: text("status")
    .$type<"stopped" | "starting" | "running" | "stopping" | "refused">()
    .notNull(),
  pid: integer("pid"),
  startedAt: text("started_at"),
  startedBy: text("started_by"),
});

export const usedNonces = sqliteTable(
  "used_nonces",
  {
    nonce: text("nonce").primaryKey(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("used_nonces_expires").on(t.expiresAt)],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    ts: text("ts").notNull(),
    actor: text("actor").notNull(),
    kind: text("kind").notNull(),
    subject: text("subject").notNull(),
    /** 正規化JSON（5.10 の2） */
    data: text("data").notNull(),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
  },
  (t) => [index("audit_log_ts").on(t.ts)],
);
