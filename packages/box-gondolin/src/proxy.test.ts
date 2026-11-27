import type { BoxSecret, ProxiedRequest, ProxyDecision } from "@aicoop/shared";
import { describe, expect, it, vi } from "vitest";
import { createProxyHooks, type ProxyHooks } from "./proxy.ts";

const REAL = "ghs_REAL_TOKEN_must_never_be_seen_0123456789";
const githubSecret: BoxSecret = {
  env: "GITHUB_TOKEN",
  hosts: ["api.github.com", "github.com"],
  value: REAL,
};

const forward = async (): Promise<ProxyDecision> => ({ action: "forward" });

function setup(
  onRequest: (req: ProxiedRequest) => Promise<ProxyDecision> = forward,
  secrets: readonly BoxSecret[] = [githubSecret],
) {
  const seen: ProxiedRequest[] = [];
  const onError = vi.fn();
  const hooks = createProxyHooks({
    network: {
      onRequest: async (req) => {
        seen.push(req);
        return onRequest(req);
      },
    },
    secrets,
    onError,
  });
  const placeholder = hooks.placeholders.GITHUB_TOKEN ?? "";
  return { hooks, seen, onError, placeholder };
}

async function send(hooks: ProxyHooks, request: Request): Promise<Request | Response> {
  const onRequest = hooks.httpHooks.onRequest;
  if (!onRequest) throw new Error("onRequest がない");
  const out = await onRequest(request);
  return out ?? request;
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

function decodeBasic(header: string | null): string {
  return Buffer.from((header ?? "").replace(/^Basic\s+/i, ""), "base64").toString("utf8");
}

describe("5.2.1：仮の札", () => {
  it("箱の環境変数に入れるのは仮の札だけで、本物とは違う", () => {
    const { hooks, placeholder } = setup();
    expect(Object.keys(hooks.placeholders)).toEqual(["GITHUB_TOKEN"]);
    expect(placeholder).toMatch(/^GONDOLIN_SECRET_[0-9a-f]{48}$/);
    expect(placeholder).not.toContain(REAL);
  });

  it("5.1.3 の2：実行ごとに新しい仮の札になる", () => {
    const a = setup().placeholder;
    const b = setup().placeholder;
    expect(a).not.toBe(b);
  });

  it("forward で、hosts 宛てのヘッダーの仮の札だけが本物に置き換わる", async () => {
    const { hooks, placeholder } = setup();
    const out = await send(
      hooks,
      new Request("https://api.github.com/user", {
        headers: { authorization: `Bearer ${placeholder}` },
      }),
    );
    expect(out).toBeInstanceOf(Request);
    expect((out as Request).headers.get("authorization")).toBe(`Bearer ${REAL}`);
  });

  it("Basic 認証の中の仮の札も置き換わる（git の資格ヘルパー）", async () => {
    const { hooks, placeholder } = setup();
    const out = await send(
      hooks,
      new Request("https://github.com/myorg/app.git/info/refs?service=git-receive-pack", {
        headers: { authorization: basic("x-access-token", placeholder) },
      }),
    );
    expect(decodeBasic((out as Request).headers.get("authorization"))).toBe(
      `x-access-token:${REAL}`,
    );
  });

  it("5.2.1 の3：本文とクエリの中の仮の札は置き換わらない", async () => {
    const { hooks, placeholder } = setup();
    const out = (await send(
      hooks,
      new Request(`https://api.github.com/x?token=${placeholder}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: `token=${placeholder}`,
      }),
    )) as Request;
    expect(out.url).toContain(placeholder);
    expect(out.url).not.toContain(REAL);
    const body = await out.text();
    expect(body).toBe(`token=${placeholder}`);
    expect(body).not.toContain(REAL);
  });

  it("5.2.1 の受け入れ条件：仮の札をそのサービス以外のホストに送っても、置き換わらない（通信ごと止まる）", async () => {
    const { hooks, placeholder } = setup();
    await expect(
      send(
        hooks,
        new Request("https://evil.example.com/", {
          headers: { authorization: `Bearer ${placeholder}` },
        }),
      ),
    ).rejects.toThrow(/not allowed for host/);
  });

  it("5.2.1 の2：respond のときは置き換えずに、その応答を返す", async () => {
    const { hooks, placeholder, seen } = setup(async () => ({
      action: "respond",
      status: 403,
      headers: { "x-aicoop-decision": "deny", "content-type": "application/json" },
      body: '{"aicoop":"deny","operation":null,"reason":"not_allowed"}',
    }));
    const request = new Request("https://api.github.com/repos/other/secret", {
      headers: { authorization: `Bearer ${placeholder}` },
    });
    const out = await send(hooks, request);
    expect(out).toBeInstanceOf(Response);
    const res = out as Response;
    expect(res.status).toBe(403);
    expect(res.headers.get("x-aicoop-decision")).toBe("deny");
    expect(await res.text()).toBe('{"aicoop":"deny","operation":null,"reason":"not_allowed"}');
    // 元のリクエストの仮の札は本物になっていない
    expect(request.headers.get("authorization")).toBe(`Bearer ${placeholder}`);
    expect(seen).toHaveLength(1);
  });

  it("5.1.3 の受け入れ条件：別の実行の仮の札は、本物に置き換わらない", async () => {
    const runA = setup();
    const runB = setup();
    const out = (await send(
      runB.hooks,
      new Request("https://api.github.com/user", {
        headers: { authorization: `Bearer ${runA.placeholder}` },
      }),
    )) as Request;
    expect(out.headers.get("authorization")).toBe(`Bearer ${runA.placeholder}`);
    expect(out.headers.get("authorization")).not.toContain(REAL);
  });

  it("5.1.3 の2：実行が終わって無効にした札は、本物に置き換わらない", async () => {
    const { hooks, placeholder } = setup();
    hooks.revoke();
    const out = (await send(
      hooks,
      new Request("https://api.github.com/user", {
        headers: { authorization: `Bearer ${placeholder}` },
      }),
    )) as Request;
    expect(out.headers.get("authorization") ?? "").not.toContain(REAL);
  });
});

describe("資格プロキシに渡す ProxiedRequest", () => {
  it("ホストは小文字、ポートは既定（https は 443）、パスはクエリつき", async () => {
    const { hooks, seen } = setup();
    await send(hooks, new Request("https://API.GitHub.COM/Repos/MyOrg/App?per_page=1&x=y"));
    expect(seen[0]).toMatchObject({
      method: "GET",
      protocol: "https",
      host: "api.github.com",
      port: 443,
      path: "/Repos/MyOrg/App?per_page=1&x=y",
    });
  });

  it("http の既定のポートは 80、明示したポートはその値", async () => {
    const { hooks, seen } = setup();
    await send(hooks, new Request("http://example.com/a"));
    await send(hooks, new Request("http://example.com:8080/b"));
    expect(seen.map((r) => [r.protocol, r.port, r.path])).toEqual([
      ["http", 80, "/a"],
      ["http", 8080, "/b"],
    ]);
  });

  it("末尾の . は取り、IPv6 の角かっこは外す", async () => {
    const { hooks, seen } = setup();
    await send(hooks, new Request("https://api.github.com./user"));
    await send(hooks, new Request("http://[2606:4700::1]:8080/"));
    expect(seen.map((r) => r.host)).toEqual(["api.github.com", "2606:4700::1"]);
  });

  it("ヘッダーの名前は小文字、本文のバイト数は content-length から", async () => {
    const { hooks, seen } = setup();
    await send(
      hooks,
      new Request("https://api.github.com/x", {
        method: "POST",
        headers: { "X-Custom": "v", "Content-Length": "5" },
        body: "hello",
      }),
    );
    expect(seen[0]?.headers["x-custom"]).toBe("v");
    expect(seen[0]?.bodyBytes).toBe(5);
  });

  it("本文を読んでも、そのまま外へ送れる（5.2.6 の保留で使う）", async () => {
    const { hooks } = setup(async (req) => {
      const body = new TextDecoder().decode(await req.readBody());
      expect(body).toBe("payload");
      return { action: "forward" };
    });
    const out = (await send(
      hooks,
      new Request("https://api.github.com/x", { method: "POST", body: "payload" }),
    )) as Request;
    expect(await out.text()).toBe("payload");
  });

  it("ProxiedRequest.headers に本物の資格は入らない（仮の札のまま）", async () => {
    const { hooks, seen, placeholder } = setup();
    await send(
      hooks,
      new Request("https://api.github.com/user", {
        headers: { authorization: `Bearer ${placeholder}` },
      }),
    );
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${placeholder}`);
    expect(JSON.stringify(seen[0]?.headers)).not.toContain(REAL);
  });

  it("リダイレクトの2回目（Gondolin が本物を入れたまま渡してくる）でも、ProxiedRequest.headers に本物が入らない", async () => {
    const { hooks, seen, placeholder } = setup();
    const out = (await send(
      hooks,
      new Request("https://api.github.com/redirected", {
        headers: {
          authorization: `Bearer ${REAL}`,
          "proxy-authorization": basic("x-access-token", REAL),
          "x-other": `a ${REAL} b`,
        },
      }),
    )) as Request;
    const headers = seen[0]?.headers ?? {};
    expect(JSON.stringify(headers)).not.toContain(REAL);
    expect(headers.authorization).toBe(`Bearer ${placeholder}`);
    expect(decodeBasic(headers["proxy-authorization"] ?? null)).toBe(
      `x-access-token:${placeholder}`,
    );
    expect(headers["x-other"]).toBe(`a ${placeholder} b`);
    // 判定が forward なので、宛先が hosts の中なら本物に戻って外へ出る
    expect(out.headers.get("authorization")).toBe(`Bearer ${REAL}`);
  });

  it("リダイレクトで本物の資格が別のホストへ向かうときは、置き換わらずに止まる", async () => {
    const { hooks, seen } = setup();
    await expect(
      send(hooks, new Request("https://evil.example.com/", { headers: { "x-api-key": REAL } })),
    ).rejects.toThrow(/not allowed for host/);
    expect(JSON.stringify(seen[0]?.headers)).not.toContain(REAL);
  });
});

describe("判定の失敗は拒否側に倒す", () => {
  function expectDeny(out: Request | Response, reason: string) {
    expect(out).toBeInstanceOf(Response);
    const res = out as Response;
    expect(res.status).toBe(403);
    expect(res.headers.get("x-aicoop-decision")).toBe("deny");
    return res.json().then((json) => {
      expect(json).toEqual({ aicoop: "deny", operation: null, reason });
    });
  }

  it("onRequest が例外を投げたら 403（5.2.5 の deny の形）で、外へ送らない", async () => {
    const { hooks, onError, placeholder } = setup(async () => {
      throw new Error("判定で落ちた");
    });
    const out = await send(
      hooks,
      new Request("https://api.github.com/user", {
        headers: { authorization: `Bearer ${placeholder}` },
      }),
    );
    await expectDeny(out, "proxy_error");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("onRequest が知らない形を返したら 403", async () => {
    const { hooks } = setup(async () => ({ action: "maybe" }) as unknown as ProxyDecision);
    await expectDeny(await send(hooks, new Request("https://api.github.com/user")), "proxy_error");
  });

  it("respond の status が不正なら 403", async () => {
    const { hooks } = setup(async () => ({ action: "respond", status: 42, headers: {}, body: "" }));
    await expectDeny(await send(hooks, new Request("https://api.github.com/user")), "proxy_error");
  });

  it("Host ヘッダーと宛先が食い違うリクエストは 403（判定したものと届くものを一致させる）", async () => {
    const { hooks, seen } = setup();
    const out = await send(
      hooks,
      new Request("https://evil.example.com/", { headers: { host: "api.github.com" } }),
    );
    await expectDeny(out, "invalid_request");
    expect(seen).toHaveLength(0);
  });

  it("Host ヘッダーが宛先と同じなら通す（既定のポートの有無は問わない）", async () => {
    const { hooks, seen } = setup();
    await send(
      hooks,
      new Request("https://api.github.com/user", { headers: { host: "API.github.com:443" } }),
    );
    expect(seen).toHaveLength(1);
  });
});

describe("5.1.4：名前解決のあとのアドレスで、内部へは届かない", () => {
  const ipInfo = (ip: string) => ({
    hostname: "x.example.com",
    ip,
    family: ip.includes(":") ? (6 as const) : (4 as const),
    port: 443,
    protocol: "https" as const,
  });

  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.127.1",
    "::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "198.18.0.1",
  ])("%s へは届かない", async (ip) => {
    const { hooks } = setup();
    expect(await hooks.httpHooks.isIpAllowed?.(ipInfo(ip))).toBe(false);
  });

  it.each(["140.82.112.3", "2606:4700::6810:84e5"])("公開のアドレス %s へは届く", async (ip) => {
    const { hooks } = setup();
    expect(await hooks.httpHooks.isIpAllowed?.(ipInfo(ip))).toBe(true);
  });
});

describe("資格の指定の誤りは作る前に止める", () => {
  const make = (secrets: readonly BoxSecret[]) => () =>
    createProxyHooks({ network: { onRequest: forward }, secrets });

  it("hosts に * があれば作らない（どこにでも本物が出てしまう）", () => {
    expect(make([{ env: "T", hosts: ["*"], value: REAL }])).toThrow();
    expect(make([{ env: "T", hosts: ["*.github.com"], value: REAL }])).toThrow();
  });

  it("環境変数の名前が不正、または重なっていれば作らない", () => {
    expect(make([{ env: "1BAD", hosts: ["a.example.com"], value: REAL }])).toThrow();
    expect(make([{ env: "A-B", hosts: ["a.example.com"], value: REAL }])).toThrow();
    expect(
      make([
        { env: "T", hosts: ["a.example.com"], value: REAL },
        { env: "T", hosts: ["b.example.com"], value: "other" },
      ]),
    ).toThrow();
  });

  it("本物が空なら作らない", () => {
    expect(make([{ env: "T", hosts: ["a.example.com"], value: "" }])).toThrow();
  });

  it("エラーメッセージに本物の資格を出さない（5.2.8、11.5）", () => {
    try {
      make([{ env: "T", hosts: ["*"], value: REAL }])();
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(REAL);
      expect(JSON.stringify(error)).not.toContain(REAL);
    }
  });
});
