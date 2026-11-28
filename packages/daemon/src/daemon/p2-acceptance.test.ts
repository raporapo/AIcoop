/**
 * P2 の受け入れ条件 S-1・S-4（1.2、5.7.1、5.7.3、14章 P2）を、本物の daemon・本物の実行（startRun）・
 * 偽の箱・偽の Gmail と GitHub（fetch の差し替え）・ソフトウェアのパスキーで、端から端まで通す。
 *
 * - 部長のレビューも、役員室の箱で動く部長の実行（偽の Claude Code が review_decision を呼ぶ）で行う
 * - オーナーの承認は、承認アプリと同じ HTTP の流れ（端末の登録 → ログイン → 承認の意思 → 署名）で行う
 */
import { join } from "node:path";
import { EXTERNAL_TEXT_BEGIN } from "@aicoop/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aicoopPaths } from "../paths.ts";
import { createStartRun } from "../run/execute.ts";
import { setSecret } from "../secrets/store.ts";
import { type Browser, browser } from "../testing/browser.ts";
import { P2_FILES, writeCompanyFiles } from "../testing/company-config.ts";
import { FakeBoxDriver, type FakeClaude, fakeEvents } from "../testing/fake-box.ts";
import { base64url, fakeServices, rfc2822 } from "../testing/fake-services.ts";
import { apiRequest, type TestRequest } from "../testing/http.ts";
import { TEST_ANTHROPIC_TOKEN } from "../testing/run-env.ts";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import { type DaemonHandle, startDaemon } from "./start.ts";

const PLACEHOLDER = `GONDOLIN_SECRET_${"ab".repeat(24)}`;
const HOLD_ID = /h_[0-9A-Z]{26}/;
const GRANT_ID = /g_[0-9A-Z]{26}/;
const HOUR = 3600_000;

const MAIL = rfc2822({
  to: "yamada@customer.example",
  subject: "新サービスのご案内",
  body: "山田様\r\n\r\n新しいサービスのご案内です。",
});

interface Seen {
  readonly member: string;
  readonly prompt: string;
  readonly notes: Record<string, unknown>;
}

let dir: TempDir;
let daemon: DaemonHandle;
let owner: Browser;
let offset = 0;
const services = fakeServices();
const seen: Seen[] = [];

const promptOf = (cmd: readonly string[]) => cmd[cmd.indexOf("-p") + 1] ?? "";
const bodyOf = (d: unknown) =>
  JSON.parse((d as { body?: string }).body ?? "null") as Record<string, unknown>;
const textOf = (result: unknown) =>
  JSON.parse(
    ((result as { content: { text: string }[] }).content[0] as { text: string }).text,
  ) as Record<string, unknown>;

/** 社員ごとの偽の Claude Code */
const claude: FakeClaude = async (c) => {
  const prompt = promptOf(c.cmd);
  const notes: Record<string, unknown> = {};
  seen.push({ member: c.spec.memberId, prompt, notes });
  c.emit(fakeEvents.init(`sess-${seen.length}`));

  switch (c.spec.memberId) {
    case "sales-mailer": {
      if (prompt.includes("## 保留の結果")) {
        await c.reportResult("送信されたことを確かめました");
        break;
      }
      // S-1：メールを送ろうとする → 保留（428）
      const decision = await c.request({
        method: "POST",
        host: "gmail.googleapis.com",
        path: "/gmail/v1/users/me/messages/send",
        headers: { authorization: `Bearer ${PLACEHOLDER}`, "content-type": "application/json" },
        body: JSON.stringify({ raw: base64url(MAIL) }),
      });
      notes.decision = decision;
      await c.reportResult(`送信は承認待ちです（${String(bodyOf(decision).hold_id)}）`);
      break;
    }
    case "mgr-sales":
    case "mgr-dev": {
      const id = (prompt.match(HOLD_ID) ?? prompt.match(GRANT_ID))?.[0];
      notes.tools = await c.listTools();
      notes.review = await c.callTool("review_decision", {
        item_id: id ?? "",
        decision: "pass",
        comment: "仕事に要る範囲で、宛先・中身にも問題がありません",
      });
      await c.reportResult(`${id} をレビューして pass にしました`);
      break;
    }
    case "dev-implementer": {
      const push = () =>
        c.request({
          method: "POST",
          host: "github.com",
          path: "/myorg/new.git/git-receive-pack",
          headers: { authorization: `Basic ${PLACEHOLDER}` },
          body: "0000",
        });
      notes.push = await push();
      notes.secrets = c.spec.secrets.map((s) => s.env);
      if (prompt.includes("申請する")) {
        notes.access = await c.callTool("request_access", {
          service: "github",
          operation: "git.push",
          params: { repo: ["myorg/new"] },
          reason: "Issue #12 の実装を、新しいリポジトリ myorg/new に push するため",
          duration_hours: 24,
        });
        notes.mine = await c.callTool("list_my_holds", {});
      }
      await c.reportResult("終わりました");
      break;
    }
  }
  c.emit(fakeEvents.result());
  return 0;
};

