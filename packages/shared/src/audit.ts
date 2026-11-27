/**
 * 監査ログのハッシュの連鎖（5.10）のうち、OSにもデータベースにも依存しない部分。
 *
 * - 各行の hash は「prev_hash と、その行の内容の正規化JSONをつなげたもの」の SHA-256（16進の小文字）
 *   - 行の内容は `{seq, ts, actor, kind, subject, data}`。`data` は JSON として読んだ値を入れる
 *   - `seq` を内容に入れるので、行を消したり入れ替えたりすると、つながりが切れる
 * - 最初の行の prev_hash は `0` を64個並べた文字列（GENESIS_HASH）
 * - `data` は必ず正規化JSONで保存する。確かめるときも、正規化JSONでない `data` は改ざんとみなす
 *   （同じ意味の別の書き方に書き換えられても見逃さない）
 * - 保存期間で古い行を消すときは（5.10 の5）、消した範囲の最後の hash を持つ `checkpoint` 行を末尾に足す。
 *   残った最初の行の prev_hash は、その checkpoint の `last_hash` とつながる
 *
 * 限界：鍵を使わないハッシュの連鎖なので、`state.db` に書き込める者が、すべての行を計算し直せば
 * 偽造できる。末尾の行を消したことも、つながりだけでは分からない。見つけられるのは、
 * 途中の行の書き換え・削除・入れ替えと、つじつまの合わない checkpoint である。
 * 箱（Z3）からは `state.db` に届かない（4.5、5.1.7）。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { BoxKind } from "./box.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { TaskStatus } from "./task-state.ts";

/** 最初の行の prev_hash（5.10 の2） */
export const GENESIS_HASH = "0".repeat(64);

/** 保存期間の最小（`audit.retention_days` は 30〜3650。6.2）。これより新しい行を消した checkpoint は偽造とみなす */
export const AUDIT_MIN_RETENTION_DAYS = 30;

const HASH = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 操作した者（7.2 の audit_log.actor） */
export type AuditActor = "system" | `owner:${string}` | `member:${string}`;

/**
 * 種類ごとの `data` の中身（5.10 の3の表）。
 *
 * **本物の資格を書いてはならない**（5.2.8、11.5）。ここに足してよいのは、設計書の表にあるものだけ。
 * リクエストの本文・ヘッダー・クエリ文字列（トークンや持ち出しのデータが入りうる）は書かない。
 */
export interface AuditDataMap {
  /** 社員、操作、宛先のホストとパス、判定、理由、本文のバイト数（本文そのものは書かない） */
  "proxy.decision": {
    readonly member: string;
    readonly operation: string | null;
    readonly host: string;
    /** クエリ文字列を除いたパス */
    readonly path: string;
    readonly decision: "allow" | "hold" | "deny";
    readonly reason: string | null;
    readonly body_bytes: number | null;
  };
  /** 社員、ホスト、接続の開始と終了の時刻（記録できる場合だけ。5.2.7） */
  "proxy.passthrough": {
    readonly member: string;
    readonly host: string;
    readonly started_at: string | null;
    readonly ended_at: string | null;
  };
  /** 社員、道具名、引数の正規化JSONの SHA-256、成否 */
  "gateway.call": {
    readonly member: string;
    readonly tool: string;
    readonly args_sha256: string;
    readonly ok: boolean;
  };
  /** タスク（subject）、変化前と変化後の状態。作ったときは from が null */
  "task.state": {
    readonly from: TaskStatus | null;
    readonly to: TaskStatus;
    /** 決まった理由の符号だけ（自由な文章は書かない） */
    readonly reason?: "daemon_restart";
  };
  /** 対象（subject）、変化前と変化後の状態、決めた者 */
  "hold.state": { readonly from: string | null; readonly to: string; readonly by: string };
  "grant.state": { readonly from: string | null; readonly to: string; readonly by: string };
  "ticket.state": { readonly from: string | null; readonly to: string; readonly by: string };
  /** 対象（subject）、決定、端末ID */
  approval: {
    readonly subject_type: string;
    readonly decision: "approve" | "reject";
    readonly device_id: string;
  };
  /** 読み込んだ設定ファイルごとの SHA-256（ファイル名 → ハッシュ） */
  "config.load": { readonly files: Readonly<Record<string, string>> };
  /** 資格のIDと、登録か削除か（中身は書かない） */
  "secret.change": { readonly secret_id: string; readonly change: "set" | "rm" };
  /** 部署、箱の種類、起動・停止 */
  "box.lifecycle": {
    readonly group: string;
    readonly box_kind: BoxKind;
    readonly event: "start" | "stop";
  };
  /** 隔離したファイルのパス（5.4.4） */
  quarantine: { readonly paths: readonly string[] };
  /** 道具、起動・停止、操作した者 */
  "host_tool.state": {
    readonly tool: string;
    readonly event: "start" | "stop";
    readonly by: string;
  };
  /** 保存期間で消した範囲（5.10 の5） */
  checkpoint: CheckpointData;
}

