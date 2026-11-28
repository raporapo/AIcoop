/**
 * テスト用のデータ（ローカルAPI の応答の形。@aicoop/shared/api の型どおり）。
 */
import type {
  AuditEntryView,
  DeviceView,
  GrantView,
  HoldDetailView,
  HoldView,
  MeResponse,
  StatusResponse,
  TaskView,
  UsageView,
} from "@aicoop/shared/api";

/** テストの「今」：2026-11-28 12:00（日本時間） */
export const NOW = Date.parse("2026-11-28T03:00:00.000Z");
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 7.1 の形の ID（接頭辞 + ULID） */
export function id(prefix: string, n: number): string {
  return `${prefix}_01JQ${String(n).padStart(22, "0")}`;
}

export const COMPANY_ID = id("c", 1);
export const THIS_DEVICE: DeviceView = {
  id: id("d", 1),
  name: "自宅のPC（Edge）",
  kind: "pc",
  created_at: iso(NOW - 3 * 24 * HOUR),
  revoked_at: null,
};
export const OTHER_DEVICE: DeviceView = {
  id: id("d", 2),
  name: "仕事のノートPC",
  kind: "pc",
  created_at: iso(NOW - 10 * 24 * HOUR),
  revoked_at: null,
};

export const ME: MeResponse = { device: THIS_DEVICE, expires_at: iso(NOW + 12 * HOUR) };

function b64url(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const MAIL_RFC822 = [
  "To: client@example.com",
  "Bcc: boss@example.org",
  "Subject: =?UTF-8?B?44GK6KaL56mN44KK44Gu5Lu2?=",
  "Content-Type: text/plain; charset=UTF-8",
  "",
  "いつもお世話になっております。お見積りをお送りします。",
].join("\r\n");

export const GMAIL_SUMMARY = {
  kind: "gmail_message",
  to: ["client@example.com"],
  cc: [],
  bcc: ["boss@example.org"],
  subject: "お見積りの件",
  body_text: "いつもお世話になっております。お見積りをお送りします。",
};

export const MAIL_HOLD: HoldDetailView = {
  id: id("h", 1),
  task_id: id("t", 1),
  member_id: "sales-writer",
  group_id: "sales",
  operation: "message.send",
  status: "pending_owner",
  summary: GMAIL_SUMMARY,
  created_at: iso(NOW - 2 * HOUR),
  expires_at: iso(NOW + 70 * HOUR),
  thread: "lead-acme",
  service: "gmail",
  params: {},
  manager_comment: "宛先と金額を確かめました。問題ありません。",
  decided_at: null,
  decided_by: "manager:sales-manager",
  response_status: null,
  request: {
    method: "POST",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    headers: { "content-type": "application/json" },
    body_bytes: 200,
    body_text: JSON.stringify({ raw: b64url(MAIL_RFC822) }),
    body_base64: null,
    truncated: false,
  },
  response_text: null,
};

export const MERGE_HOLD: HoldDetailView = {
  ...MAIL_HOLD,
  id: id("h", 2),
  task_id: id("t", 2),
  member_id: "dev-implementer",
  group_id: "dev",
  operation: "pr.merge",
  service: "github",
  params: { repo: "myorg/app" },
  summary: {
    kind: "github_pr_merge",
    repo: "myorg/app",
    pr_number: 12,
    title: "README の誤字を直す",
    changed_files: 1,
  },
  created_at: iso(NOW - 30 * MIN),
  expires_at: iso(NOW + 30 * MIN),
  manager_comment: null,
  request: {
    method: "PUT",
    url: "https://api.github.com/repos/myorg/app/pulls/12/merge",
    headers: { "content-type": "application/json" },
    body_bytes: 24,
    body_text: '{"merge_method":"squash"}',
    body_base64: null,
    truncated: false,
  },
};

export const MANAGER_HOLD: HoldView = {
  id: id("h", 3),
  task_id: id("t", 3),
  member_id: "sales-writer",
  group_id: "sales",
  operation: "message.send",
  status: "pending_manager",
  summary: { ...GMAIL_SUMMARY, subject: "ご挨拶" },
  created_at: iso(NOW - 5 * MIN),
  expires_at: iso(NOW + 71 * HOUR),
};

export function holdView(h: HoldDetailView): HoldView {
  return {
    id: h.id,
    task_id: h.task_id,
    member_id: h.member_id,
    group_id: h.group_id,
    operation: h.operation,
    status: h.status,
    summary: h.summary,
    created_at: h.created_at,
    expires_at: h.expires_at,
  };
}

export const PUSH_GRANT: GrantView = {
  id: id("g", 1),
  member_id: "dev-implementer",
  operation: "github.git.push",
  params: { repo: ["myorg/new"] },
  mode: "allow",
  reason: "新しいリポジトリ myorg/new に初めの版を push したいです。",
  duration_hours: 24,
  status: "pending_owner",
  created_at: iso(NOW - 10 * MIN),
  starts_at: null,
  expires_at: null,
  decided_by: "manager:dev-manager",
};

export const MANAGER_GRANT: GrantView = {
  ...PUSH_GRANT,
  id: id("g", 2),
  status: "pending_manager",
  decided_by: null,
};

export function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: id("t", 10),
    member_id: "dev-implementer",
    group_id: "dev",
    trigger_kind: "manual",
    trigger_id: null,
    priority: 0,
    thread: "readme-typo",
    status: "done",
    purpose: "README の誤字を直す",
    context: "",
    context_untrusted: false,
    done_when: "PR を出して URL を報告した",
    reply_as: "file",
    ticket_id: null,
    review_subject: null,
    hold_id: null,
    timeout_minutes: 45,
    created_at: iso(NOW - HOUR),
    started_at: iso(NOW - 59 * MIN),
    ended_at: iso(NOW - 40 * MIN),
    retry_at: null,
    result_summary: "PR #12 を出しました。",
    result_files: ["notes/readme.md"],
    error: null,
    ...overrides,
  };
}

