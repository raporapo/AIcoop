import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, GENESIS_HASH } from "@aicoop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeClock, fakeClock, memoryDb, type TempDir, tempDir } from "../testing/state-db.ts";
import {
  AuditChainBrokenError,
  appendAudit,
  listAuditLog,
  pruneAuditLog,
  verifyAuditLog,
} from "./audit.ts";
import { openStateDb, type StateDb, writeTransaction } from "./open.ts";

const DAY = 24 * 60 * 60 * 1000;
const TASK = "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB";

function appendN(db: StateDb, clock: FakeClock, n: number, stepMs = DAY): void {
  for (let i = 0; i < n; i++) {
    appendAudit(db, {
      actor: "system",
      kind: "box.lifecycle",
      subject: "dev",
      data: { group: "dev", box_kind: "vm", event: i % 2 === 0 ? "start" : "stop" },
    });
    clock.advance(stepMs);
  }
}

/** 攻撃者のように、書き換えを止める仕掛けを外してから直接いじる */
function rawTamper(db: StateDb, sql: string): void {
  db.sqlite.exec("DROP TRIGGER IF EXISTS audit_log_no_update");
  db.sqlite.exec(sql);
}

describe("5.10：監査ログの追記", () => {
  let db: StateDb;
  let clock: FakeClock;
  beforeEach(() => {
    ({ db, clock } = memoryDb());
  });
  afterEach(() => db.close());

  it("最初の行は seq 1、prev_hash は 0 が64個。時刻は制御サーバーの時計で書く", () => {
    const row = appendAudit(db, {
      actor: "system",
      kind: "task.state",
      subject: TASK,
      data: { from: null, to: "queued" },
    });
    expect(row).toMatchObject({
      seq: 1,
      ts: "2026-11-28T00:00:00.000Z",
      actor: "system",
      kind: "task.state",
      subject: TASK,
      data: '{"from":null,"to":"queued"}',
      prevHash: GENESIS_HASH,
    });
    expect(listAuditLog(db)).toEqual([row]);
  });

  it("5.10 の2：直前の行の hash から計算してつなげる", () => {
    appendN(db, clock, 3);
    const rows = listAuditLog(db);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] as (typeof rows)[number];
      expect(row.prevHash).toBe(rows[i - 1]?.hash);
      const content = canonicalJson({
        seq: row.seq,
        ts: row.ts,
        actor: row.actor,
        kind: row.kind,
        subject: row.subject,
        data: JSON.parse(row.data),
      });
      expect(row.hash).toBe(
        createHash("sha256")
          .update(row.prevHash + content)
          .digest("hex"),
      );
    }
  });

  it("11.4：外のトランザクションが取り消されたら、監査ログの行も残らない（状態の変化と一緒に書く）", () => {
    expect(() =>
      writeTransaction(db, () => {
        appendN(db, clock, 1);
        throw new Error("途中で失敗");
      }),
    ).toThrow("途中で失敗");
    expect(listAuditLog(db)).toEqual([]);
    appendN(db, clock, 1);
    expect(listAuditLog(db).map((r) => r.seq)).toEqual([1]);
    expect(verifyAuditLog(db)).toMatchObject({ ok: true });
  });

  it("JSON にできない data は書かない", () => {
    expect(() =>
      appendAudit(db, {
        actor: "system",
        kind: "proxy.decision",
        subject: "dev-implementer",
        data: {
          member: "dev-implementer",
          operation: null,
          host: "example.com",
          path: "/",
          decision: "deny",
          reason: "no_operation",
          body_bytes: Number.NaN,
        },
      }),
    ).toThrow(TypeError);
    expect(listAuditLog(db)).toEqual([]);
  });

  it("after を渡すと、その seq より後ろだけを読む（9.2 の GET /audit?after=）", () => {
    appendN(db, clock, 5);
    expect(listAuditLog(db, { after: 3 }).map((r) => r.seq)).toEqual([4, 5]);
    expect(listAuditLog(db, { after: 0, limit: 2 }).map((r) => r.seq)).toEqual([1, 2]);
  });
});

