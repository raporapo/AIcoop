import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeTarget, fakeTarget } from "../../testing/approvals.ts";
import { type Browser, browser } from "../../testing/browser.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/daemon.ts";
import { apiRequest } from "../../testing/http.ts";
import { fakeClock } from "../../testing/state-db.ts";
import { softAuthenticator } from "../../testing/webauthn.ts";

let t: TestDaemon;
let hold: FakeTarget;
const clock = fakeClock();

beforeAll(async () => {
  hold = fakeTarget(null);
  t = await startTestDaemon({ daemon: { now: clock.now, approvalTargets: { hold } } });
});
afterAll(async () => {
  await t.cleanup();
});

const port = () => t.daemon.port;
const token = () => t.daemon.token;

async function loggedIn(name = "仕事のPC"): Promise<{ b: Browser; deviceId: string }> {
  const b = browser(port());
  const deviceId = await b.pair(token(), name);
  const res = await b.login();
  expect(res.status, res.text).toBe(200);
  return { b, deviceId };
}

async function stillRunning() {
  expect((await t.api({ path: "/status" })).status).toBe(200);
}

describe("9.2：承認アプリのログインとセッションクッキー", () => {
  it("ログインすると Set-Cookie（HttpOnly・SameSite=Strict・Path=/api/v1・8時間）。本文にトークンを出さない", async () => {
    const b = browser(port());
    const deviceId = await b.pair(token());
    const res = await b.login();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      device: expect.objectContaining({ id: deviceId, name: "仕事のPC", kind: "pc" }),
      expires_at: new Date(clock.now().getTime() + 8 * 60 * 60 * 1000).toISOString(),
    });
    const cookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []).join("\n");
    expect(cookie).toMatch(/^aicoop_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/v1");
    expect(cookie).toContain("Max-Age=28800");
    expect(cookie).not.toContain("Domain");
    expect(res.text).not.toContain(b.session as string);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("クッキーで、これまでの API（状態・タスク・保留・利用枠・記録・端末）を使える。監査ログの actor は端末", async () => {
    const { b, deviceId } = await loggedIn();
    for (const path of [
      "/status",
      "/tasks",
      "/holds",
      "/usage",
      "/audit",
      "/devices",
      "/auth/me",
    ]) {
      const res = await b.get(path);
      expect(res.status, `${path} ${res.text}`).toBe(200);
    }
    const created = await b.post("/tasks", {
      member: "dev-implementer",
      purpose: "承認アプリから頼む",
      done_when: "報告した",
    });
    expect(created.status, created.text).toBe(201);
    const audit = await t.api({ path: "/audit?limit=1000" });
    const entry = (
      audit.json.entries as Array<{ kind: string; subject: string; actor: string }>
    ).find((e) => e.kind === "task.state" && e.subject === created.json.task.id);
    expect(entry?.actor).toBe(`owner:${deviceId}`);
  });

  it("拒否：クッキーの POST で Origin がない・違うと 403 forbidden_origin（タスクを作らない）", async () => {
    const { b } = await loggedIn();
    const before = (await t.api({ path: "/tasks" })).json.tasks.length;
    for (const origin of [
      null,
      "http://localhost:1",
      `http://127.0.0.1:${port()}`,
      `https://localhost:${port()}`,
      "null",
      `http://localhost:${port()}.evil.example`,
      `http://evil.example`,
    ]) {
      const res = await b.post(
        "/tasks",
        { member: "dev-implementer", purpose: "CSRF", done_when: "x" },
        { origin },
      );
      expect(res.status, String(origin)).toBe(403);
      expect(res.json).toMatchObject({ error: "forbidden_origin" });
    }
    expect((await t.api({ path: "/tasks" })).json.tasks.length).toBe(before);
  });

  it("拒否：Sec-Fetch-Site がほかのサイト・ほかのオリジンなら、GET でも 403", async () => {
    const { b } = await loggedIn();
    for (const site of ["cross-site", "same-site"]) {
      const res = await b.get("/holds", { headers: { "sec-fetch-site": site } });
      expect(res.status, site).toBe(403);
    }
    expect((await b.get("/holds", { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(
      200,
    );
  });

  it("拒否：Bearer だけの道（止める・読み直す・ペアリングのコード）は、クッキーでは 401", async () => {
    const { b } = await loggedIn();
    const routes: Array<["GET" | "POST", string]> = [
      ["POST", "/shutdown"],
      ["POST", "/reload"],
      ["POST", "/pairing/local"],
      ["GET", "/pairing/local/ABCDE-FGHJK"],
      ["POST", "/pairing/local/ABCDE-FGHJK/activate"],
      ["POST", "/pairing/local/ABCDE-FGHJK/cancel"],
    ];
    for (const [method, path] of routes) {
      const res = method === "GET" ? await b.get(path) : await b.post(path);
      expect(res.status, path).toBe(401);
      expect(res.json).toMatchObject({ error: "unauthorized" });
    }
    await stillRunning();
  });

  it("拒否：パスの書き方を変えても、Bearer だけの道にクッキーで届かない", async () => {
    const { b } = await loggedIn();
    for (const path of [
      "/api/v1/%73hutdown",
      "/api/v1/shutdown/",
      "/api/v1/SHUTDOWN",
      "/api/v1//shutdown",
      "/api/v1/pairing/%6Cocal",
      "/api/v1/pairing/local/",
      "/api/v1/./shutdown",
    ]) {
      const res = await apiRequest(port(), {
        method: "POST",
        path,
        raw: true,
        token: null,
        host: `localhost:${port()}`,
        body: {},
        headers: { origin: b.origin, cookie: `aicoop_session=${b.session}` },
      });
      expect([401, 404], `${path} ${res.status}`).toContain(res.status);
      await stillRunning();
    }
  });

  it("拒否：クッキーだけの道（承認の署名・ログイン中の端末）は、Bearer では 401", async () => {
    for (const [method, path] of [
      ["POST", "/approvals/intent"],
      ["POST", "/approvals/assert"],
      ["GET", "/auth/me"],
      ["POST", "/auth/logout"],
    ] as const) {
      const res = await t.api({ method, path, ...(method === "POST" && { body: {} }) });
      expect(res.status, path).toBe(401);
      expect(res.json.message).toMatch(/承認アプリ/);
    }
  });

  it("拒否：知らないクッキー・壊れたクッキー・ほかの名前のクッキーは 401", async () => {
    const { b } = await loggedIn();
    for (const cookie of ["x", "", `${b.session}x`, (b.session as string).slice(1)]) {
      expect((await b.get("/status", { cookie })).status, cookie).toBe(401);
    }
    const other = await apiRequest(port(), {
      path: "/status",
      token: null,
      host: `localhost:${port()}`,
      headers: { cookie: `aicoop_sessionx=${b.session}` },
    });
    expect(other.status).toBe(401);
  });

  it("ほかのソフトが同じ名前の偽のクッキーを置いても、本物があればログインのまま", async () => {
    const { b } = await loggedIn();
    const res = await apiRequest(port(), {
      path: "/status",
      token: null,
      host: `localhost:${port()}`,
      headers: { cookie: `aicoop_session=fake; aicoop_session=${b.session}` },
    });
    expect(res.status).toBe(200);
  });

  it("拒否：Authorization が違えば、正しいクッキーがあっても 401（クッキーに切り替えない）", async () => {
    const { b } = await loggedIn();
    const res = await b.get("/status", { headers: { authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });

  it("拒否：期限（8時間）を過ぎたセッション", async () => {
    const { b } = await loggedIn();
    clock.advance(8 * 60 * 60 * 1000);
    expect((await b.get("/status")).status).toBe(401);
  });

  it("ログアウトすると、そのクッキーは使えない（Set-Cookie で消す）", async () => {
    const { b } = await loggedIn();
    const res = await b.post("/auth/logout");
    expect(res.status).toBe(200);
    expect(([] as string[]).concat(res.headers["set-cookie"] ?? []).join()).toMatch(
      /aicoop_session=;.*Max-Age=0/,
    );
    expect((await b.get("/status")).status).toBe(401);
  });

  it("T-12：CLI で端末を取り消すと、そのセッションはすぐ使えない（ログインもできない）", async () => {
    const { b, deviceId } = await loggedIn("なくしたPC");
    const revoked = await t.api({ method: "POST", path: `/devices/${deviceId}/revoke`, body: {} });
    expect(revoked.status).toBe(200);
    expect(revoked.json.device.revoked_at).not.toBeNull();
    expect((await b.get("/status")).status).toBe(401);
    // ほかの端末が残っていても、取り消した端末ではログインできない
    await loggedIn("残るPC");
    const again = await b.login({ ignoreCredentialLists: true });
    expect(again.status).toBe(400);
    expect(again.json.error).toBe("signature_invalid");
  });

  it("承認アプリから自分の端末を取り消せる（監査ログに、取り消した端末が残る）", async () => {
    const { b, deviceId } = await loggedIn("自分で消す");
    const res = await b.post(`/devices/${deviceId}/revoke`);
    expect(res.status).toBe(200);
    expect((await b.get("/status")).status).toBe(401);
    const audit = await t.api({ path: "/audit?limit=1000" });
    const last = (audit.json.entries as Array<{ kind: string; subject: string; actor: string }>)
      .filter((e) => e.kind === "device.state" && e.subject === deviceId)
      .at(-1);
    expect(last?.actor).toBe(`owner:${deviceId}`);
    // もう一度取り消すと 409、ない端末は 404
    expect(
      (await t.api({ method: "POST", path: `/devices/${deviceId}/revoke`, body: {} })).status,
    ).toBe(409);
    expect(
      (
        await t.api({
          method: "POST",
          path: "/devices/d_01JD6V8X3S0Q5W7KQ9M2T4R6YB/revoke",
          body: {},
        })
      ).status,
    ).toBe(404);
  });
});

describe("5.8 の2：認証なしの道（端末の登録・ログイン）", () => {
  it("拒否：Origin がない・違うと 403 forbidden_origin", async () => {
    const b = browser(port());
    for (const path of [
      "/pairing/options",
      "/pairing/register",
      "/auth/login/options",
      "/auth/login/verify",
    ]) {
      for (const origin of [null, "http://localhost:3000", `http://127.0.0.1:${port()}`]) {
        const res = await b.post(path, {}, { origin });
        expect(res.status, `${path} ${origin}`).toBe(403);
        expect(res.json.error).toBe("forbidden_origin");
      }
    }
  });

  it("拒否：Host が違えば 403 forbidden_host（DNS リバインディング）", async () => {
    const res = await apiRequest(port(), {
      method: "POST",
      path: "/auth/login/options",
      token: null,
      host: `evil.example:${port()}`,
      headers: { origin: `http://evil.example:${port()}` },
      body: {},
    });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("forbidden_host");
  });

  it("拒否：JSON でない本文は 415、読めない JSON は 400", async () => {
    const b = browser(port());
    const notJson = await b.post("/pairing/options", undefined, {
      headers: { "content-type": "text/plain" },
    });
    expect(notJson.status).toBe(415);
    const broken = await apiRequest(port(), {
      method: "POST",
      path: "/pairing/options",
      token: null,
      host: `localhost:${port()}`,
      rawBody: "{",
      headers: { origin: b.origin, "content-type": "application/json" },
    });
    expect(broken.status).toBe(400);
  });

  it("CLI は登録を待つあいだ、状態・端末の名前・確認コードを読める（ブラウザに出たものと同じ）", async () => {
    const b = browser(port());
    const started = await t.api({ method: "POST", path: "/pairing/local", body: {} });
    expect(started.status).toBe(201);
    expect(started.json.url).toBe(`http://localhost:${port()}/app/#/pair`);
    const code = started.json.code as string;
    const waiting = await t.api({ path: `/pairing/local/${code}` });
    expect(waiting.json).toMatchObject({ status: "waiting", confirm_code: null });
    const opts = await b.post("/pairing/options", { code, device_name: "ノートPC" });
    const reg = await b.post("/pairing/register", {
      code,
      response: b.auth.createCredential(opts.json.options),
    });
    expect(reg.status).toBe(200);
    const status = await t.api({ path: `/pairing/local/${code}` });
    expect(status.json).toMatchObject({
      status: "registered",
      device_name: "ノートPC",
      confirm_code: reg.json.confirm_code,
    });
    const cancel = await t.api({ method: "POST", path: `/pairing/local/${code}/cancel`, body: {} });
    expect(cancel.json).toEqual({ ok: true });
    expect((await t.api({ path: `/pairing/local/${code}` })).json.status).toBe("cancelled");
  });

  it("端末の一覧（Bearer）に、パスキーの鍵を出さない", async () => {
    const auth = softAuthenticator();
    const b = browser(port(), auth);
    await b.pair(token(), "一覧のPC");
    const res = await t.api({ path: "/devices" });
    expect(res.status).toBe(200);
    expect(res.json.devices.map((d: { name: string }) => d.name)).toContain("一覧のPC");
    expect(res.text).not.toContain(auth.credentialId);
  });
});

describe("5.8 の3：承認の署名（HTTP）", () => {
  async function signIntent(b: Browser, id: string, decision = "approve") {
    const intent = await b.post("/approvals/intent", { type: "hold", id, decision });
    expect(intent.status, intent.text).toBe(200);
    const response = b.auth.getAssertion(intent.json.options);
    return { payload: intent.json.payload, response };
  }

  it("承認の意思 → パスキーの署名 → 記録（対象の状態が変わり、監査ログに approval が残る）", async () => {
    const { b, deviceId } = await loggedIn();
    const id = hold.add();
    const body = await signIntent(b, id);
    const res = await b.post("/approvals/assert", body);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({
      approval: { subject_type: "hold", subject_id: id, decision: "approve", device_id: deviceId },
      subject_status: "approved",
    });
    expect(hold.items.get(id)?.status).toBe("approved");
    const audit = await b.get("/audit?limit=1000");
    expect(
      (audit.json.entries as Array<{ kind: string; subject: string }>).some(
        (e) => e.kind === "approval" && e.subject === id,
      ),
    ).toBe(true);
  });

  it("受け入れ条件（5.8）：書き換えた payload は 400 payload_mismatch、送り直しは 409 nonce_used、期限切れは 400 approval_expired", async () => {
    const { b } = await loggedIn();
    const a = hold.add();
    const tampered = await signIntent(b, a);
    const r1 = await b.post("/approvals/assert", {
      ...tampered,
      payload: { ...tampered.payload, decision: "reject" },
    });
    expect(r1.status).toBe(400);
    expect(r1.json.error).toBe("payload_mismatch");

    const replay = await signIntent(b, a);
    expect((await b.post("/approvals/assert", replay)).status).toBe(200);
    const r2 = await b.post("/approvals/assert", replay);
    expect(r2.status).toBe(409);
    expect(r2.json.error).toBe("nonce_used");

    const c = hold.add();
    const late = await signIntent(b, c);
    clock.advance(2 * 60 * 1000 + 1);
    const r3 = await b.post("/approvals/assert", late);
    expect(r3.status).toBe(400);
    expect(r3.json.error).toBe("approval_expired");
    expect(hold.items.get(c)?.status).toBe("pending_owner");
  });

  it("拒否：Origin が違う承認の意思・署名は 403（CSRF）", async () => {
    const { b } = await loggedIn();
    const id = hold.add();
    const intent = await b.post(
      "/approvals/intent",
      { type: "hold", id, decision: "approve" },
      { origin: "http://localhost:3000" },
    );
    expect(intent.status).toBe(403);
    const body = await signIntent(b, id);
    const res = await b.post("/approvals/assert", body, { origin: null });
    expect(res.status).toBe(403);
    expect(hold.items.get(id)?.status).toBe("pending_owner");
  });
});

describe("5.8 の3：startDaemon の approvalTargets と、止めるときの afterApply", () => {
  it("daemon を止めるときは、承認のあとの処理（afterApply）が終わるのを待ってから閉じる", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = fakeTarget(null);
    let finished = false;
    target.afterApply = async () => {
      await gate;
      finished = true;
    };
    const d = await startTestDaemon({ daemon: { approvalTargets: { hold: target } } });
    try {
      const b = browser(d.daemon.port);
      await b.pair(d.daemon.token);
      expect((await b.login()).status).toBe(200);
      const id = target.add();
      const intent = await b.post("/approvals/intent", { type: "hold", id, decision: "approve" });
      const res = await b.post("/approvals/assert", {
        payload: intent.json.payload,
        response: b.auth.getAssertion(intent.json.options),
      });
      expect(res.status, res.text).toBe(200);
      let stopped = false;
      const stopping = d.daemon.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);
      release();
      await stopping;
      expect(finished).toBe(true);
    } finally {
      release();
      await d.cleanup();
    }
  });

  it("対象を渡さなければ、どの種類も承認できない（404）", async () => {
    const d = await startTestDaemon();
    try {
      const b = browser(d.daemon.port);
      await b.pair(d.daemon.token);
      await b.login();
      const res = await b.post("/approvals/intent", {
        type: "hold",
        id: "h_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
        decision: "approve",
      });
      expect(res.status).toBe(404);
    } finally {
      await d.cleanup();
    }
  });
});
