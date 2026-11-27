/**
 * 監査ログ（5.10）の state.db 側：追記、つながりの確認、保存期間を過ぎた行の削除。
 *
 * ハッシュの計算とつながりの確かめ方は `@aicoop/shared` の audit.ts にある。
 *
 * **本物の資格を書いてはならない**（5.2.8、11.5）。`data` に入れてよいのは、設計書 5.10 の3の表に
 * あるもの（`AuditDataMap` の型のとおり）だけ。リクエストの本文・ヘッダー・クエリ文字列・
 * 道具の引数そのもの・エラーの文章は入れない（トークンや持ち出しのデータが混ざりうる）。
 */
import {
  AUDIT_MIN_RETENTION_DAYS,
  type AuditEntry,
  type AuditRow,
  type AuditVerifyResult,
  canonicalJson,
  checkpointEntry,
  computeAuditHash,
  GENESIS_HASH,
  verifyAuditChain,
} from "@aicoop/shared";
import { type StateDb, writeTransaction } from "./open.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
/** `audit.retention_days` の上限（6.2） */
const AUDIT_MAX_RETENTION_DAYS = 3650;

/** 書き込む1行（時刻は制御サーバーの時計で付ける） */
export type AuditInput = AuditEntry extends infer E
  ? E extends AuditEntry
    ? Omit<E, "ts">
    : never
  : never;

export class AuditChainBrokenError extends Error {
  override name = "AuditChainBrokenError";
  readonly result: Extract<AuditVerifyResult, { ok: false }>;
  constructor(result: Extract<AuditVerifyResult, { ok: false }>) {
    super(`監査ログのつながりが壊れています：${result.message}`);
    this.result = result;
  }
}

const SELECT_ROW =
  "SELECT seq, ts, actor, kind, subject, data, prev_hash AS prevHash, hash FROM audit_log";

function lastRow(db: StateDb): { seq: number; hash: string } | null {
  const row = db.sqlite
    .prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1")
    .get() as { seq: number; hash: string } | undefined;
  return row ?? null;
}

/** これまでに書いた最後の seq（AUTOINCREMENT の記録）。1行も書いていなければ null */
function lastWrittenSeq(db: StateDb): number | null {
  const row = db.sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_log'").get() as
    | { seq: number }
    | undefined;
  return row?.seq ?? null;
}

function insertRow(db: StateDb, row: AuditRow): void {
  db.sqlite
    .prepare(
      "INSERT INTO audit_log (seq, ts, actor, kind, subject, data, prev_hash, hash) VALUES (@seq, @ts, @actor, @kind, @subject, @data, @prevHash, @hash)",
    )
    .run(row);
}

function makeRow(seq: number, prevHash: string, entry: AuditEntry): AuditRow {
  const base = {
    seq,
    ts: entry.ts,
    actor: entry.actor,
    kind: entry.kind,
    subject: entry.subject,
    data: canonicalJson(entry.data),
    prevHash,
  };
  return { ...base, hash: computeAuditHash(base) };
}

/**
 * 5.10 の1・2：1行を追記する。直前の行の hash から計算し、トランザクションの中で書く。
 * 状態の変化と同じトランザクションで呼べば、両方がそろって残るか、両方とも残らない。
 *
 * seq は「これまでに書いた最後の seq + 1」にする。末尾の行が消されていても使い回さないので、
 * 消した跡がつながりの確認で見つかる。
 */
export function appendAudit(db: StateDb, input: AuditInput): AuditRow {
  return writeTransaction(db, () => {
    const last = lastRow(db);
    const seq = Math.max(last?.seq ?? 0, lastWrittenSeq(db) ?? 0) + 1;
    const row = makeRow(seq, last?.hash ?? GENESIS_HASH, {
      ...input,
      ts: db.now().toISOString(),
    } as AuditEntry);
    insertRow(db, row);
    return row;
  });
}

/** 5.10 の4（`aicoop audit verify`）：最初から最後までハッシュのつながりを確かめる */
export function verifyAuditLog(db: StateDb): AuditVerifyResult {
  const rows = db.sqlite.prepare(`${SELECT_ROW} ORDER BY seq`).iterate() as Iterable<AuditRow>;
  return verifyAuditChain(rows, { expectedLastSeq: lastWrittenSeq(db) });
}

/** 監査ログを読む（承認アプリの記録・`GET /audit?after=<seq>`） */
export function listAuditLog(
  db: StateDb,
  opts: { readonly after?: number; readonly limit?: number } = {},
): AuditRow[] {
  const limit = opts.limit ?? -1;
  return db.sqlite
    .prepare(`${SELECT_ROW} WHERE seq > ? ORDER BY seq LIMIT ?`)
    .all(opts.after ?? 0, limit) as AuditRow[];
}

/**
 * 5.10 の5：保存期間（`audit.retention_days`）を過ぎた行を消し、消した範囲の最後の hash を持つ
 * checkpoint 行を末尾に書く。
 *
 * - 消すのは先頭から続く「区切りの時刻より古い行」だけ（途中に新しい行があれば、そこで止める）
 * - つながりが壊れていたら消さない（消すと、改ざんの跡を checkpoint で隠してしまう）
 */
export function pruneAuditLog(
  db: StateDb,
  opts: { readonly retentionDays: number },
): { deleted: number; checkpoint: AuditRow | null } {
  const days = opts.retentionDays;
  if (
    !Number.isInteger(days) ||
    days < AUDIT_MIN_RETENTION_DAYS ||
    days > AUDIT_MAX_RETENTION_DAYS
  ) {
    throw new RangeError(
      `audit.retention_days は ${AUDIT_MIN_RETENTION_DAYS}〜${AUDIT_MAX_RETENTION_DAYS} の整数にしてください: ${days}`,
    );
  }

  return writeTransaction(db, () => {
    const check = verifyAuditLog(db);
    if (!check.ok) throw new AuditChainBrokenError(check);

    const now = db.now();
    const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
    const first = db.sqlite.prepare("SELECT MIN(seq) AS seq FROM audit_log").get() as {
      seq: number | null;
    };
    const last = lastRow(db);
    if (first.seq === null || last === null) return { deleted: 0, checkpoint: null };

    const keep = db.sqlite
      .prepare("SELECT MIN(seq) AS seq FROM audit_log WHERE ts >= ?")
      .get(cutoff) as { seq: number | null };
    const toSeq = keep.seq === null ? last.seq : keep.seq - 1;
    if (toSeq < first.seq) return { deleted: 0, checkpoint: null };

    const lastDeleted = db.sqlite
      .prepare("SELECT hash, ts FROM audit_log WHERE seq = ?")
      .get(toSeq) as { hash: string; ts: string };
    const deleted = db.sqlite.prepare("DELETE FROM audit_log WHERE seq <= ?").run(toSeq).changes;

    const seq = Math.max(last.seq, lastWrittenSeq(db) ?? 0) + 1;
    const checkpoint = makeRow(
      seq,
      last.hash,
      checkpointEntry({
        ts: now.toISOString(),
        fromSeq: first.seq,
        toSeq,
        lastHash: lastDeleted.hash,
        lastTs: lastDeleted.ts,
        cutoff,
      }),
    );
    insertRow(db, checkpoint);
    return { deleted, checkpoint };
  });
}
