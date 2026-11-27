import { join } from "node:path";
import { appendAudit, openStateDb } from "@aicoop/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestCli, type TestCli } from "../testing/harness.ts";

let cli: TestCli;
beforeEach(async () => {
  cli = createTestCli();
  await cli.run(["init"]);
});
afterEach(() => cli.cleanup());

function withDb<T>(fn: (db: ReturnType<typeof openStateDb>) => T): T {
  const db = openStateDb(join(cli.home, "state.db"), {
    now: () => new Date("2026-11-27T23:30:00.000Z"),
  });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function writeRows(n: number) {
  withDb((db) => {
    for (let i = 0; i < n; i++) {
      appendAudit(db, {
        actor: "system",
        kind: "task.state",
        subject: `t_${i}`,
        data: { from: null, to: "queued" },
      });
    }
  });
}

describe("P1 完了条件5・5.10 の4：aicoop audit verify", () => {
  it("つながっていれば、件数と最後の時刻（timezone）と hash を出す（終了コード 0）", async () => {
    writeRows(3);
    const r = await cli.run(["audit", "verify"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("3件");
    // 23:30Z は Asia/Tokyo（雛形の timezone）で翌日の 08:30
    expect(r.stdout).toContain("2026-11-28 08:30:00");
    expect(r.stdout).toMatch(/[0-9a-f]{64}/);
  });

  it("壊れていれば、最初に壊れた seq と理由を出す（終了コード 1）", async () => {
    writeRows(3);
    withDb((db) => {
      // state.db のファイルを直接書き換えられたことにする（追記だけにする仕掛けを外して）
      db.sqlite.exec("DROP TRIGGER IF EXISTS audit_log_no_update");
      db.sqlite
        .prepare("UPDATE audit_log SET data = ? WHERE seq = 2")
        .run('{"from":null,"to":"done"}');
    });
    const r = await cli.run(["audit", "verify"]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("seq 2");
    expect(r.stdout + r.stderr).toContain("hash_mismatch");
  });

  it("--json", async () => {
    writeRows(2);
    const ok = JSON.parse((await cli.run(["audit", "verify", "--json"])).stdout);
    expect(ok).toMatchObject({ ok: true, count: 2, first_seq: 1, last_seq: 2 });
    withDb((db) => db.sqlite.prepare("DELETE FROM audit_log WHERE seq = 1").run());
    const broken = await cli.run(["audit", "verify", "--json"]);
    expect(broken.code).toBe(1);
    expect(JSON.parse(broken.stdout)).toMatchObject({ ok: false, seq: 2 });
  });

  it("1行もなければ、そのことを言って通す", async () => {
    withDb(() => undefined);
    const r = await cli.run(["audit", "verify"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("まだ1件もありません");
  });

  it("state.db がなければ、確かめられないので 1（作りもしない）", async () => {
    const r = await cli.run(["audit", "verify"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("state.db");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(cli.home, "state.db"))).toBe(false);
  });

  it("daemon が動いていなくても使える（API を呼ばない）", async () => {
    writeRows(1);
    const r = await cli.run(["audit", "verify"]);
    expect(r.code).toBe(0);
  });
});
