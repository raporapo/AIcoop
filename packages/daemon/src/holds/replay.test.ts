import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimHoldReplay, getHold, type Hold, transitionHold } from "../db/holds.ts";
import { listTasks } from "../db/tasks.ts";
import { P2_FILES } from "../testing/company-config.ts";
import { createHoldTestEnv, type HoldTestEnv } from "../testing/holds.ts";
import { MAX_RESPONSE_BYTES, recoverReplays, replayHold } from "./replay.ts";

const OWNER = "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB" as const;

let t: HoldTestEnv;
beforeEach(() => {
  t = createHoldTestEnv();
});
afterEach(() => t.cleanup());

function approved(over: Parameters<HoldTestEnv["hold"]>[0] = {}): Hold {
  const hold = t.hold({ status: "pending_owner", ...over });
  return transitionHold(t.db, hold.id, {
    from: ["pending_owner"],
    to: "approved",
    by: OWNER,
    actor: OWNER,
    decide: true,
  });
}

describe("5.2.6 の2・3：再送", () => {
  it("保存したリクエストに、その場で発行した本物の資格を付けて1回だけ送り、結果を残す", async () => {
    const hold = approved();
    const after = await replayHold(t.deps, hold.id);
    expect(after).toMatchObject({ status: "replayed", responseStatus: 200 });

    const sent = t.services.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      body: '{"raw":"VG86IGFAZXhhbXBsZS5jb20NCg0KaGk"}',
    });
    // 実行のときのトークンではなく、いま発行したもの（資格保管庫のリフレッシュトークンから）
    expect(t.services.issued).toHaveLength(1);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${t.services.issued[0]}`);
    expect(sent[0]?.headers["content-type"]).toBe("application/json");

    const file = t.paths.holdResponseFile(hold.id);
    expect(readFileSync(file, "utf8")).toBe(t.services.sendBody);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(after?.responsePath).toBe(file);
    expect(after?.resolvedAt).toBe("2026-11-28T00:00:00.000Z");
  });

  it("資格のヘッダーは、送ったときの形（auth.template）で付け直す", async () => {
    const hold = approved({
      request: { auth: { header: "authorization", template: "OAuth GONDOLIN_SECRET_****" } },
    });
    await replayHold(t.deps, hold.id);
    expect(t.services.sent()[0]?.headers.authorization).toBe(`OAuth ${t.services.issued[0]}`);
  });

  it("2xx・3xx は replayed、それ以外は replay_failed（自動の再試行はしない）", async () => {
    t.services.sendStatus = 302;
    expect((await replayHold(t.deps, approved().id))?.status).toBe("replayed");
    t.services.sendStatus = 400;
    const failed = await replayHold(t.deps, approved().id);
    expect(failed).toMatchObject({ status: "replay_failed", responseStatus: 400 });
    expect(t.services.sent()).toHaveLength(2);
  });

  it("本文は先頭 1 MiB だけ残す", async () => {
    t.services.sendBody = "x".repeat(MAX_RESPONSE_BYTES + 100);
    const after = await replayHold(t.deps, approved().id);
    expect(readFileSync(after?.responsePath as string).byteLength).toBe(MAX_RESPONSE_BYTES);
  });

  it("結果が出たら、on_hold_resolved のタスク（保留を出したときのスレッド、hold_id）を作る", async () => {
    t.reload({
      ...P2_FILES,
      triggers: [{ id: "r", type: "on_hold_resolved", member: "sales-mailer" }],
    });
    const hold = approved();
    await replayHold(t.deps, hold.id);
    const tasks = listTasks(t.db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      triggerKind: "on_hold_resolved",
      memberId: "sales-mailer",
      thread: "mail-thread",
      holdId: hold.id,
    });
    expect(t.kicks).toBe(1);
  });

  it("enabled: false のトリガー・ほかの社員のトリガーではタスクを作らない", async () => {
    t.reload({
      ...P2_FILES,
      triggers: [
        { id: "off", type: "on_hold_resolved", member: "sales-mailer", enabled: false },
        { id: "other", type: "on_hold_resolved", member: "dev-implementer" },
      ],
    });
    await replayHold(t.deps, approved().id);
    expect(listTasks(t.db)).toEqual([]);
  });

  describe("拒否：二重に送らない・送ってはいけないものは送らない", () => {
    it("同時に2回呼んでも、送るのは1回だけ", async () => {
      const hold = approved();
      await Promise.all([replayHold(t.deps, hold.id), replayHold(t.deps, hold.id)]);
      expect(t.services.sent()).toHaveLength(1);
      expect(getHold(t.db, hold.id)?.status).toBe("replayed");
    });

    it("承認されていない（却下・部長のレビュー中・オーナーの承認待ち・期限切れ）保留は送らない", async () => {
      for (const status of ["rejected", "pending_manager", "pending_owner", "expired"] as const) {
        const hold = t.hold({
          status: status === "rejected" || status === "expired" ? "pending_owner" : status,
        });
        if (status === "rejected" || status === "expired") {
          transitionHold(t.db, hold.id, {
            from: ["pending_owner"],
            to: status,
            by: "system",
            actor: "system",
          });
        }
        await replayHold(t.deps, hold.id);
        expect(getHold(t.db, hold.id)?.status).toBe(status);
      }
      expect(t.services.calls).toEqual([]);
    });

    it("送った（replayed・replay_failed）保留は、もう一度は送らない", async () => {
      const hold = approved();
      await replayHold(t.deps, hold.id);
      await replayHold(t.deps, hold.id);
      expect(t.services.sent()).toHaveLength(1);
    });

    it("いまの設定で、その社員がその操作を使えなくなっていたら、送らずに replay_failed", async () => {
      const hold = approved();
      t.reload({
        ...P2_FILES,
        groups: {
          ...P2_FILES.groups,
          sales: { name: "営業部", box: "vm", ceiling: [{ op: "gmail.message.read" }] },
        },
      });
      const after = await replayHold(t.deps, hold.id);
      expect(after).toMatchObject({
        status: "replay_failed",
        responseStatus: null,
        responsePath: null,
      });
      expect(t.services.calls).toEqual([]);
    });

    it("保存した URL が保留の操作と食い違う・資格を使うサービスへ http・既定でないポートなら送らない", async () => {
      for (const url of [
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts",
        "http://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        "https://gmail.googleapis.com:8443/gmail/v1/users/me/messages/send",
        "https://evil.example.com/gmail/v1/users/me/messages/send",
      ]) {
        const after = await replayHold(t.deps, approved({ request: { url } }).id);
        expect(after?.status, url).toBe("replay_failed");
      }
      expect(t.services.calls).toEqual([]);
    });

    it("資格を発行できなければ送らない（replay_failed）", async () => {
      t.services.offline = true;
      const after = await replayHold(t.deps, approved().id);
      expect(after).toMatchObject({ status: "replay_failed", responseStatus: null });
      expect(t.services.sent()).toHaveLength(0);
    });

    it("通信が途中で失敗したら replay_failed（届いたか分からないので、やり直さない）", async () => {
      const real = t.services.fetch;
      let n = 0;
      const deps = {
        ...t.deps,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
          n += 1;
          if (String(input).endsWith("/messages/send")) throw new TypeError("socket hang up");
          return real(input, init);
        }) as typeof fetch,
      };
      const hold = approved();
      expect((await replayHold(deps, hold.id))?.status).toBe("replay_failed");
      await replayHold(deps, hold.id);
      expect(n).toBe(2); // 資格の発行と、送信の1回だけ
    });
  });
});

describe("5.2.6 の2：daemon が途中で落ちても二度送らない（起動のときの後始末）", () => {
  it("送り始めた印のある approved は、送り直さずに replay_failed にする", async () => {
    const hold = approved();
    expect(claimHoldReplay(t.db, hold.id, t.paths.holdResponseFile(hold.id))).toBe(true);
    await recoverReplays(t.deps);
    expect(getHold(t.db, hold.id)).toMatchObject({ status: "replay_failed", responseStatus: null });
    expect(t.services.calls).toEqual([]);
    expect(existsSync(t.paths.holdResponseFile(hold.id))).toBe(false);
  });

  it("承認されたのに送り始めていない approved は、期限の内なら送る。過ぎていたら送らない", async () => {
    const inTime = approved();
    const late = approved({ expiresAt: "2026-11-28T00:00:00.500Z" });
    t.clock.advance(1000);
    await recoverReplays(t.deps);
    expect(getHold(t.db, inTime.id)?.status).toBe("replayed");
    expect(getHold(t.db, late.id)?.status).toBe("replay_failed");
    expect(t.services.sent()).toHaveLength(1);
  });
});
