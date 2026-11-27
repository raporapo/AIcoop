import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import { openStateDb, STATE_DB_VERSION } from "./open.ts";
import * as schema from "./schema.ts";

// 7.2 の表と列（設計書のとおりの名前）
const DESIGN_TABLES: Record<string, string[]> = {
  tasks: [
    "id",
    "member_id",
    "group_id",
    "trigger_kind",
    "trigger_id",
    "priority",
    "thread",
    "status",
    "purpose",
    "context",
    "done_when",
    "context_untrusted",
    "reply_as",
    "ticket_id",
    "review_subject",
    "hold_id",
    "timeout_minutes",
    "created_at",
    "started_at",
    "ended_at",
    "retry_at",
    "result_summary",
    "result_files",
    "error",
  ],
  runs: [
    "id",
    "task_id",
    "group_id",
    "member_id",
    "box_kind",
    "session_id",
    "gateway_port",
    "started_at",
    "ended_at",
    "exit_code",
    "end_reason",
    "log_path",
  ],
  sessions: ["member_id", "thread", "session_id", "created_at", "last_used_at"],
  holds: [
    "id",
    "run_id",
    "task_id",
    "member_id",
    "group_id",
    "thread",
    "service",
    "operation",
    "params",
    "request_path",
    "request_bytes",
    "summary",
    "manager_comment",
    "status",
    "created_at",
    "expires_at",
    "decided_at",
    "decided_by",
    "response_status",
    "response_path",
  ],
  grants: [
    "id",
    "member_id",
    "service",
    "operation",
    "params",
    "mode",
    "reason",
    "duration_hours",
    "status",
    "created_at",
    "starts_at",
    "expires_at",
    "decided_by",
  ],
  tickets: [
    "id",
    "from_group",
    "from_member",
    "from_task_id",
    "from_thread",
    "to_group",
    "purpose",
    "context",
    "done_when",
    "reply_as",
    "depth",
    "thread",
    "status",
    "assigned_member",
    "created_at",
    "done_at",
  ],
  approvals: [
    "id",
    "subject_type",
    "subject_id",
    "decision",
    "device_id",
    "payload",
    "assertion",
    "verified_at",
  ],
  devices: [
    "id",
    "name",
    "kind",
    "x25519_public_key",
    "webauthn_credential_id",
    "webauthn_public_key",
    "sign_count",
    "created_at",
    "revoked_at",
  ],
  usage_state: [
    "account_id",
    "status",
    "resets_at",
    "rate_limit_type",
    "utilization",
    "updated_at",
  ],
  tool_pins: ["server_id", "tool_name", "hash", "approved_at", "approval_id"],
  host_tool_state: ["tool_id", "status", "pid", "started_at", "started_by"],
  used_nonces: ["nonce", "expires_at"],
  audit_log: ["seq", "ts", "actor", "kind", "subject", "data", "prev_hash", "hash"],
};

const DRIZZLE_TABLES: SQLiteTable[] = [
  schema.tasks,
  schema.runs,
  schema.sessions,
  schema.holds,
  schema.grants,
  schema.tickets,
  schema.approvals,
  schema.devices,
  schema.usageState,
  schema.toolPins,
  schema.hostToolState,
  schema.usedNonces,
  schema.auditLog,
];

interface ColumnInfo {
  name: string;
  notnull: number;
  pk: number;
}