export type AuditKind = keyof AuditDataMap;

export interface CheckpointData {
  /** 消した範囲の最初の seq */
  readonly from_seq: number;
  /** 消した範囲の最後の seq */
  readonly to_seq: number;
  /** 消した範囲の最後の行の hash。残った最初の行の prev_hash とつながる */
  readonly last_hash: string;
  /** 消した範囲の最後の行の時刻 */
  readonly last_ts: string;
  /** この時刻より古い行を消した（checkpoint の時刻 − 保存期間） */
  readonly cutoff: string;
  /** 消した行の数（to_seq − from_seq + 1） */
  readonly deleted_rows: number;
}

/** 書き込む1行の中身 */
export type AuditEntry = {
  [K in AuditKind]: {
    readonly ts: string;
    readonly actor: AuditActor;
    readonly kind: K;
    readonly subject: string;
    readonly data: AuditDataMap[K];
  };
}[AuditKind];

/** audit_log の1行（7.2）。`data` は正規化JSONの文字列 */
export interface AuditRow {
  readonly seq: number;
  readonly ts: string;
  readonly actor: string;
  readonly kind: string;
  readonly subject: string;
  readonly data: string;
  readonly prevHash: string;
  readonly hash: string;
}

/** 5.10 の2：行の hash を計算する。`data` が JSON として読めなければ例外 */
export function computeAuditHash(row: Omit<AuditRow, "hash">): string {
  return hashOf(row, JSON.parse(row.data));
}

function hashOf(row: Omit<AuditRow, "hash">, data: unknown): string {
  const content = canonicalJson({
    seq: row.seq,
    ts: row.ts,
    actor: row.actor,
    kind: row.kind,
    subject: row.subject,
    data,
  });
  return createHash("sha256")
    .update(row.prevHash + content, "utf8")
    .digest("hex");
}

/**
 * 直前の行（なければ null）につなげて、次の行を作る。
 * `data` は正規化JSONにする。JSON にできない値（NaN など）があれば TypeError。
 */
export function buildAuditRow(
  prev: { readonly seq: number; readonly hash: string } | null,
  entry: AuditEntry,
): AuditRow {
  if (prev !== null && (!Number.isSafeInteger(prev.seq) || prev.seq < 1 || !HASH.test(prev.hash))) {
    throw new Error("直前の監査ログの行が壊れているので、つなげられません");
  }
  const base = {
    seq: prev === null ? 1 : prev.seq + 1,
    ts: entry.ts,
    actor: entry.actor,
    kind: entry.kind,
    subject: entry.subject,
    data: canonicalJson(entry.data),
    prevHash: prev === null ? GENESIS_HASH : prev.hash,
  };
  return { ...base, hash: computeAuditHash(base) };
}

/** 保存期間で古い行を消したときの checkpoint 行の中身（5.10 の5） */
export function checkpointEntry(input: {
  readonly ts: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly lastHash: string;
  readonly lastTs: string;
  readonly cutoff: string;
}): Extract<AuditEntry, { kind: "checkpoint" }> {
  return {
    ts: input.ts,
    actor: "system",
    kind: "checkpoint",
    subject: "audit_log",
    data: {
      from_seq: input.fromSeq,
      to_seq: input.toSeq,
      last_hash: input.lastHash,
      last_ts: input.lastTs,
      cutoff: input.cutoff,
      deleted_rows: input.toSeq - input.fromSeq + 1,
    },
  };
}

