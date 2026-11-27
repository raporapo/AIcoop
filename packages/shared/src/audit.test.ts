import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUDIT_MIN_RETENTION_DAYS,
  type AuditEntry,
  type AuditRow,
  buildAuditRow,
  checkpointEntry,
  computeAuditHash,
  GENESIS_HASH,
  verifyAuditChain,
} from "./audit.ts";
import { canonicalJson } from "./canonical-json.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function entry(i: number, over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: new Date(T0 + i * DAY).toISOString(),
    actor: "system",
    kind: "task.state",
    subject: `t_01JD6V8X3S0Q5W7KQ9M2T4R6Y${"0123456789ABCDEFGHJKMNPQRSTVWXYZ"[i % 32]}`,
    data: { from: "queued", to: "starting" },
    ...over,
  } as AuditEntry;
}

/** seq 1 から n 行のつながり（1日に1行） */
function chain(n: number): AuditRow[] {
  const rows: AuditRow[] = [];
  for (let i = 0; i < n; i++) rows.push(buildAuditRow(rows.at(-1) ?? null, entry(i)));
  return rows;
}

/** 行を書き換えたコピー（hash は計算し直さない＝素朴な改ざん） */
function tamper(rows: AuditRow[], index: number, patch: Partial<AuditRow>): AuditRow[] {
  return rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
}

/** 行を書き換えて、その行の hash だけ計算し直す（後ろの行とのつながりで見つかるはず） */
function rehash(row: Omit<AuditRow, "hash">): AuditRow {
  return { ...row, hash: computeAuditHash(row) };
}

/**
 * 保存期間で先頭の行を消したあとの形（5.10 の5）：
 * rows のうち先頭 count 行を消し、消した範囲の最後の hash を持つ checkpoint 行を末尾に足す
 */
function pruned(rows: AuditRow[], count: number, checkpointTs?: string): AuditRow[] {
  const last = rows[count - 1] as AuditRow;
  const first = rows[0] as AuditRow;
  const ts = checkpointTs ?? new Date(Date.parse(last.ts) + 400 * DAY).toISOString();
  const cutoff = new Date(Date.parse(last.ts) + 1).toISOString();
  const kept = rows.slice(count);
  const cp = buildAuditRow(
    rows.at(-1) as AuditRow,
    checkpointEntry({
      ts,
      fromSeq: first.seq,
      toSeq: last.seq,
      lastHash: last.hash,
      lastTs: last.ts,
      cutoff,
    }),
  );
  return [...kept, cp];
}

describe("5.10 の2：行の hash", () => {
  it("最初の行の prev_hash は 0 を64個並べた文字列", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
    const [first] = chain(1);
    expect(first?.prevHash).toBe(GENESIS_HASH);
    expect(first?.seq).toBe(1);
  });

  it("hash は prev_hash と、行の内容（seq・ts・actor・kind・subject・data）の正規化JSONをつなげたものの SHA-256", () => {
    const [a, b] = chain(2) as [AuditRow, AuditRow];
    for (const row of [a, b]) {
      const content = canonicalJson({
        seq: row.seq,
        ts: row.ts,
        actor: row.actor,
        kind: row.kind,
        subject: row.subject,
        data: JSON.parse(row.data),
      });
      const expected = createHash("sha256")
        .update(row.prevHash + content, "utf8")
        .digest("hex");
      expect(row.hash).toBe(expected);
    }
    expect(b.prevHash).toBe(a.hash);
    expect(b.seq).toBe(2);
  });

  it("data は正規化JSONで保存する（キーを入れた順に関わらず同じ文字列・同じ hash）", () => {
    const x = buildAuditRow(null, entry(0, { data: { to: "starting", from: "queued" } }));
    const y = buildAuditRow(null, entry(0, { data: { from: "queued", to: "starting" } }));
    expect(x.data).toBe('{"from":"queued","to":"starting"}');
    expect(x.hash).toBe(y.hash);
  });

  it.each([
    ["ts", { ts: "2026-01-01T00:00:00.001Z" }],
    ["actor", { actor: "member:dev-implementer" }],
    ["kind", { kind: "box.lifecycle", data: { group: "dev", box_kind: "vm", event: "start" } }],
    ["subject", { subject: "t_01JD6V8X3S0Q5W7KQ9M2T4R6YC" }],
    ["data", { data: { from: "queued", to: "cancelled" } }],
  ] as const)("内容の %s が違えば hash も違う", (_field, over) => {
    const base = buildAuditRow(null, entry(0));
    const other = buildAuditRow(null, entry(0, over as Partial<AuditEntry>));
    expect(other.hash).not.toBe(base.hash);
  });

  it("前の行が違えば hash も違う（seq と prev_hash が内容に入る）", () => {
    const [a, b] = chain(2) as [AuditRow, AuditRow];
    const alone = buildAuditRow(null, entry(1));
    const afterA = buildAuditRow(a, entry(1));
    expect(afterA.hash).toBe(b.hash);
    expect(alone.hash).not.toBe(b.hash);
  });

  it("JSON にできない data は書かない（黙って変換しない）", () => {
    expect(() =>
      buildAuditRow(null, entry(0, { data: { from: "queued", to: Number.NaN } as never })),
    ).toThrow(TypeError);
  });

  it("前の行の hash の形が壊れていたら、つなげずに止める", () => {
    const bad = { seq: 1, hash: "xyz" };
    expect(() => buildAuditRow(bad, entry(1))).toThrow();
  });
});