describe("7.2：state.db の表", () => {
  it("設計書の表と列がすべてある（列名は設計書のとおり）", () => {
    const db = openStateDb(":memory:");
    for (const [table, columns] of Object.entries(DESIGN_TABLES)) {
      const info = db.sqlite.pragma(`table_info(${table})`) as ColumnInfo[];
      expect(
        info.map((c) => c.name),
        table,
      ).toEqual(columns);
    }
    db.close();
  });

  it("Drizzle のスキーマが、作った表と同じ列・NOT NULL・主キーを持つ", () => {
    const db = openStateDb(":memory:");
    expect(DRIZZLE_TABLES.map((t) => getTableConfig(t).name).sort()).toEqual(
      Object.keys(DESIGN_TABLES).sort(),
    );
    for (const table of DRIZZLE_TABLES) {
      const config = getTableConfig(table);
      const info = db.sqlite.pragma(`table_info(${config.name})`) as ColumnInfo[];
      const compositePk = new Set(
        config.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)),
      );
      const fromDrizzle = config.columns.map((c) => ({
        name: c.name,
        notNull: c.notNull || c.primary || compositePk.has(c.name),
        pk: c.primary || compositePk.has(c.name),
      }));
      const fromSqlite = info.map((c) => ({
        name: c.name,
        notNull: c.notnull === 1 || c.pk > 0,
        pk: c.pk > 0,
      }));
      expect(
        [...fromDrizzle].sort((a, b) => a.name.localeCompare(b.name)),
        config.name,
      ).toEqual([...fromSqlite].sort((a, b) => a.name.localeCompare(b.name)));
    }
    db.close();
  });

  it("5.10 の1：監査ログの行は書き換えられない（追記だけ）", () => {
    const db = openStateDb(":memory:");
    db.sqlite
      .prepare(
        "INSERT INTO audit_log (seq, ts, actor, kind, subject, data, prev_hash, hash) VALUES (1, 't', 'system', 'k', 's', '{}', 'p', 'h')",
      )
      .run();
    expect(() => db.sqlite.prepare("UPDATE audit_log SET data = '{\"x\":1}'").run()).toThrow(
      /書き換え/,
    );
    db.close();
  });
});

describe("7.1・11.4：openStateDb", () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    dir.cleanup();
  });

  it("ファイルが無ければ作り、WAL モードで開く", () => {
    const path = join(dir.path, "state.db");
    const db = openStateDb(path);
    expect(existsSync(path)).toBe(true);
    expect(db.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.sqlite.pragma("user_version", { simple: true })).toBe(STATE_DB_VERSION);
    db.close();
  });

  it(":memory: でも開ける", () => {
    const db = openStateDb(":memory:");
    expect(db.sqlite.pragma("user_version", { simple: true })).toBe(STATE_DB_VERSION);
    db.close();
  });

  it("開き直しても、既存のデータを壊さない", () => {
    const path = join(dir.path, "state.db");
    const first = openStateDb(path);
    first.sqlite
      .prepare(
        "INSERT INTO used_nonces (nonce, expires_at) VALUES ('n1', '2026-11-28T00:02:00.000Z')",
      )
      .run();
    first.close();

    const second = openStateDb(path);
    expect(second.sqlite.prepare("SELECT nonce FROM used_nonces").all()).toEqual([{ nonce: "n1" }]);
    expect(second.sqlite.pragma("user_version", { simple: true })).toBe(STATE_DB_VERSION);
    second.close();
  });

  it("この aicoop より新しい版の state.db は開かない（中身に触らない）", () => {
    const path = join(dir.path, "state.db");
    const raw = new Database(path);
    raw.pragma(`user_version = ${STATE_DB_VERSION + 1}`);
    raw.close();

    expect(() => openStateDb(path)).toThrow(/新しい/);
    const check = new Database(path);
    expect(check.pragma("user_version", { simple: true })).toBe(STATE_DB_VERSION + 1);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]);
    check.close();
  });

  it("版の記録がないのに表がある（知らないデータベース）なら、書き換えずに止める", () => {
    const path = join(dir.path, "state.db");
    const raw = new Database(path);
    raw.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, something TEXT)");
    raw.close();

    expect(() => openStateDb(path)).toThrow();
    const check = new Database(path);
    expect(check.pragma("user_version", { simple: true })).toBe(0);
    expect((check.pragma("table_info(tasks)") as ColumnInfo[]).map((c) => c.name)).toEqual([
      "id",
      "something",
    ]);
    check.close();
  });

  it("時計を差し替えられる（テストで時刻を決める）", () => {
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    const db = openStateDb(":memory:", { now: () => fixed });
    expect(db.now()).toBe(fixed);
    db.close();
  });
});
