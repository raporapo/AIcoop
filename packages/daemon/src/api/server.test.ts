import { networkInterfaces } from "node:os";
import { TASK_STATUSES } from "@aicoop/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openStateDb } from "../db/open.ts";
import { createTask } from "../db/tasks.ts";
import { setUsageState } from "../db/usage.ts";
import { aicoopPaths } from "../paths.ts";
import { enableTemplateCron, withLaterPhaseMembers } from "../testing/company.ts";
import { startTestDaemon, type TestDaemon } from "../testing/daemon.ts";
import { fakeStartRun, flushMicrotasks } from "../testing/fake-start-run.ts";
import { apiRequest } from "../testing/http.ts";

let t: TestDaemon;
const fake = fakeStartRun();

beforeAll(async () => {
  t = await startTestDaemon({ fake });
});
afterAll(async () => {
  await t.cleanup();
});

const port = () => t.daemon.port;
const newTask = (body: Record<string, unknown>) => t.api({ method: "POST", path: "/tasks", body });
const validTask = { member: "dev-implementer", purpose: "実装する", done_when: "PR を出した" };

/** いま動いているものを終わらせ、次の見直しまで待つ（ほかのテストに持ち越さない） */
async function finishAll() {
  for (;;) {
    const running = fake.running();
    if (running.length === 0) break;
    for (const id of running) await fake.finish(id);
  }
  await flushMicrotasks();
}

describe("9.2：認証（Bearer トークン）", () => {
  it("正しいトークンなら通る", async () => {
    expect((await t.api({ path: "/status" })).status).toBe(200);
  });

  it("拒否：トークンがない・違う・形が違うと 401 unauthorized（どのパスでも、ない道でも）", async () => {
    const bad: Array<Record<string, string> | null> = [
      null,
      { authorization: `Bearer ${t.daemon.token}x` },
      { authorization: `Bearer ${t.daemon.token.slice(0, -1)}` },
      { authorization: "Bearer " },
      { authorization: `Basic ${t.daemon.token}` },
      { authorization: t.daemon.token },
      { authorization: `Bearer  ${t.daemon.token}` },
      { authorization: `Bearer ${"a".repeat(5000)}` },
    ];
    for (const path of ["/status", "/tasks", "/no-such-path"]) {
      for (const headers of bad) {
        const res = await apiRequest(port(), { path, token: null, ...(headers && { headers }) });
        expect(res.status, `${path} ${JSON.stringify(headers)}`).toBe(401);
        expect(res.json).toMatchObject({ error: "unauthorized" });
        expect(res.json.message).toMatch(/トークン/);
      }
    }
    const post = await apiRequest(port(), { method: "POST", path: "/shutdown", token: null });
    expect(post.status).toBe(401);
    // 止まっていない
    expect((await t.api({ path: "/status" })).status).toBe(200);
  });

  it("拒否の応答に、正しいトークンを出さない", async () => {
    const res = await apiRequest(port(), { path: "/status", token: "wrong" });
    expect(res.text).not.toContain(t.daemon.token);
  });
});

describe("9.2・4.3 の2：DNS リバインディング対策と、待ち受けるアドレス", () => {
  it("Host が 127.0.0.1:<port>・localhost:<port> なら通る", async () => {
    for (const host of [`127.0.0.1:${port()}`, `localhost:${port()}`, `LOCALHOST:${port()}`]) {
      expect((await t.api({ path: "/status", host })).status, host).toBe(200);
    }
  });

  it("拒否：Host がそれ以外なら、トークンが正しくても 403 forbidden_host", async () => {
    for (const host of [
      `evil.example:${port()}`,
      "evil.example",
      "127.0.0.1",
      "localhost",
      `127.0.0.1:${port() + 1}`,
      `127.0.0.2:${port()}`,
      `[::1]:${port()}`,
      `0.0.0.0:${port()}`,
      `localhost.evil.example:${port()}`,
      `127.0.0.1:${port()}.evil.example`,
      `127.0.0.1:0${port()}`,
    ]) {
      const res = await t.api({ path: "/status", host });
      // Node の HTTP の読み取りが先に 400 で断るもの（Host の形が壊れている）もある
      if (res.status === 400) continue;
      expect(res.status, host).toBe(403);
      expect(res.json, host).toMatchObject({ error: "forbidden_host" });
    }
  });

  it("拒否：Host がなければ通らない", async () => {
    const res = await t.api({ path: "/status", host: null });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("4.3 の2：127.0.0.1 だけで待ち受ける（::1・ほかのアドレスからはつながらない）", async () => {
    const candidates = ["::1"];
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) {
        if (!a.internal && a.family === "IPv4") candidates.push(a.address);
      }
    }
    for (const address of candidates) {
      await expect(
        t.api({ path: "/status", address, host: `127.0.0.1:${port()}` }),
        address,
      ).rejects.toThrow();
    }
  });
});