export type AuditBreakReason =
  /** seq が整数でない、列が文字列でない */
  | "bad_row"
  /** seq が前の行より大きくない（重複・逆戻り） */
  | "seq_order"
  /** seq が飛んでいる（途中の行が消された） */
  | "seq_gap"
  /** hash・prev_hash が 64桁の16進（小文字）でない */
  | "bad_hash_format"
  /** prev_hash が前の行の hash と違う */
  | "prev_hash_mismatch"
  /** data が JSON として読めない、または正規化JSONでない */
  | "data_invalid"
  /** hash が、内容から計算したものと違う */
  | "hash_mismatch"
  /** 最初の行の prev_hash が GENESIS_HASH なのに、seq が 1 でない */
  | "bad_start"
  /** 最初の行より前が消されているのに、それを示す checkpoint がない */
  | "missing_checkpoint"
  /** checkpoint 行の中身がおかしい（形・つじつま） */
  | "checkpoint_invalid"
  /** 最後の行の seq が、データベースの通し番号の記録と合わない（末尾の行が消された） */
  | "last_seq_mismatch";

export type AuditVerifyResult =
  | {
      readonly ok: true;
      readonly count: number;
      readonly firstSeq: number | null;
      readonly lastSeq: number | null;
      /** 最後の行の hash（行がなければ GENESIS_HASH）。外に控えておけば、末尾の削除に気づける */
      readonly lastHash: string;
    }
  | {
      readonly ok: false;
      /** 最初に壊れていた行の seq */
      readonly seq: number;
      readonly reason: AuditBreakReason;
      readonly message: string;
    };

/**
 * 5.10 の4：最初から最後までハッシュのつながりを確かめる。
 * `rows` は seq の小さい順に渡す（データベースから1行ずつ読みながら渡してよい）。
 *
 * `expectedLastSeq` に、これまでに書いた最後の seq（SQLite の AUTOINCREMENT の記録）を渡すと、
 * 末尾の行が消されたことにも気づける。null は「1行も書いていない」。
 */
export function verifyAuditChain(
  rows: Iterable<AuditRow>,
  opts: { readonly expectedLastSeq?: number | null } = {},
): AuditVerifyResult {
  let first: AuditRow | undefined;
  let prev: AuditRow | undefined;
  let count = 0;
  /** 最初の行より前が消されていて、まだ checkpoint とつながっていない */
  let needsAnchor = false;

  for (const row of rows) {
    const fail = (reason: AuditBreakReason, message: string): AuditVerifyResult => ({
      ok: false,
      seq: row.seq,
      reason,
      message: `seq ${row.seq}：${message}`,
    });

    if (!isRowShape(row)) return fail("bad_row", "行の形が壊れています");
    if (prev !== undefined) {
      if (row.seq <= prev.seq) {
        return fail("seq_order", `seq ${prev.seq} のあとに来ています（並びが壊れています）`);
      }
      if (row.seq !== prev.seq + 1) {
        return fail("seq_gap", `seq ${prev.seq + 1} から ${row.seq - 1} の行がありません`);
      }
    }
    if (!HASH.test(row.prevHash) || !HASH.test(row.hash)) {
      return fail("bad_hash_format", "hash・prev_hash が64桁の16進（小文字）ではありません");
    }
    if (prev !== undefined) {
      if (row.prevHash !== prev.hash) {
        return fail("prev_hash_mismatch", "prev_hash が前の行の hash と違います");
      }
    } else if (row.prevHash === GENESIS_HASH) {
      if (row.seq !== 1) {
        return fail("bad_start", "最初の行なのに seq が 1 ではありません");
      }
    } else {
      needsAnchor = true;
    }

    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      return fail("data_invalid", "data が JSON として読めません");
    }
    if (canonicalJson(data) !== row.data) {
      return fail("data_invalid", "data が正規化JSONではありません（書き換えられています）");
    }
    if (hashOf(row, data) !== row.hash) {
      return fail("hash_mismatch", "hash が行の内容と合いません（書き換えられています）");
    }

    const head = first ?? row;
    if (row.kind === "checkpoint") {
      const checked = checkCheckpoint(row, data, head.seq);
      if (!checked.ok) return fail("checkpoint_invalid", checked.message);
      if (
        needsAnchor &&
        checked.data.to_seq === head.seq - 1 &&
        checked.data.last_hash === head.prevHash
      ) {
        needsAnchor = false;
      }
    }

    first = head;
    prev = row;
    count++;
  }

  if (first !== undefined && needsAnchor) {
    return {
      ok: false,
      seq: first.seq,
      reason: "missing_checkpoint",
      message: `seq ${first.seq}：これより前の行が消されていますが、それを示す checkpoint 行がありません`,
    };
  }
  const lastSeq = prev?.seq ?? null;
  if (opts.expectedLastSeq !== undefined && opts.expectedLastSeq !== lastSeq) {
    const expected = opts.expectedLastSeq ?? 0;
    const seq = lastSeq === null || lastSeq < expected ? (lastSeq ?? 0) + 1 : expected + 1;
    return {
      ok: false,
      seq,
      reason: "last_seq_mismatch",
      message:
        lastSeq === null || lastSeq < expected
          ? `seq ${seq}：最後に書いた seq ${expected} までの行がありません（末尾の行が消されています）`
          : `seq ${seq}：通し番号の記録（${expected}）より後ろの行があります（記録が書き換えられています）`,
    };
  }
  return {
    ok: true,
    count,
    firstSeq: first?.seq ?? null,
    lastSeq: prev?.seq ?? null,
    lastHash: prev?.hash ?? GENESIS_HASH,
  };
}