const api = (req: TestRequest) => apiRequest(daemon.port, { token: daemon.token, ...req });

async function waitFor<T>(
  what: string,
  get: () => Promise<T | undefined>,
  ms = 20_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await get();
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(`待ちきれませんでした：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function taskDone(id: string) {
  return waitFor(`タスク ${id} の終わり`, async () => {
    const res = await api({ path: `/tasks/${id}` });
    return ["done", "done_without_report", "failed"].includes(res.json.task.status)
      ? res.json.task
      : undefined;
  });
}

async function newTask(member: string, purpose: string, thread?: string) {
  const res = await api({
    method: "POST",
    path: "/tasks",
    body: { member, purpose, done_when: "report_result で報告した", ...(thread && { thread }) },
  });
  expect(res.status, res.text).toBe(201);
  return res.json.task.id as string;
}

async function approve(type: "hold" | "grant", id: string) {
  const intent = await owner.post("/approvals/intent", { type, id, decision: "approve" });
  expect(intent.status, intent.text).toBe(200);
  const response = owner.auth.getAssertion(intent.json.options);
  const body = { payload: intent.json.payload, response };
  const res = await owner.post("/approvals/assert", body);
  expect(res.status, res.text).toBe(200);
  return { res, body };
}

beforeAll(async () => {
  dir = tempDir();
  const home = join(dir.path, ".aicoop");
  writeCompanyFiles(home, {
    ...P2_FILES,
    triggers: [{ id: "mailer-hold-result", type: "on_hold_resolved", member: "sales-mailer" }],
  });
  const paths = aicoopPaths(home);
  setSecret(paths.secrets, "anthropic", "anthropic_oauth", { token: TEST_ANTHROPIC_TOKEN });
  setSecret(paths.secrets, "gmail", "google_oauth", {
    client_id: "cid",
    client_secret: "csecret",
    refresh_token: "1//refresh-REAL",
  });
  setSecret(paths.secrets, "github", "static_token", { token: "github_pat_REALTOKEN0123" });
  daemon = await startDaemon({
    home,
    startRun: createStartRun({ stopWaitMs: 2000 }),
    drivers: { vm: new FakeBoxDriver(claude) },
    port: 0,
    fetch: services.fetch,
    now: () => new Date(Date.now() + offset),
  });
  owner = browser(daemon.port);
  await owner.pair(daemon.token, "オーナーのPC");
  const login = await owner.login();
  expect(login.status, login.text).toBe(200);
}, 30_000);

afterAll(async () => {
  await daemon?.stop();
  dir?.cleanup();
});

describe("P2 の完了条件：S-1（メール作成AIの送信が保留になり、営業部長AIが pass、オーナーが承認したあとに1回だけ送られる）", () => {
  let holdId: string;

  it("メール作成AIの送信は 428 で保留になり、Gmail には届かない。営業部長AIのレビューのタスクが役員室の箱で動き、review_decision で pass する", async () => {
    const taskId = await newTask(
      "sales-mailer",
      "見込み客に新サービスのご案内を送る",
      "prospect-1",
    );
    await taskDone(taskId);
    const mailer = seen.find((s) => s.member === "sales-mailer");
    expect(mailer?.notes.decision).toMatchObject({
      status: 428,
      headers: { "X-Aicoop-Decision": "hold" },
    });
    holdId = String(bodyOf(mailer?.notes.decision).hold_id);
    expect(holdId).toMatch(HOLD_ID);

    const hold = await waitFor("部長の pass", async () => {
      const res = await api({ path: `/holds/${holdId}` });
      return res.json.hold.status === "pending_owner" ? res.json.hold : undefined;
    });
    expect(services.sent()).toEqual([]);

    // 部長のレビューのタスク（review、優先度1、役員室の箱）が終わるまで待つ
    const reviewTask = await waitFor("レビューのタスクの終わり", async () => {
      const tasks = (await api({ path: "/tasks?status=done" })).json.tasks as Array<{
        trigger_kind: string;
        member_id: string;
        group_id: string;
        review_subject: string | null;
        priority: number;
      }>;
      return tasks.find((t) => t.trigger_kind === "review");
    });
    // 部長のレビューは、要約を外から来た文章として囲んだタスク本文で動いた
    const review = seen.find((s) => s.member === "mgr-sales");
    expect(review?.prompt).toContain(holdId);
    expect(review?.prompt).toContain(EXTERNAL_TEXT_BEGIN);
    expect(review?.prompt).toContain("yamada@customer.example");
    expect(review?.prompt).toContain("新サービスのご案内");
    expect(review?.notes.tools).toContain("review_decision");
    expect(textOf(review?.notes.review)).toMatchObject({ ok: true, status: "pending_owner" });
    expect(reviewTask).toMatchObject({
      member_id: "mgr-sales",
      group_id: "executives",
      review_subject: holdId,
      priority: 1,
    });

    // 承認アプリに見せる要約と、元のリクエスト（認証ヘッダーは保存していない）
    expect(hold).toMatchObject({
      operation: "gmail.message.send",
      manager_comment: "仕事に要る範囲で、宛先・中身にも問題がありません",
      summary: {
        kind: "gmail_message",
        to: ["yamada@customer.example"],
        subject: ["新サービスのご案内"],
        body_text: "山田様\n\n新しいサービスのご案内です。",
        manager_comment: "仕事に要る範囲で、宛先・中身にも問題がありません",
      },
      request: {
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        headers: { "content-type": "application/json" },
      },
    });
    expect(JSON.stringify(hold)).not.toContain(PLACEHOLDER);
  }, 30_000);

  it("オーナーが承認アプリ（パスキーの署名）で承認すると、本物の資格を付けて1回だけ送られ、replayed になる。同じ署名を送り直しても二度は送られない", async () => {
    const { res, body } = await approve("hold", holdId);
    expect(res.json.subject_status).toBe("approved");
    const hold = await waitFor("再送", async () => {
      const r = await api({ path: `/holds/${holdId}` });
      return r.json.hold.status === "replayed" ? r.json.hold : undefined;
    });
    expect(hold).toMatchObject({
      response_status: 200,
      decided_by: expect.stringMatching(/^owner:d_/),
    });

    const sent = services.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "POST",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      body: JSON.stringify({ raw: base64url(MAIL) }),
    });
    // 再送のときに発行し直した Google のアクセストークン（箱の仮の札でも、実行のときのトークンでもない）
    const sentIndex = services.calls.indexOf(sent[0] as (typeof services.calls)[number]);
    const issuedBefore = services.calls
      .slice(0, sentIndex)
      .filter((c) => c.url === "https://oauth2.googleapis.com/token").length;
    expect(issuedBefore).toBe(2);
    expect(sent[0]?.headers.authorization).toBe(`Bearer ${services.issued[1]}`);
    expect(sent[0]?.headers.authorization).not.toContain("GONDOLIN_SECRET_");

    const again = await owner.post("/approvals/assert", body);
    expect(again.status).toBe(409);
    expect(services.sent()).toHaveLength(1);
  }, 30_000);

  it("on_hold_resolved のトリガーで、メール作成AIのタスクが保留を出したときのスレッドで作られ、タスク本文に保留の結果が入る", async () => {
    const task = await waitFor("on_hold_resolved のタスク", async () => {
      const res = await api({ path: "/tasks?status=done" });
      return (
        res.json.tasks as Array<{ trigger_kind: string; hold_id: string; thread: string }>
      ).find((t) => t.trigger_kind === "on_hold_resolved");
    });
    expect(task).toMatchObject({ hold_id: holdId, thread: "prospect-1" });
    const second = seen.filter((s) => s.member === "sales-mailer").at(-1);
    expect(second?.prompt).toContain(`保留 ${holdId} の結果が出た。結果を確かめて作業を続ける`);
    expect(second?.prompt).toContain("## 保留の結果");
    expect(second?.prompt).toContain("承認され、実行しました。応答のステータスは 200 です。");
    expect(services.sent()).toHaveLength(1);
  }, 30_000);
});

describe("P2 の完了条件：S-4（申請 → 部長の pass → オーナーの承認のあと、そのリポジトリへの push が通る。24時間後には deny）", () => {
  let grantId: string;

  it("許可していないリポジトリへの push は 403。request_access で申請すると、開発部長AIのレビューで pass になる", async () => {
    const taskId = await newTask("dev-implementer", "myorg/new への push の権限を申請する");
    await taskDone(taskId);
    const first = seen.filter((s) => s.member === "dev-implementer").at(-1);
    expect(first?.notes.push).toMatchObject({ status: 403 });
    const access = textOf(first?.notes.access);
    expect(access).toMatchObject({ ok: true, status: "pending_manager" });
    grantId = String(access.grant_id);
    // list_my_holds は自分のものだけ（営業部の保留は見えない）
    const mine = textOf(first?.notes.mine) as {
      holds: unknown[];
      grants: Array<{ grant_id: string }>;
    };
    expect(mine.holds).toEqual([]);
    expect(mine.grants.map((g) => g.grant_id)).toEqual([grantId]);

    const grant = await waitFor("部長の pass", async () => {
      const res = await api({ path: "/grants" });
      return (res.json.grants as Array<{ id: string; status: string }>).find(
        (g) => g.id === grantId && g.status === "pending_owner",
      );
    });
    expect(grant).toMatchObject({
      operation: "github.git.push",
      params: { repo: ["myorg/new"] },
      mode: "allow",
      duration_hours: 24,
      manager_comment: "仕事に要る範囲で、宛先・中身にも問題がありません",
    });
    expect(seen.find((s) => s.member === "mgr-dev")?.prompt).toContain(grantId);
  }, 30_000);

  it("オーナーが承認すると active（24時間）になり、そのリポジトリへの push が通る。24時間後には 403 に戻る", async () => {
    const { res } = await approve("grant", grantId);
    expect(res.json.subject_status).toBe("active");
    const grants = (await api({ path: "/grants?status=active" })).json.grants as Array<{
      id: string;
      starts_at: string;
      expires_at: string;
    }>;
    const active = grants.find((g) => g.id === grantId);
    expect(Date.parse(active?.expires_at ?? "") - Date.parse(active?.starts_at ?? "")).toBe(
      24 * HOUR,
    );

    await taskDone(await newTask("dev-implementer", "myorg/new に push する"));
    const allowed = seen.filter((s) => s.member === "dev-implementer").at(-1);
    expect(allowed?.notes.push).toEqual({ action: "forward" });
    expect(allowed?.notes.secrets).toContain("GITHUB_TOKEN");

    offset += 24 * HOUR;
    await taskDone(await newTask("dev-implementer", "24時間後に、もう一度 push する"));
    const later = seen.filter((s) => s.member === "dev-implementer").at(-1);
    expect(later?.notes.push).toMatchObject({ status: 403 });
  }, 30_000);
});

describe("9.2：GET /holds・/holds/{id}・/grants の拒否される側", () => {
  it("知らない状態・範囲の外の limit は 400、保留でない ID・無い保留は 404", async () => {
    for (const path of [
      "/holds?status=nope",
      "/holds?limit=0",
      "/holds?limit=501",
      "/grants?status=approved",
    ]) {
      const res = await api({ path });
      expect(res.status, path).toBe(400);
      expect(res.json).toMatchObject({ error: "invalid_input" });
    }
    for (const id of ["h_01JD6V8X3S0Q5W7KQ9M2T4R6YB", "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB", "..%2f"]) {
      expect((await api({ path: `/holds/${id}` })).status, id).toBe(404);
    }
    const replayed = await api({ path: "/holds?status=replayed" });
    expect(replayed.json.holds).toHaveLength(1);
    expect((await api({ path: "/holds?status=pending_owner" })).json.holds).toEqual([]);
  });
});