describe("5.10 の4：つながりの確認（verifyAuditChain）", () => {
  it("正しくつながっていれば通り、最後の seq と hash を返す", () => {
    const rows = chain(5);
    expect(verifyAuditChain(rows)).toEqual({
      ok: true,
      count: 5,
      firstSeq: 1,
      lastSeq: 5,
      lastHash: rows[4]?.hash,
    });
  });

  it("行が1つもなければ通る", () => {
    expect(verifyAuditChain([])).toEqual({
      ok: true,
      count: 0,
      firstSeq: null,
      lastSeq: null,
      lastHash: GENESIS_HASH,
    });
  });

  describe("改ざんを見つける（最初に壊れていた seq と理由を返す）", () => {
    it("5.10 の4：途中の行の data を書き換えると、その行で失敗する", () => {
      const rows = tamper(chain(5), 2, { data: '{"from":"queued","to":"cancelled"}' });
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 3, reason: "hash_mismatch" });
    });

    it.each([
      ["ts", { ts: "2030-01-01T00:00:00.000Z" }],
      ["actor", { actor: "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB" }],
      ["kind", { kind: "approval" }],
      ["subject", { subject: "h_01JD6V8X3S0Q5W7KQ9M2T4R6YB" }],
    ])("5.10 の4：途中の行の %s を書き換えると、その行で失敗する", (_field, patch) => {
      const rows = tamper(chain(5), 3, patch);
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 4, reason: "hash_mismatch" });
    });

    it("data を同じ意味の別の書き方（空白・キーの順）にしても見つける", () => {
      const rows = tamper(chain(3), 1, { data: '{ "to": "starting", "from": "queued" }' });
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 2, reason: "data_invalid" });
    });

    it("data が JSON として読めなければ失敗する", () => {
      const rows = tamper(chain(3), 1, { data: "{not json" });
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 2, reason: "data_invalid" });
    });

    it("5.10 の4：途中の行を消すと、次の行で失敗する", () => {
      const rows = chain(5);
      rows.splice(2, 1);
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 4, reason: "seq_gap" });
    });

    it("途中の行を消して後ろの seq を詰めても（hash はそのまま）、見つける", () => {
      const rows = chain(5);
      rows.splice(2, 1);
      const renumbered = rows.map((r, i) => ({ ...r, seq: i + 1 }));
      expect(verifyAuditChain(renumbered)).toMatchObject({ ok: false, seq: 3 });
    });

    it("途中の行を消して、次の行の prev_hash と hash を作り直しても、その次の行で見つける", () => {
      const rows = chain(5);
      const [removed] = rows.splice(2, 1) as [AuditRow];
      const next = rows[2] as AuditRow;
      rows[2] = rehash({ ...next, seq: removed.seq, prevHash: removed.prevHash });
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 5 });
    });

    it("5.10 の5：先頭の行を checkpoint なしで消すと、残った最初の行で失敗する", () => {
      const rows = chain(5).slice(2);
      expect(verifyAuditChain(rows)).toMatchObject({
        ok: false,
        seq: 3,
        reason: "missing_checkpoint",
      });
    });

    it("先頭の行を消して、残った最初の行の prev_hash を 0 に書き換えても見つける", () => {
      const rows = chain(5).slice(2);
      rows[0] = rehash({ ...(rows[0] as AuditRow), prevHash: GENESIS_HASH });
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 3, reason: "bad_start" });
    });

    it("5.10 の4：行の順番を入れ替えると失敗する", () => {
      const rows = chain(5);
      [rows[1], rows[2]] = [rows[2] as AuditRow, rows[1] as AuditRow];
      // seq 1 の次に seq 3 が来た時点で、seq 2 がない（消された）のと見分けられないので seq_gap になる
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 3, reason: "seq_gap" });
    });

    it("同じ行を2回入れると（seq が戻ると）失敗する", () => {
      const rows = chain(3);
      rows.splice(2, 0, rows[1] as AuditRow);
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 2, reason: "seq_order" });
    });

    it("2つの行の中身を入れ替えて seq だけ元のままにしても失敗する", () => {
      const rows = chain(5);
      const a = rows[1] as AuditRow;
      const b = rows[2] as AuditRow;
      rows[1] = { ...b, seq: a.seq };
      rows[2] = { ...a, seq: b.seq };
      expect(verifyAuditChain(rows)).toMatchObject({
        ok: false,
        seq: 2,
        reason: "prev_hash_mismatch",
      });
    });

    it("5.10 の4：hash を書き換えると、その行で失敗する", () => {
      const rows = tamper(chain(5), 1, { hash: "f".repeat(64) });
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 2, reason: "hash_mismatch" });
    });

    it("hash と次の行の prev_hash をそろえて書き換えても、書き換えた行で失敗する", () => {
      const rows = tamper(tamper(chain(5), 1, { hash: "f".repeat(64) }), 2, {
        prevHash: "f".repeat(64),
      });
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 2, reason: "hash_mismatch" });
    });

    it("prev_hash を書き換えると、その行で失敗する", () => {
      const rows = tamper(chain(5), 3, { prevHash: "e".repeat(64) });
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, seq: 4 });
    });

    it.each([
      ["大文字の16進", "A".repeat(64)],
      ["短い", "a".repeat(63)],
      ["16進でない文字", "g".repeat(64)],
    ])("hash の形が壊れていたら失敗する（%s）", (_label, hash) => {
      const rows = tamper(chain(3), 2, { hash });
      expect(verifyAuditChain(rows)).toMatchObject({
        ok: false,
        seq: 3,
        reason: "bad_hash_format",
      });
    });

    it("seq が整数でなければ失敗する", () => {
      const rows = tamper(chain(3), 1, { seq: 1.5 });
      expect(verifyAuditChain(rows)).toMatchObject({ ok: false, reason: "bad_row" });
    });

    it("限界：末尾の行を消したことは、つながりだけでは分からない（lastSeq・lastHash を控えて比べる）", () => {
      const full = chain(5);
      const result = verifyAuditChain(full.slice(0, 4));
      expect(result).toMatchObject({ ok: true, lastSeq: 4 });
      if (result.ok) expect(result.lastHash).not.toBe(full[4]?.hash);
    });
  });

  describe("5.10 の5：checkpoint 行（保存期間で古い行を消したあと）", () => {
    it("先頭を消して、消した範囲の最後の hash を持つ checkpoint を足せば通る", () => {
      const rows = pruned(chain(10), 4);
      expect(rows[0]?.seq).toBe(5);
      expect(rows.at(-1)).toMatchObject({ seq: 11, kind: "checkpoint", actor: "system" });
      expect(verifyAuditChain(rows)).toMatchObject({
        ok: true,
        count: 7,
        firstSeq: 5,
        lastSeq: 11,
      });
    });

    it("checkpoint の data には、消した範囲・最後の hash と時刻・区切りの時刻・消した行数が入る", () => {
      const rows = pruned(chain(10), 4);
      const cp = rows.at(-1) as AuditRow;
      const source = chain(10)[3] as AuditRow;
      expect(JSON.parse(cp.data)).toEqual({
        from_seq: 1,
        to_seq: 4,
        last_hash: source.hash,
        last_ts: source.ts,
        cutoff: new Date(Date.parse(source.ts) + 1).toISOString(),
        deleted_rows: 4,
      });
    });

    it("2回消しても（前の checkpoint ごと消えても）通る", () => {
      const first = pruned(chain(10), 4); // seq 5..11（11 が checkpoint）
      const extended = [...first];
      for (let i = 11; i < 14; i++) {
        extended.push(buildAuditRow(extended.at(-1) as AuditRow, entry(i + 400)));
      }
      // seq 5..11 を消す（前の checkpoint の seq 11 も消える）
      const again = pruned(extended, 7);
      expect(again[0]?.seq).toBe(12);
      expect(verifyAuditChain(again)).toMatchObject({ ok: true, firstSeq: 12 });
    });

    it("2回目に消した範囲が前の checkpoint を残していても通る", () => {
      const first = pruned(chain(10), 4); // seq 5..10、11 が checkpoint
      const again = pruned(first, 3); // seq 5..7 を消す。11 の checkpoint は残る
      expect(again[0]?.seq).toBe(8);
      expect(verifyAuditChain(again)).toMatchObject({ ok: true, firstSeq: 8 });
    });

    it("すべての行を消して checkpoint だけが残っても通る", () => {
      const rows = chain(3);
      const last = rows[2] as AuditRow;
      const cp = buildAuditRow(
        last,
        checkpointEntry({
          ts: new Date(Date.parse(last.ts) + 400 * DAY).toISOString(),
          fromSeq: 1,
          toSeq: 3,
          lastHash: last.hash,
          lastTs: last.ts,
          cutoff: new Date(Date.parse(last.ts) + 1).toISOString(),
        }),
      );
      expect(verifyAuditChain([cp])).toMatchObject({ ok: true, count: 1, firstSeq: 4 });
    });

    describe("checkpoint の偽造を見つける", () => {
      it("last_hash が、残った最初の行の prev_hash と合わない", () => {
        const rows = chain(10);
        const forged = [
          ...rows.slice(4),
          buildAuditRow(
            rows.at(-1) as AuditRow,
            checkpointEntry({
              ts: "2027-06-01T00:00:00.000Z",
              fromSeq: 1,
              toSeq: 4,
              lastHash: "a".repeat(64),
              lastTs: rows[3]?.ts as string,
              cutoff: "2026-01-04T00:00:00.001Z",
            }),
          ),
        ];
        expect(verifyAuditChain(forged)).toMatchObject({
          ok: false,
          seq: 5,
          reason: "missing_checkpoint",
        });
      });

      it("to_seq が、残った最初の行の1つ前と合わない", () => {
        const rows = chain(10);
        const forged = [
          ...rows.slice(4),
          buildAuditRow(
            rows.at(-1) as AuditRow,
            checkpointEntry({
              ts: "2027-06-01T00:00:00.000Z",
              fromSeq: 1,
              toSeq: 3,
              lastHash: rows[3]?.hash as string,
              lastTs: rows[2]?.ts as string,
              cutoff: "2026-01-03T00:00:00.001Z",
            }),
          ),
        ];
        expect(verifyAuditChain(forged)).toMatchObject({
          ok: false,
          seq: 5,
          reason: "missing_checkpoint",
        });
      });

      it("checkpoint の data を書き換える（その行の hash で見つかる）", () => {
        const rows = pruned(chain(10), 4);
        const cp = rows.at(-1) as AuditRow;
        const data = { ...JSON.parse(cp.data), deleted_rows: 3, from_seq: 2 };
        const forged = tamper(rows, rows.length - 1, { data: canonicalJson(data) });
        expect(verifyAuditChain(forged)).toMatchObject({
          ok: false,
          seq: cp.seq,
          reason: "hash_mismatch",
        });
      });

      it("消していない行を「消した」とする checkpoint を足す", () => {
        const rows = chain(6);
        const forged = [
          ...rows,
          buildAuditRow(
            rows.at(-1) as AuditRow,
            checkpointEntry({
              ts: "2027-06-01T00:00:00.000Z",
              fromSeq: 1,
              toSeq: 3,
              lastHash: rows[2]?.hash as string,
              lastTs: rows[2]?.ts as string,
              cutoff: "2026-01-03T00:00:00.001Z",
            }),
          ),
        ];
        expect(verifyAuditChain(forged)).toMatchObject({
          ok: false,
          seq: 7,
          reason: "checkpoint_invalid",
        });
      });

      it(`保存期間の最小（${AUDIT_MIN_RETENTION_DAYS}日）より新しい行を消した checkpoint`, () => {
        const rows = chain(10);
        // 最後に消した行（seq 4）の時刻から、まだ5日しかたっていないのに消している
        const recent = new Date(Date.parse(rows[3]?.ts as string) + 5 * DAY).toISOString();
        const forged = pruned(rows, 4, recent);
        expect(verifyAuditChain(forged)).toMatchObject({
          ok: false,
          seq: 11,
          reason: "checkpoint_invalid",
        });
      });

      it("last_ts が cutoff より後（区切りより新しい行を消した）", () => {
        const rows = chain(10);
        const last = rows[3] as AuditRow;
        const forged = [
          ...rows.slice(4),
          buildAuditRow(
            rows.at(-1) as AuditRow,
            checkpointEntry({
              ts: "2027-06-01T00:00:00.000Z",
              fromSeq: 1,
              toSeq: 4,
              lastHash: last.hash,
              lastTs: last.ts,
              cutoff: "2026-01-02T00:00:00.000Z",
            }),
          ),
        ];
        expect(verifyAuditChain(forged)).toMatchObject({
          ok: false,
          seq: 11,
          reason: "checkpoint_invalid",
        });
      });

      it("消した行数が from_seq〜to_seq と合わない", () => {
        const rows = chain(10);
        const last = rows[3] as AuditRow;
        const cp = checkpointEntry({
          ts: "2027-06-01T00:00:00.000Z",
          fromSeq: 1,
          toSeq: 4,
          lastHash: last.hash,
          lastTs: last.ts,
          cutoff: "2026-01-04T00:00:00.001Z",
        });
        const forged = [
          ...rows.slice(4),
          buildAuditRow(rows.at(-1) as AuditRow, {
            ...cp,
            data: { ...cp.data, deleted_rows: 2 },
          }),
        ];
        expect(verifyAuditChain(forged)).toMatchObject({
          ok: false,
          seq: 11,
          reason: "checkpoint_invalid",
        });
      });

      it("checkpoint を書いたのが system でない", () => {
        const rows = chain(10);
        const last = rows[3] as AuditRow;
        const cp = checkpointEntry({
          ts: "2027-06-01T00:00:00.000Z",
          fromSeq: 1,
          toSeq: 4,
          lastHash: last.hash,
          lastTs: last.ts,
          cutoff: "2026-01-04T00:00:00.001Z",
        });
        const forged = [
          ...rows.slice(4),
          buildAuditRow(rows.at(-1) as AuditRow, { ...cp, actor: "member:dev-implementer" }),
        ];
        expect(verifyAuditChain(forged)).toMatchObject({
          ok: false,
          seq: 11,
          reason: "checkpoint_invalid",
        });
      });

      it.each([
        ["キーが足りない", { from_seq: 1, to_seq: 4 }],
        [
          "知らないキーがある",
          {
            from_seq: 1,
            to_seq: 4,
            last_hash: "a".repeat(64),
            last_ts: "2026-01-04T00:00:00.000Z",
            cutoff: "2026-01-04T00:00:00.001Z",
            deleted_rows: 4,
            note: "x",
          },
        ],
        [
          "seq が文字列",
          {
            from_seq: "1",
            to_seq: 4,
            last_hash: "a".repeat(64),
            last_ts: "2026-01-04T00:00:00.000Z",
            cutoff: "2026-01-04T00:00:00.001Z",
            deleted_rows: 4,
          },
        ],
        [
          "時刻が読めない",
          {
            from_seq: 1,
            to_seq: 4,
            last_hash: "a".repeat(64),
            last_ts: "yesterday",
            cutoff: "2026-01-04T00:00:00.001Z",
            deleted_rows: 4,
          },
        ],
        ["配列", [1, 2, 3]],
      ])("形が壊れた checkpoint（%s）", (_label, data) => {
        const rows = chain(3);
        const forged = [
          ...rows,
          buildAuditRow(rows.at(-1) as AuditRow, {
            ts: "2027-06-01T00:00:00.000Z",
            actor: "system",
            kind: "checkpoint",
            subject: "audit_log",
            data: data as never,
          }),
        ];
        expect(verifyAuditChain(forged)).toMatchObject({
          ok: false,
          seq: 4,
          reason: "checkpoint_invalid",
        });
      });
    });
  });
});