describe("9.2：POST /tasks（手動のタスク）", () => {
  it("201 で queued のタスク（trigger_kind manual・優先度0）を返し、順番が来れば始まる", async () => {
    const res = await newTask({
      ...validTask,
      context: "背景",
      thread: "issue-12",
      timeout_minutes: 30,
    });
    expect(res.status).toBe(201);
    expect(res.json.task).toMatchObject({
      member_id: "dev-implementer",
      group_id: "dev",
      trigger_kind: "manual",
      trigger_id: null,
      priority: 0,
      thread: "issue-12",
      status: "queued",
      purpose: "実装する",
      context: "背景",
      context_untrusted: false,
      done_when: "PR を出した",
      timeout_minutes: 30,
    });
    await flushMicrotasks();
    expect(fake.running()).toContain(res.json.task.id);
    await finishAll();
  });

  it("timeout_minutes・thread・context を書かなければ、既定（task.timeout_minutes、task-<id>、空）", async () => {
    const res = await newTask(validTask);
    expect(res.json.task).toMatchObject({ timeout_minutes: 45, context: "" });
    expect(res.json.task.thread).toBe(`task-${res.json.task.id}`);
    await finishAll();
  });

  it("監査ログの task.state（null → queued）は、CLI の操作として owner:cli で書く", async () => {
    const res = await newTask(validTask);
    const audit = (await t.api({ path: "/audit?limit=1000" })).json.entries as Array<{
      actor: string;
      kind: string;
      subject: string;
      data: { from: string | null };
    }>;
    const created = audit.find((e) => e.subject === res.json.task.id && e.data.from === null);
    expect(created).toMatchObject({ actor: "owner:cli", kind: "task.state" });
    await finishAll();
  });

  it("拒否：知らない社員・人間の社員・CEO・動かせない箱の社員は 422 unknown_member（日本語の理由）", async () => {
    for (const member of ["nobody", "constructor", "sales-mailer"]) {
      const res = await newTask({ ...validTask, member });
      expect(res.status, member).toBe(422);
      expect(res.json, member).toMatchObject({ error: "unknown_member" });
      expect(res.json.message).toContain(member);
    }
  });

  it("拒否：入力の誤りは 400 invalid_input（日本語の理由）。タスクは作らない", async () => {
    const before = (await t.api({ path: "/tasks?limit=500" })).json.tasks.length;
    const cases: Array<[string, unknown]> = [
      ["purpose がない", { member: "dev-implementer", done_when: "d" }],
      ["done_when が空白だけ", { ...validTask, done_when: "  \n" }],
      ["member がない", { purpose: "p", done_when: "d" }],
      ["member が文字列でない", { ...validTask, member: 1 }],
      ["member が社員IDの形でない", { ...validTask, member: "../dev" }],
      ["知らないキー", { ...validTask, prioirty: 0 }],
      ["timeout_minutes が 55 を超える", { ...validTask, timeout_minutes: 56 }],
      ["timeout_minutes が 0", { ...validTask, timeout_minutes: 0 }],
      ["timeout_minutes が整数でない", { ...validTask, timeout_minutes: 1.5 }],
      ["timeout_minutes が文字列", { ...validTask, timeout_minutes: "30" }],
      ["thread に改行", { ...validTask, thread: "a\nb" }],
      ["thread が長すぎる", { ...validTask, thread: "a".repeat(201) }],
      ["purpose に NUL", { ...validTask, purpose: "a\u0000b" }],
      ["purpose が長すぎる", { ...validTask, purpose: "あ".repeat(2001) }],
      ["context が文字列でない", { ...validTask, context: ["x"] }],
      ["配列", [validTask]],
      ["null", null],
    ];
    for (const [name, body] of cases) {
      const res = await newTask(body as Record<string, unknown>);
      expect(res.status, name).toBe(400);
      expect(res.json.error, name).toBe("invalid_input");
      expect(res.json.message, name).toMatch(/[ぁ-んァ-ン]/);
    }
    const broken = await t.api({
      method: "POST",
      path: "/tasks",
      rawBody: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(broken.status).toBe(400);
    expect(broken.json.error).toBe("invalid_input");
    const notJson = await t.api({
      method: "POST",
      path: "/tasks",
      rawBody: JSON.stringify(validTask),
      headers: { "content-type": "text/plain" },
    });
    expect(notJson.status).toBe(415);
    expect(notJson.json.error).toBe("invalid_input");
    expect((await t.api({ path: "/tasks?limit=500" })).json.tasks.length).toBe(before);
  });

  it("拒否：本文が 64 KiB を超えると 413 invalid_input", async () => {
    const res = await newTask({ ...validTask, context: "x".repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect(res.json.error).toBe("invalid_input");
  });
});

describe("9.2：GET /tasks・GET /tasks/{id}", () => {
  it("GET /tasks は新しい順。status（カンマ区切り）と limit で絞る", async () => {
    const a = (await newTask(validTask)).json.task.id;
    const b = (await newTask({ ...validTask, member: "dev-reviewer" })).json.task.id;
    const list = (await t.api({ path: "/tasks?limit=2" })).json.tasks as Array<{ id: string }>;
    expect(list.map((x) => x.id)).toEqual([b, a]);
    const queued = (await t.api({ path: "/tasks?status=queued,running" })).json.tasks as Array<{
      status: string;
    }>;
    expect(queued.every((x) => ["queued", "running"].includes(x.status))).toBe(true);
    await finishAll();
    const done = (await t.api({ path: "/tasks?status=done" })).json.tasks as Array<{ id: string }>;
    expect(done.map((x) => x.id)).toEqual(expect.arrayContaining([a, b]));
  });

  it("拒否：知らない状態・範囲外の limit は 400 invalid_input", async () => {
    for (const q of [
      "status=nope",
      "status=queued,nope",
      "limit=0",
      "limit=501",
      "limit=abc",
      "limit=1.5",
    ]) {
      const res = await t.api({ path: `/tasks?${q}` });
      expect(res.status, q).toBe(400);
      expect(res.json.error, q).toBe("invalid_input");
    }
  });

  it("GET /tasks/{id} はタスクと実行の記録を返す。ない・ID の形でなければ 404 not_found", async () => {
    const id = (await newTask(validTask)).json.task.id;
    await finishAll();
    const res = await t.api({ path: `/tasks/${id}` });
    expect(res.status).toBe(200);
    expect(res.json.task).toMatchObject({ id, status: "done", result_summary: "できました" });
    expect(res.json.runs).toEqual([]);
    for (const missing of [
      "t_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "nope",
      "..%2f..%2fstate.db",
      "r_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ]) {
      const r = await t.api({ path: `/tasks/${missing}` });
      expect(r.status, missing).toBe(404);
      expect(r.json.error).toBe("not_found");
    }
  });
});

describe("9.2：POST /tasks/{id}/cancel", () => {
  it('動いているタスクは RunHandle.cancel("cancelled") で止め、was_active: true', async () => {
    const id = (await newTask(validTask)).json.task.id;
    await flushMicrotasks();
    expect(fake.running()).toContain(id);
    const res = await t.api({ method: "POST", path: `/tasks/${id}/cancel` });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ was_active: true, task: { id, status: "cancelled" } });
    expect(fake.runs.find((r) => r.taskId === id)?.cancelledWith).toBe("cancelled");
    await finishAll();
  });

  it("順番待ちのタスクは cancelled にし、was_active: false", async () => {
    const first = (await newTask(validTask)).json.task.id;
    const second = (await newTask(validTask)).json.task.id;
    await flushMicrotasks();
    expect(fake.running()).toEqual([first]);
    const res = await t.api({ method: "POST", path: `/tasks/${second}/cancel` });
    expect(res.json).toMatchObject({
      was_active: false,
      task: { id: second, status: "cancelled" },
    });
    await finishAll();
    expect(fake.runs.map((r) => r.taskId)).not.toContain(second);
  });

  it("拒否：終わったタスクは 409 invalid_state、ないタスクは 404 not_found", async () => {
    const id = (await newTask(validTask)).json.task.id;
    await finishAll();
    const done = await t.api({ method: "POST", path: `/tasks/${id}/cancel` });
    expect(done.status).toBe(409);
    expect(done.json.error).toBe("invalid_state");
    const missing = await t.api({
      method: "POST",
      path: "/tasks/t_01ARZ3NDEKTSV4RRFFQ69G5FAV/cancel",
    });
    expect(missing.status).toBe(404);
  });
});

describe("9.2：GET /status・/usage・/holds・/audit", () => {
  it("GET /status：会社・daemon・箱・状態ごとの件数（0 も）・利用枠・保留・トリガー・警告", async () => {
    const id = (await newTask(validTask)).json.task.id;
    await flushMicrotasks();
    const res = await t.api({ path: "/status" });
    expect(res.status).toBe(200);
    const s = res.json;
    expect(s.company).toEqual({ id: t.company.companyId, name: "テスト商会" });
    expect(s.daemon).toMatchObject({ pid: process.pid, port: port(), home: t.company.home });
    expect(s.daemon.config_loaded_at).toMatch(/Z$/);
    expect(s.boxes.max_concurrent).toBe(3);
    expect(s.boxes.running).toEqual([
      expect.objectContaining({
        group_id: "dev",
        member_id: "dev-implementer",
        task_id: id,
        box_kind: "vm",
        run_id: null,
      }),
    ]);
    expect(Object.keys(s.tasks).sort()).toEqual([...TASK_STATUSES].sort());
    expect(s.tasks.running).toBe(1);
    expect(s.usage).toBeNull();
    expect(s.holds).toEqual({ pending: 0 });
    expect(s.triggers).toEqual([
      expect.objectContaining({
        id: "sales-morning-news",
        type: "cron",
        enabled: false,
        next_run_at: null,
      }),
    ]);
    expect(s.warnings).toEqual([]);
    await finishAll();
  });

  it("GET /usage：記録がなければ null、あれば利用枠", async () => {
    expect((await t.api({ path: "/usage" })).json).toEqual({ usage: null });
    const db = openStateDb(aicoopPaths(t.company.home).stateDb);
    setUsageState(db, { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.8 });
    db.close();
    const res = await t.api({ path: "/usage" });
    expect(res.json.usage).toMatchObject({
      status: "allowed_warning",
      resets_at: null,
      rate_limit_type: "five_hour",
      utilization: 0.8,
    });
    const db2 = openStateDb(aicoopPaths(t.company.home).stateDb);
    setUsageState(db2, { status: "allowed" });
    db2.close();
  });

  it("GET /holds：保留の一覧（P1 では空）", async () => {
    expect((await t.api({ path: "/holds" })).json).toEqual({ holds: [] });
  });

  it("GET /audit?after=<seq>&limit=：古い順。data は JSON として返す。範囲外は 400", async () => {
    const all = (await t.api({ path: "/audit?limit=1000" })).json.entries as Array<{ seq: number }>;
    expect(all.length).toBeGreaterThan(2);
    const after = (await t.api({ path: `/audit?after=${all[0]?.seq}&limit=1` })).json.entries;
    expect(after).toHaveLength(1);
    expect(after[0].seq).toBe(all[1]?.seq);
    expect(typeof after[0].data).toBe("object");
    for (const q of ["after=-1", "after=x", "limit=0", "limit=1001"]) {
      expect((await t.api({ path: `/audit?${q}` })).status, q).toBe(400);
    }
  });
});

describe("9.2・6.1：POST /reload", () => {
  it("拒否：設定にエラーがあれば 422 config_invalid（issues つき）で、前の設定のまま", async () => {
    const original = t.company.read("aicoop.yaml");
    t.company.write(
      "aicoop.yaml",
      original.replace("max_concurrent_boxes: 3", "max_concurrent_boxes: 99"),
    );
    const res = await t.api({ method: "POST", path: "/reload" });
    expect(res.status).toBe(422);
    expect(res.json.error).toBe("config_invalid");
    expect(res.json.issues[0]).toMatchObject({ code: "E-013", source: "aicoop.yaml" });
    expect((await t.api({ path: "/status" })).json.boxes.max_concurrent).toBe(3);
    t.company.write("aicoop.yaml", original);
  });

  it("読み直すと、監査ログ config.load を書き、トリガーを作り直し、新しい設定を使う", async () => {
    const before = (await t.api({ path: "/audit?limit=1000" })).json.entries.length;
    const original = t.company.read("triggers.yaml");
    t.company.write("triggers.yaml", enableTemplateCron("triggers.yaml", original));
    const res = await t.api({ method: "POST", path: "/reload" });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.warnings).toEqual([]);
    expect(res.json.files["triggers.yaml"]).toMatch(/^[0-9a-f]{64}$/);
    const audit = (await t.api({ path: "/audit?limit=1000" })).json.entries as Array<{
      kind: string;
      actor: string;
    }>;
    expect(audit.length).toBe(before + 1);
    expect(audit.at(-1)).toMatchObject({ kind: "config.load", actor: "owner:cli" });
    const status = (await t.api({ path: "/status" })).json;
    expect(status.triggers[0]).toMatchObject({ id: "sales-morning-news", enabled: true });
    expect(status.triggers[0].next_run_at).toMatch(/Z$/);
    // もとに戻す
    t.company.write("triggers.yaml", original);
    expect((await t.api({ method: "POST", path: "/reload" })).status).toBe(200);
  });

  it("6.1：動いているタスクは、始まったときの設定のまま動く", async () => {
    const id = (await newTask(validTask)).json.task.id;
    await flushMicrotasks();
    const run = fake.runs.find((r) => r.taskId === id);
    const configAtStart = run?.config;
    const original = t.company.read("aicoop.yaml");
    t.company.write("aicoop.yaml", original.replace("timeout_minutes: 45", "timeout_minutes: 20"));
    expect((await t.api({ method: "POST", path: "/reload" })).status).toBe(200);
    expect(run?.config).toBe(configAtStart);
    expect(run?.config.aicoop.task.timeout_minutes).toBe(45);
    const next = await newTask({ ...validTask, member: "sales-researcher" });
    expect(next.json.task.timeout_minutes).toBe(20);
    t.company.write("aicoop.yaml", original);
    expect((await t.api({ method: "POST", path: "/reload" })).status).toBe(200);
    await finishAll();
  });
});

describe("9.2：POST /tasks で、P1 で動かせない社員を断る", () => {
  it("拒否：CEO（box: none）・srt の部署の社員・人間の社員は 422 unknown_member。部長（役員室の vm）は作れる", async () => {
    const other = await startTestDaemon({
      company: {
        transform: (target, text) => {
          const all = withLaterPhaseMembers(target, text);
          return target === "members.yaml"
            ? `${all}\n  a-san: { kind: human, name: "Aさん", company_id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YB", public_key: "pk" }\n`
            : all;
        },
      },
    });
    try {
      const expectations: Array<[string, RegExp]> = [
        ["ceo", /CEO/],
        ["design-image", /srt/],
        ["a-san", /人間の社員/],
      ];
      for (const [member, reason] of expectations) {
        const res = await other.api({
          method: "POST",
          path: "/tasks",
          body: { ...validTask, member },
        });
        expect(res.status, member).toBe(422);
        expect(res.json.error, member).toBe("unknown_member");
        expect(res.json.message, member).toMatch(reason);
      }
      const manager = await other.api({
        method: "POST",
        path: "/tasks",
        body: { ...validTask, member: "mgr-dev" },
      });
      expect(manager.status).toBe(201);
      expect(manager.json.task).toMatchObject({ member_id: "mgr-dev", group_id: "executives" });
    } finally {
      await other.cleanup();
    }
  });
});

describe("ない道", () => {
  it("トークンが正しくても、ない道は 404 not_found", async () => {
    for (const [method, path] of [
      ["GET", "/nope"],
      ["DELETE", "/tasks"],
      ["GET", "/approvals/intent"],
    ] as const) {
      const res = await t.api({ method, path });
      expect(res.status, path).toBe(404);
      expect(res.json.error).toBe("not_found");
    }
    const outside = await t.api({ path: "/status", raw: true });
    expect(outside.status).toBe(404);
  });
});

describe("9.2：POST /shutdown", () => {
  it("200 を返してから止まる（daemon.json・api_token を消す）", async () => {
    const other = await startTestDaemon();
    const db = openStateDb(aicoopPaths(other.company.home).stateDb);
    createTask(db, {
      memberId: "dev-implementer",
      groupId: "dev",
      triggerKind: "manual",
      purpose: "p",
      doneWhen: "d",
      timeoutMinutes: 45,
    });
    db.close();
    const res = await other.api({ method: "POST", path: "/shutdown" });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
    await other.daemon.stopped;
    const paths = aicoopPaths(other.company.home);
    const { existsSync } = await import("node:fs");
    expect(existsSync(paths.daemonInfo)).toBe(false);
    expect(existsSync(paths.apiToken)).toBe(false);
    other.dir.cleanup();
  });
});