function isRowShape(row: AuditRow): boolean {
  return (
    Number.isSafeInteger(row.seq) &&
    row.seq >= 1 &&
    typeof row.ts === "string" &&
    typeof row.actor === "string" &&
    typeof row.kind === "string" &&
    typeof row.subject === "string" &&
    typeof row.data === "string" &&
    typeof row.prevHash === "string" &&
    typeof row.hash === "string"
  );
}

const isoTimestamp = z.string().refine(parseIso);
const seqNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const checkpointDataSchema = z.strictObject({
  from_seq: seqNumber,
  to_seq: seqNumber,
  last_hash: z.string().regex(HASH),
  last_ts: isoTimestamp,
  cutoff: isoTimestamp,
  deleted_rows: seqNumber,
});

function parseIso(value: string): boolean {
  if (!ISO_UTC.test(value)) return false;
  const t = Date.parse(value);
  return !Number.isNaN(t) && new Date(t).toISOString() === value;
}

function checkCheckpoint(
  row: AuditRow,
  data: unknown,
  firstSeq: number,
): { ok: true; data: CheckpointData } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (row.actor !== "system") return bad("checkpoint を書けるのは system だけです");
  const parsed = checkpointDataSchema.safeParse(data);
  if (!parsed.success) return bad("checkpoint の data の形が壊れています");
  const cp = parsed.data;
  if (cp.from_seq > cp.to_seq) return bad("from_seq が to_seq より大きくなっています");
  if (cp.deleted_rows !== cp.to_seq - cp.from_seq + 1) {
    return bad("deleted_rows が from_seq〜to_seq の行数と合いません");
  }
  if (cp.to_seq >= row.seq) return bad("checkpoint より後ろの行を消したことになっています");
  if (cp.to_seq >= firstSeq) {
    return bad(`消したはずの seq ${cp.to_seq} 以前の行が残っています`);
  }
  if (!parseIso(row.ts)) return bad("checkpoint の時刻が読めません");
  if (Date.parse(cp.last_ts) >= Date.parse(cp.cutoff)) {
    return bad("区切りの時刻（cutoff）より新しい行を消したことになっています");
  }
  if (Date.parse(cp.cutoff) > Date.parse(row.ts) - AUDIT_MIN_RETENTION_DAYS * DAY_MS) {
    return bad(
      `保存期間の最小（${AUDIT_MIN_RETENTION_DAYS}日）より新しい行を消したことになっています`,
    );
  }
  return { ok: true, data: cp };
}
