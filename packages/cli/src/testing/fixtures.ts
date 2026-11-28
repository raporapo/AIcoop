/**
 * テスト用：API の応答（9.2 の TaskView・RunView・StatusResponse・HoldView・GrantView）の見本。
 */
import type {
  GrantView,
  HoldDetailView,
  HoldView,
  RunView,
  StatusResponse,
  TaskView,
} from "@aicoop/daemon";

export const TASK_ID = "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB";
export const RUN_ID = "r_01JD6V8X3S0Q5W7KQ9M2T4R6YC";

export function taskView(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: TASK_ID,
    member_id: "dev-implementer",
    group_id: "dev",
    trigger_kind: "manual",
    trigger_id: null,
    priority: 0,
    thread: `task-${TASK_ID}`,
    status: "queued",
    purpose: "README の誤字を直す",
    context: "",
    context_untrusted: false,
    done_when: "PR を出した",
    reply_as: "file",
    ticket_id: null,
    review_subject: null,
    hold_id: null,
    timeout_minutes: 45,
    created_at: "2026-11-27T23:30:00.000Z",
    started_at: null,
    ended_at: null,
    retry_at: null,
    result_summary: null,
    result_files: null,
    error: null,
    ...overrides,
  };
}

export function runView(overrides: Partial<RunView> = {}): RunView {
  return {
    id: RUN_ID,
    task_id: TASK_ID,
    group_id: "dev",
    member_id: "dev-implementer",
    box_kind: "vm",
    session_id: null,
    gateway_port: 50123,
    started_at: "2026-11-27T23:31:00.000Z",
    ended_at: null,
    exit_code: null,
    end_reason: null,
    log_path: "",
    ...overrides,
  };
}

export function statusResponse(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    company: { id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YB", name: "テスト商会" },
    daemon: {
      pid: 4321,
      port: 7070,
      started_at: "2026-11-27T23:00:00.000Z",
      home: "/home/u/.aicoop",
      version: "0.0.0",
      config_loaded_at: "2026-11-27T23:00:00.000Z",
    },
    boxes: {
      max_concurrent: 3,
      running: [
        {
          group_id: "dev",
          member_id: "dev-implementer",
          task_id: TASK_ID,
          run_id: RUN_ID,
          box_kind: "vm",
          started_at: "2026-11-27T23:31:00.000Z",
        },
      ],
    },
    tasks: {
      queued: 2,
      starting: 0,
      running: 1,
      done: 10,
      done_without_report: 0,
      failed: 1,
      timeout: 0,
      waiting_limit: 0,
      blocked_host_tool: 0,
      cancelled: 0,
    },
    usage: {
      status: "allowed",
      resets_at: "2026-11-28T03:00:00.000Z",
      rate_limit_type: "five_hour",
      utilization: 0.42,
      updated_at: "2026-11-27T23:30:00.000Z",
    },
    holds: { pending: 0 },
    triggers: [
      {
        id: "sales-morning-news",
        type: "cron",
        member: "sales-researcher",
        enabled: false,
        next_run_at: null,
      },
      {
        id: "dev-nightly",
        type: "cron",
        member: "dev-implementer",
        enabled: true,
        next_run_at: "2026-11-28T15:00:00.000Z",
      },
    ],
    warnings: [],
    ...overrides,
  };
}

export const HOLD_ID = "h_01JD6V8X3S0Q5W7KQ9M2T4R6YB";
export const GRANT_ID = "g_01JD6V8X3S0Q5W7KQ9M2T4R6YB";

/** メールの送信の保留（5.7.1 の2 の gmail_message の要約） */
export function holdView(overrides: Partial<HoldView> = {}): HoldView {
  return {
    id: HOLD_ID,
    task_id: TASK_ID,
    member_id: "sales-mailer",
    group_id: "sales",
    operation: "gmail.message.send",
    status: "pending_owner",
    summary: {
      kind: "gmail_message",
      operation: "gmail.message.send",
      member_id: "sales-mailer",
      source: "message",
      draft_id: null,
      from: [],
      to: ["yamada@customer.example"],
      cc: [],
      bcc: [],
      subject: ["新サービスのご案内"],
      body_kind: "text",
      body_text: "山田様\n\n新しいサービスのご案内です。",
      body_truncated: false,
      attachments: [],
      warnings: [],
      manager_comment: "宛先・中身に問題はありません",
    },
    created_at: "2026-11-27T23:30:00.000Z",
    expires_at: "2026-11-30T23:30:00.000Z",
    ...overrides,
  };
}

export function holdDetail(overrides: Partial<HoldDetailView> = {}): HoldDetailView {
  return {
    ...holdView(),
    thread: "prospect-1",
    service: "gmail",
    params: {},
    manager_comment: "宛先・中身に問題はありません",
    decided_at: null,
    decided_by: null,
    response_status: null,
    request: {
      method: "POST",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      headers: { "content-type": "application/json" },
      body_bytes: 48,
      body_text: '{"raw":"VG86IHlhbWFkYUBjdXN0b21lci5leGFtcGxl"}',
      body_base64: null,
      truncated: false,
    },
    response_text: null,
    ...overrides,
  };
}

/** push の一時権限の申請（5.7.3） */
export function grantView(overrides: Partial<GrantView> = {}): GrantView {
  return {
    id: GRANT_ID,
    member_id: "dev-implementer",
    operation: "github.git.push",
    params: { repo: ["myorg/new"] },
    mode: "allow",
    reason: "Issue #12 の実装を myorg/new に push するため",
    duration_hours: 24,
    status: "pending_owner",
    created_at: "2026-11-27T23:30:00.000Z",
    starts_at: null,
    expires_at: null,
    decided_by: null,
    manager_comment: "仕事に要る範囲です",
    summary: {},
    ...overrides,
  };
}