export const USAGE: UsageView = {
  status: "allowed_warning",
  resets_at: iso(NOW + 2 * HOUR),
  rate_limit_type: "five_hour",
  utilization: 0.83,
  updated_at: iso(NOW - 3 * MIN),
};

export function status(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    company: { id: COMPANY_ID, name: "サンプル商会" },
    daemon: {
      pid: 1234,
      port: 7070,
      started_at: iso(NOW - 5 * HOUR),
      home: "/home/owner/.aicoop",
      version: "0.1.0",
      config_loaded_at: iso(NOW - 4 * HOUR),
    },
    boxes: {
      max_concurrent: 3,
      running: [
        {
          group_id: "dev",
          member_id: "dev-implementer",
          task_id: id("t", 20),
          run_id: id("r", 20),
          box_kind: "vm",
          started_at: iso(NOW - 12 * MIN),
        },
      ],
    },
    tasks: {
      queued: 2,
      starting: 0,
      running: 1,
      done: 5,
      done_without_report: 0,
      failed: 1,
      timeout: 0,
      waiting_limit: 0,
      blocked_host_tool: 0,
      cancelled: 0,
    },
    usage: USAGE,
    holds: { pending: 2 },
    triggers: [
      {
        id: "morning-research",
        type: "cron",
        member: "sales-researcher",
        enabled: true,
        next_run_at: iso(NOW + 20 * HOUR),
      },
    ],
    warnings: [],
    ...overrides,
  };
}

export function auditEntry(seq: number, overrides: Partial<AuditEntryView> = {}): AuditEntryView {
  return {
    seq,
    ts: iso(NOW - (1000 - seq) * MIN),
    actor: "system",
    kind: "task.state",
    subject: id("t", seq),
    data: { from: "queued", to: "starting" },
    ...overrides,
  };
}