describe("5.10 の4・P1 完了条件5：つながりの確認（aicoop audit verify）", () => {
  let db: StateDb;
  let clock: FakeClock;
  beforeEach(() => {
    ({ db, clock } = memoryDb());
  });
  afterEach(() => db.close());

  it("ふつうに書いたログは通る", () => {
    appendN(db, clock, 10);
    expect(verifyAuditLog(db)).toMatchObject({ ok: true, count: 10, firstSeq: 1, lastSeq: 10 });
  });

  it("1行もなければ通る", () => {
    expect(verifyAuditLog(db)).toMatchObject({ ok: true, count: 0 });
  });

  it("5.10 の4：途中の行の data を書き換えると、つながりの確認が失敗する", () => {
    appendN(db, clock, 5);
    rawTamper(
      db,
      `UPDATE audit_log SET data = '{"box_kind":"vm","event":"stop","group":"sales"}' WHERE seq = 3`,
    );
    expect(verifyAuditLog(db)).toMatchObject({ ok: false, seq: 3, reason: "hash_mismatch" });
  });

  it("5.10 の4：途中の行を消すと失敗する", () => {
    appendN(db, clock, 5);
    db.sqlite.exec("DELETE FROM audit_log WHERE seq = 2");
    expect(verifyAuditLog(db)).toMatchObject({ ok: false, seq: 3, reason: "seq_gap" });
  });

  it("末尾の行を消すと失敗する（通し番号の記録と合わない）", () => {
    appendN(db, clock, 5);
    db.sqlite.exec("DELETE FROM audit_log WHERE seq >= 4");
    expect(verifyAuditLog(db)).toMatchObject({ ok: false, seq: 4, reason: "last_seq_mismatch" });
  });

  it("末尾を消したあとに書き足しても、消した跡は残る（seq を使い回さない）", () => {
    appendN(db, clock, 5);
    db.sqlite.exec("DELETE FROM audit_log WHERE seq >= 4");
    appendN(db, clock, 1);
    expect(listAuditLog(db).map((r) => r.seq)).toEqual([1, 2, 3, 6]);
    expect(verifyAuditLog(db)).toMatchObject({ ok: false, seq: 6, reason: "seq_gap" });
  });

  it("すべての行を消すと失敗する", () => {
    appendN(db, clock, 3);
    db.sqlite.exec("DELETE FROM audit_log");
    expect(verifyAuditLog(db)).toMatchObject({ ok: false, reason: "last_seq_mismatch" });
  });

  it("すべての行を消したあとに書き足しても、失敗のまま", () => {
    appendN(db, clock, 3);
    db.sqlite.exec("DELETE FROM audit_log");
    appendN(db, clock, 1);
    expect(verifyAuditLog(db)).toMatchObject({ ok: false, seq: 4, reason: "bad_start" });
  });

  it("hash を書き換えると失敗する", () => {
    appendN(db, clock, 3);
    rawTamper(db, `UPDATE audit_log SET hash = '${"f".repeat(64)}' WHERE seq = 2`);
    expect(verifyAuditLog(db)).toMatchObject({ ok: false, seq: 2, reason: "hash_mismatch" });
  });

  it("2つの行の中身を入れ替えると失敗する", () => {
    appendN(db, clock, 4);
    rawTamper(
      db,
      `UPDATE audit_log SET seq = -1 WHERE seq = 2;
       UPDATE audit_log SET seq = 2 WHERE seq = 3;
       UPDATE audit_log SET seq = 3 WHERE seq = -1;`,
    );
    expect(verifyAuditLog(db)).toMatchObject({ ok: false, seq: 2 });
  });
});

