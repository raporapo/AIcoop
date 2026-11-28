import { describe, expect, test, vi } from "vitest";
import { ApiFailure, createApiClient } from "./client.ts";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url, init ?? {});
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

describe("API の呼び出し（9.2。承認アプリでの呼び出しはここ1か所）", () => {
  test("同じオリジンのクッキーで /api/v1 を呼び、本文は JSON で送る", async () => {
    const f = fakeFetch(() => json(201, { task: { id: "t_1" } }));
    const api = createApiClient({ fetch: f.fetch });
    await api.createTask({ member: "dev-implementer", purpose: "直す", done_when: "PR を出した" });
    const [call] = f.calls;
    expect(call?.url).toBe("/api/v1/tasks");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.credentials).toBe("same-origin");
    expect(call?.init.cache).toBe("no-store");
    expect(new Headers(call?.init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      member: "dev-implementer",
      purpose: "直す",
      done_when: "PR を出した",
    });
  });

  test("本文のない POST（取り消しなど）も JSON の {} を送る", async () => {
    const f = fakeFetch(() => json(200, { task: {}, was_active: false }));
    const api = createApiClient({ fetch: f.fetch });
    await api.cancelTask("t_01JQ0000000000000000000001");
    expect(f.calls[0]?.url).toBe("/api/v1/tasks/t_01JQ0000000000000000000001/cancel");
    expect(f.calls[0]?.init.body).toBe("{}");
    expect(new Headers(f.calls[0]?.init.headers).get("Content-Type")).toBe("application/json");
  });

  test("GET は本文も Content-Type も付けない。ID と問い合わせの値はエスケープする", async () => {
    const f = fakeFetch(() => json(200, { tasks: [] }));
    const api = createApiClient({ fetch: f.fetch });
    await api.listTasks({ statuses: ["running", "queued"], limit: 50 });
    await api.getHold("h_../../x");
    await api.audit({ after: 120, limit: 200 });
    await api.listGrants(["pending_manager", "pending_owner"]);
    await api.listHolds(["pending_owner"]);
    expect(f.calls.map((c) => c.url)).toEqual([
      "/api/v1/tasks?status=running,queued&limit=50",
      "/api/v1/holds/h_..%2F..%2Fx",
      "/api/v1/audit?after=120&limit=200",
      "/api/v1/grants?status=pending_manager,pending_owner",
      "/api/v1/holds?status=pending_owner",
    ]);
    expect(f.calls[0]?.init.method).toBe("GET");
    expect(f.calls[0]?.init.body).toBeUndefined();
    expect(new Headers(f.calls[0]?.init.headers).has("Content-Type")).toBe(false);
  });

  test("失敗は ApiError の日本語の message をそのまま持つ", async () => {
    const f = fakeFetch(() =>
      json(422, { error: "unknown_member", message: "社員 x は設定にいません" }),
    );
    const api = createApiClient({ fetch: f.fetch });
    const err = await api
      .createTask({ member: "x", purpose: "a", done_when: "b" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err).toMatchObject({
      status: 422,
      code: "unknown_member",
      message: "社員 x は設定にいません",
    });
  });

  test("401 ならログインへ（ログイン・端末の登録の道では呼ばない）", async () => {
    const onUnauthorized = vi.fn();
    const f = fakeFetch(() =>
      json(401, { error: "unauthorized", message: "ログインしてください" }),
    );
    const api = createApiClient({ fetch: f.fetch, onUnauthorized });
    await expect(api.status()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await expect(api.loginVerify({ response: {} })).rejects.toMatchObject({ status: 401 });
    await expect(api.pairingRegister({ code: "c", response: {} })).rejects.toMatchObject({
      status: 401,
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  test("届かないとき（通信の失敗）は offline。届いたかどうかを知らせる", async () => {
    const onReachable = vi.fn();
    let up = false;
    const f = fakeFetch(() => {
      if (!up) throw new TypeError("Failed to fetch");
      return json(200, { usage: null });
    });
    const api = createApiClient({ fetch: f.fetch, onReachable });
    await expect(api.usage()).rejects.toMatchObject({
      status: 0,
      code: "offline",
      message: expect.stringContaining("制御サーバーに届いていません"),
    });
    expect(onReachable).toHaveBeenLastCalledWith(false);
    up = true;
    await api.usage();
    expect(onReachable).toHaveBeenLastCalledWith(true);
  });

  test("ApiError の形でない応答は、読めない応答として日本語で言う", async () => {
    const f = fakeFetch(() => new Response("<html>Bad Gateway</html>", { status: 502 }));
    const api = createApiClient({ fetch: f.fetch });
    await expect(api.status()).rejects.toMatchObject({
      status: 502,
      code: "bad_response",
      message: "制御サーバーから読めない応答が返りました（HTTP 502）",
    });
    const g = fakeFetch(() => new Response("not json", { status: 200 }));
    await expect(createApiClient({ fetch: g.fetch }).status()).rejects.toMatchObject({
      code: "bad_response",
    });
  });

  test("5.14 の4の2：config_invalid の issues を、失敗に持たせる", async () => {
    const issue = { code: "E-001", message: "ない役職です", source: "members.yaml" };
    const f = fakeFetch(() =>
      json(422, { error: "config_invalid", message: "エラーがあります", issues: [issue] }),
    );
    const failure = await createApiClient({ fetch: f.fetch })
      .createConfigChange({ files: [] })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiFailure);
    expect((failure as ApiFailure).issues).toEqual([issue]);
    expect(f.calls[0]?.url).toBe("/api/v1/config/changes");
  });

  test("5.14 の4の1：ファイルのパスは / を残して、ほかを符号にする", async () => {
    const f = fakeFetch(() => json(200, { path: "x", content: "", sha256: "" }));
    const api = createApiClient({ fetch: f.fetch });
    await api.getConfigFile("prompts/roles/implementer.md");
    expect(f.calls[0]?.url).toBe("/api/v1/config/files/prompts/roles/implementer.md");
  });
});
