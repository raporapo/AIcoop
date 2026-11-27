/**
 * state.db の表を作る SQL（7.2）。版は `PRAGMA user_version` で管理する。
 *
 * - 要素 i は「版 i から版 i+1 へ」の SQL。開くたびに、足りない分だけを順に、トランザクションの中で流す
 * - 一度出した SQL は書き換えない（すでに作られた state.db と食い違う）。変えるときは要素を足す
 * - `CREATE TABLE IF NOT EXISTS` は使わない。版の記録がないのに同じ名前の表があるデータベース
 *   （知らないもの）は、黙って使わずにエラーにする
 * - 列は `schema.ts`（Drizzle）と同じにする（テストで確かめる）
 */
export const MIGRATIONS: readonly string[] = [
  // 版1：7.2 の表をすべて作る
  `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  member_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  trigger_id TEXT,
  priority INTEGER NOT NULL,
  thread TEXT NOT NULL,
  status TEXT NOT NULL,
  purpose TEXT NOT NULL,
  context TEXT NOT NULL,
  done_when TEXT NOT NULL,
  context_untrusted INTEGER NOT NULL,
  reply_as TEXT NOT NULL,
  ticket_id TEXT,
  review_subject TEXT,
  hold_id TEXT,
  timeout_minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  retry_at TEXT,
  result_summary TEXT,
  result_files TEXT,
  error TEXT
);
CREATE INDEX tasks_status_order ON tasks (status, priority, created_at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  box_kind TEXT NOT NULL,
  session_id TEXT,
  gateway_port INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  exit_code INTEGER,
  end_reason TEXT,
  log_path TEXT NOT NULL
);
CREATE INDEX runs_task ON runs (task_id);

CREATE TABLE sessions (
  member_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (member_id, thread)
);

CREATE TABLE holds (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  params TEXT NOT NULL,
  request_path TEXT NOT NULL,
  request_bytes INTEGER NOT NULL,
  summary TEXT NOT NULL,
  manager_comment TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  response_status INTEGER,
  response_path TEXT
);
CREATE INDEX holds_member_status ON holds (member_id, status);

CREATE TABLE grants (
  id TEXT PRIMARY KEY NOT NULL,
  member_id TEXT NOT NULL,
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  params TEXT NOT NULL,
  mode TEXT NOT NULL,
  reason TEXT NOT NULL,
  duration_hours INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  starts_at TEXT,
  expires_at TEXT,
  decided_by TEXT
);
CREATE INDEX grants_member_status ON grants (member_id, status);

CREATE TABLE tickets (
  id TEXT PRIMARY KEY NOT NULL,
  from_group TEXT NOT NULL,
  from_member TEXT NOT NULL,
  from_task_id TEXT NOT NULL,
  from_thread TEXT NOT NULL,
  to_group TEXT NOT NULL,
  purpose TEXT NOT NULL,
  context TEXT NOT NULL,
  done_when TEXT NOT NULL,
  reply_as TEXT NOT NULL,
  depth INTEGER NOT NULL,
  thread TEXT NOT NULL,
  status TEXT NOT NULL,
  assigned_member TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX tickets_status ON tickets (status);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  device_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  assertion TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  x25519_public_key TEXT,
  webauthn_credential_id TEXT NOT NULL,
  webauthn_public_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  CONSTRAINT devices_credential UNIQUE (webauthn_credential_id)
);

CREATE TABLE usage_state (
  account_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  resets_at TEXT,
  rate_limit_type TEXT,
  utilization REAL,
  updated_at TEXT NOT NULL
);

CREATE TABLE tool_pins (
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  hash TEXT NOT NULL,
  approved_at TEXT,
  approval_id TEXT,
  PRIMARY KEY (server_id, tool_name)
);

CREATE TABLE host_tool_state (
  tool_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  started_at TEXT,
  started_by TEXT
);

CREATE TABLE used_nonces (
  nonce TEXT PRIMARY KEY NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX used_nonces_expires ON used_nonces (expires_at);

-- 5.10：AUTOINCREMENT にして、消した行の seq を使い回さない（sqlite_sequence に最後の seq が残る）
CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX audit_log_ts ON audit_log (ts);

-- 5.10 の1：監査ログは追記だけ。行の書き換えは、データベースの側でも止める
-- （削除は、保存期間を過ぎた行を消すときに使う。5.10 の5）
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, '監査ログの行は書き換えられません（追記だけです）');
END;
`,
];
