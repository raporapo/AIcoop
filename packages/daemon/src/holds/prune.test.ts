import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId } from "@aicoop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getHold, type Hold, transitionHold } from "../db/holds.ts";
import { createHoldTestEnv, type HoldTestEnv } from "../testing/holds.ts";
import { HOLD_FILE_RETENTION_DAYS, pruneResolvedHoldFiles } from "./prune.ts";

const DAY = 24 * 3600_000;
let t: HoldTestEnv;
beforeEach(() => {
  t = createHoldTestEnv();
});
afterEach(() => t.cleanup());

/** 保留を、再送の結果のファイルつきで、結果の状態まで進める */
function resolved(to: "replayed" | "replay_failed" | "rejected" | "expired"): Hold {
  const hold = t.hold({ status: "pending_owner" });
  if (to === "rejected" || to === "expired") {
    return transitionHold(t.db, hold.id, {
      from: ["pending_owner"],
      to,
      by: "system",
      actor: "system",
      decide: true,
    });
  }
  transitionHold(t.db, hold.id, {
    from: ["pending_owner"],
    to: "approved",
    by: "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
    actor: "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
    decide: true,
  });
  writeFileSync(t.paths.holdResponseFile(hold.id), '{"id":"sent"}', { mode: 0o600 });
  return transitionHold(t.db, hold.id, {
    from: ["approved"],
    to,
    by: "system",
    actor: "system",
    responseStatus: to === "replayed" ? 200 : 500,
    responsePath: t.paths.holdResponseFile(hold.id),
  });
}

const files = (hold: Pick<Hold, "id">) => ({
  request: existsSync(t.paths.holdFile(hold.id)),
  response: existsSync(t.paths.holdResponseFile(hold.id)),
});

describe("片付け：決まった保留の state/holds/<id>.bin と再送の結果のファイルを、決まってから30日で消す（state.db の行は残す）", () => {
  it("保存の日数は30日", () => {
    expect(HOLD_FILE_RETENTION_DAYS).toBe(30);
  });

  it("replayed・replay_failed・rejected・expired の保留は、決まってから30日を過ぎたらファイルを消す。行（状態・要約・応答のステータス）は残る", () => {
    const holds = [
      resolved("replayed"),
      resolved("replay_failed"),
      resolved("rejected"),
      resolved("expired"),
    ];
    t.clock.advance(30 * DAY - 1);
    expect(pruneResolvedHoldFiles(t.deps).holds).toEqual([]);
    for (const h of holds) expect(files(h).request).toBe(true);

    t.clock.advance(1);
    const result = pruneResolvedHoldFiles(t.deps);
    expect([...result.holds].sort()).toEqual(holds.map((h) => h.id).sort());
    for (const h of holds) {
      expect(files(h)).toEqual({ request: false, response: false });
      const row = getHold(t.db, h.id);
      expect(row).toMatchObject({ status: h.status, summary: h.summary });
    }
    expect(getHold(t.db, holds[0]?.id ?? "")?.responseStatus).toBe(200);
    // 2回目は何もしない
    expect(pruneResolvedHoldFiles(t.deps).holds).toEqual([]);
  });

  it("拒否される側：まだ決まっていない保留（pending_manager・pending_owner）と、承認されて送る前・送っている途中（approved）の保留は、どれだけ古くても消さない", () => {
    const manager = t.hold({ status: "pending_manager" });
    const owner = t.hold({ status: "pending_owner" });
    const approved = t.hold({ status: "pending_owner" });
    transitionHold(t.db, approved.id, {
      from: ["pending_owner"],
      to: "approved",
      by: "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
      actor: "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
      decide: true,
    });
    t.clock.advance(400 * DAY);
    expect(pruneResolvedHoldFiles(t.deps).holds).toEqual([]);
    for (const h of [manager, owner, approved]) expect(files(h).request).toBe(true);
  });

  it("消す期限は「作った時刻」ではなく「決まった時刻」から数える", () => {
    const hold = t.hold({ status: "pending_owner" });
    t.clock.advance(60 * DAY);
    transitionHold(t.db, hold.id, {
      from: ["pending_owner"],
      to: "rejected",
      by: "system",
      actor: "system",
      decide: true,
    });
    t.clock.advance(29 * DAY);
    expect(pruneResolvedHoldFiles(t.deps).holds).toEqual([]);
    expect(files(hold).request).toBe(true);
    t.clock.advance(DAY);
    expect(pruneResolvedHoldFiles(t.deps).holds).toEqual([hold.id]);
  });

  it("行のない保留のファイル（保存したあとに落ちたもの）は、ファイルの時刻から30日で消す。保留の形でない名前のファイルは触らない", () => {
    mkdirSync(t.paths.holdsDir, { recursive: true });
    const orphan = newId("hold", t.clock.now().getTime());
    const fresh = newId("hold", t.clock.now().getTime());
    const old = new Date(t.clock.now().getTime() - 31 * DAY);
    for (const [id, at] of [
      [orphan, old],
      [fresh, t.clock.now()],
    ] as const) {
      writeFileSync(t.paths.holdFile(id), "x");
      writeFileSync(t.paths.holdResponseFile(id), "y");
      utimesSync(t.paths.holdFile(id), at, at);
      utimesSync(t.paths.holdResponseFile(id), at, at);
    }
    const other = join(t.paths.holdsDir, "notes.txt");
    writeFileSync(other, "keep");
    utimesSync(other, old, old);

    const result = pruneResolvedHoldFiles(t.deps);
    expect(result.orphans).toEqual([orphan]);
    expect(files({ id: orphan })).toEqual({ request: false, response: false });
    expect(files({ id: fresh })).toEqual({ request: true, response: true });
    expect(existsSync(other)).toBe(true);
  });

  it("拒否される側：state/holds の中のリンクは、たどった先を消さない（リンクだけを消す）", () => {
    const hold = resolved("rejected");
    const outside = join(t.tmp.path, "outside.txt");
    writeFileSync(outside, "do not delete");
    // リンクを作れない環境（Windows の権限）では確かめない
    const link = t.paths.holdResponseFile(hold.id);
    try {
      symlinkSync(outside, link);
    } catch {
      return;
    }
    t.clock.advance(30 * DAY);
    pruneResolvedHoldFiles(t.deps);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(link)).toBe(false);
  });

  it("state/holds がなくても失敗しない", () => {
    expect(pruneResolvedHoldFiles(t.deps)).toEqual({ holds: [], orphans: [] });
  });
});