describe("5.10 の5：保存期間を過ぎた行の削除と checkpoint 行", () => {
  let db: StateDb;
  let clock: FakeClock;
  beforeEach(() => {
    ({ db, clock } = memoryDb("2026-01-01T00:00:00.000Z"));
  });
  afterEach(() => db.close());

  it("保存期間より古い行を消し、消した範囲の最後の hash を持つ checkpoint 行を書く。つながりは保たれる", () => {
    appendN(db, clock, 400); // 1日に1行、400日分
    const before = listAuditLog(db);
    const result = pruneAuditLog(db, { retentionDays: 365 });

    // 今は 2026-01-01 + 400日。365日より古い行（最初の35行）を消す
    expect(result.deleted).toBe(35);
    const rows = listAuditLog(db);
    expect(rows[0]?.seq).toBe(36);
    const cp = rows.at(-1);
    expect(cp).toMatchObject({ seq: 401, kind: "checkpoint", actor: "system" });
    expect(JSON.parse(cp?.data as string)).toMatchObject({
      from_seq: 1,
      to_seq: 35,
      last_hash: before[34]?.hash,
      deleted_rows: 35,
    });
    expect(result.checkpoint).toEqual(cp);
    expect(verifyAuditLog(db)).toMatchObject({ ok: true, firstSeq: 36, lastSeq: 401 });
  });

  it("消したあとに書き足しても、2回目に消しても通る", () => {
    appendN(db, clock, 400);
    pruneAuditLog(db, { retentionDays: 365 });
    appendN(db, clock, 100);
    const second = pruneAuditLog(db, { retentionDays: 365 });
    expect(second.deleted).toBeGreaterThan(0);
    expect(verifyAuditLog(db)).toMatchObject({ ok: true });
  });

  it("すべての行が古ければ、すべて消して checkpoint だけを残す。そのあと書き足しても通る", () => {
    appendN(db, clock, 10);
    clock.advance(400 * DAY);
    const result = pruneAuditLog(db, { retentionDays: 365 });
    expect(result.deleted).toBe(10);
    expect(listAuditLog(db).map((r) => r.kind)).toEqual(["checkpoint"]);
    appendN(db, clock, 2);
    expect(verifyAuditLog(db)).toMatchObject({ ok: true, firstSeq: 11, lastSeq: 13 });
  });

  it("消す行がなければ何もしない", () => {
    appendN(db, clock, 10);
    expect(pruneAuditLog(db, { retentionDays: 365 })).toEqual({ deleted: 0, checkpoint: null });
    expect(listAuditLog(db)).toHaveLength(10);
  });

  it.each([29, 3651, 30.5, Number.NaN])(
    "保存期間が 6.2 の範囲（30〜3650 の整数）でなければ消さない（%s）",
    (days) => {
      appendN(db, clock, 10);
      clock.advance(4000 * DAY);
      expect(() => pruneAuditLog(db, { retentionDays: days })).toThrow(RangeError);
      expect(listAuditLog(db)).toHaveLength(10);
    },
  );

  it("つながりが壊れていたら消さない（改ざんの跡を checkpoint で隠さない）", () => {
    appendN(db, clock, 400);
    rawTamper(
      db,
      `UPDATE audit_log SET data = '{"box_kind":"vm","event":"start","group":"x"}' WHERE seq = 5`,
    );
    expect(() => pruneAuditLog(db, { retentionDays: 365 })).toThrow(AuditChainBrokenError);
    expect(listAuditLog(db)).toHaveLength(400);
  });
});

describe("ファイルの state.db で", () => {
  let dir: TempDir;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.cleanup());

  it("閉じて開き直しても、つながりが確かめられ、続きから書ける", () => {
    const path = join(dir.path, "state.db");
    const clock = fakeClock();
    const a = openStateDb(path, { now: clock.now });
    appendN(a, clock, 3);
    a.close();

    const b = openStateDb(path, { now: clock.now });
    appendN(b, clock, 2);
    expect(verifyAuditLog(b)).toMatchObject({ ok: true, count: 5, lastSeq: 5 });
    b.close();
  });
});
