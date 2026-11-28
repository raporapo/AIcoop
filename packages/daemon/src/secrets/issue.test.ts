import { generateKeyPairSync, verify } from "node:crypto";
import { join } from "node:path";
import { type CompanyConfig, effectivePermissionsFor } from "@aicoop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTestCompany } from "../testing/company-config.ts";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import {
  CredentialError,
  githubAppJwt,
  githubPermissionsFor,
  githubRepositoriesFor,
  prepareBoxSecrets,
  readAnthropicToken,
} from "./issue.ts";
import { setSecret } from "./store.ts";

const NOW = new Date("2026-11-28T00:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

let tmp: TempDir;
let home: string;
let secretsPath: string;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.path, ".aicoop");
  secretsPath = join(home, "secrets.json");
});
afterEach(() => tmp.cleanup());

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: f, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function devConfig(overrides: Parameters<typeof loadTestCompany>[1] = {}): CompanyConfig {
  return loadTestCompany(home, overrides);
}

function effective(config: CompanyConfig, member: string) {
  return effectivePermissionsFor(config, member, { now: NOW });
}

describe("5.2.8：本物の資格を、実行の開始時に用意する（資格の ID はサービスの ID と同じ）", () => {
  it("static_token はそのまま使う（GitHub の fine-grained PAT もこれで使える）", async () => {
    const config = devConfig();
    setSecret(secretsPath, "github", "static_token", { token: "github_pat_REAL0123456789" });
    const { fetch, calls } = fakeFetch(() => json(500, {}));

    const prepared = await prepareBoxSecrets({
      config,
      effective: effective(config, "dev-implementer"),
      secretsPath,
      fetch,
      now: NOW,
    });

    expect(prepared.secrets).toEqual([
      {
        env: "GITHUB_TOKEN",
        hosts: ["api.github.com", "github.com"],
        value: "github_pat_REAL0123456789",
      },
    ]);
    expect(prepared.missing).toEqual([]);
    expect(prepared.realValues).toEqual(["github_pat_REAL0123456789"]);
    expect(calls).toEqual([]);
  });

  it("有効な許可 E(m) にあるサービスの資格だけを渡す（ほかのサービスの資格は渡さない）", async () => {
    const config = devConfig();
    setSecret(secretsPath, "github", "static_token", { token: "github_pat_REAL0123456789" });
    setSecret(secretsPath, "gmail", "static_token", { token: "gmail-real-token-xyz" });
    const { fetch } = fakeFetch(() => json(500, {}));

    // 調査担当は web.read だけ（web は資格を使わない）
    const prepared = await prepareBoxSecrets({
      config,
      effective: effective(config, "sales-researcher"),
      secretsPath,
      fetch,
      now: NOW,
    });
    expect(prepared.secrets).toEqual([]);
    expect(prepared.missing).toEqual([]);
  });

  it("資格が登録されていないサービスは渡さず、未登録として返す", async () => {
    const config = devConfig();
    const { fetch } = fakeFetch(() => json(500, {}));
    const prepared = await prepareBoxSecrets({
      config,
      effective: effective(config, "dev-implementer"),
      secretsPath,
      fetch,
      now: NOW,
    });
    expect(prepared.secrets).toEqual([]);
    expect(prepared.missing).toEqual(["github"]);
  });

  it("サービスに合わない種類の資格（GitHub に google_oauth、anthropic_oauth）は、渡さずにエラーにする。値はメッセージに出さない", async () => {
    const config = devConfig();
    setSecret(secretsPath, "github", "anthropic_oauth", { token: "sk-ant-oat01-SECRETVALUE" });
    const { fetch } = fakeFetch(() => json(500, {}));
    const run = prepareBoxSecrets({
      config,
      effective: effective(config, "dev-implementer"),
      secretsPath,
      fetch,
      now: NOW,
    });
    await expect(run).rejects.toThrow(CredentialError);
    await expect(run).rejects.toThrow(/github/);
    await expect(run).rejects.not.toThrow(/SECRETVALUE/);
  });

  it("github_app：JWT（RS256）でインストールトークンを発行し、その値を渡す", async () => {
    const config = devConfig();
    setSecret(secretsPath, "github", "github_app", {
      app_id: 12345,
      installation_id: 678,
      private_key: PEM,
    });
    const { fetch, calls } = fakeFetch(() =>
      json(201, { token: "ghs_ISSUED0123456789abcdef", expires_at: "2026-11-28T01:00:00Z" }),
    );

    const prepared = await prepareBoxSecrets({
      config,
      effective: effective(config, "dev-implementer"),
      secretsPath,
      fetch,
      now: NOW,
    });

    expect(prepared.secrets).toEqual([
      {
        env: "GITHUB_TOKEN",
        hosts: ["api.github.com", "github.com"],
        value: "ghs_ISSUED0123456789abcdef",
      },
    ]);
    expect(prepared.realValues).toContain("ghs_ISSUED0123456789abcdef");
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe("https://api.github.com/app/installations/678/access_tokens");
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    const jwt = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload).toEqual({
      iss: 12345,
      iat: NOW.getTime() / 1000 - 60,
      exp: NOW.getTime() / 1000 + 540,
    });
    expect(
      verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url")),
    ).toBe(true);

    // 権限は E(m) の操作の github_permissions の合併（metadata: read は常に）。
    // 開発部の上限が myorg/* なので、リポジトリは名前では絞らない
    expect(JSON.parse(String(call.init.body))).toEqual({
      permissions: {
        contents: "write",
        issues: "read",
        pull_requests: "write",
        metadata: "read",
      },
    });
  });

  it("github_app：E(m) の repo がすべてワイルドカードなしの同じ owner なら、リポジトリを名前で絞る", async () => {
    const config = devConfig({
      groups: {
        dev: {
          name: "開発部",
          box: "vm",
          ceiling: [
            { op: "github.repo.read", params: { repo: ["myorg/app", "myorg/lib"] } },
            { op: "github.git.push", params: { repo: ["myorg/app"] } },
          ],
        },
        sales: { name: "営業部", box: "vm", ceiling: [{ op: "web.read" }] },
      },
      roles: {
        implementer: {
          name: "実装担当",
          allow: [{ op: "github.repo.read" }, { op: "github.git.push" }],
        },
        reviewer: { name: "レビュー担当", allow: [{ op: "github.repo.read" }] },
        researcher: { name: "調査担当", allow: [{ op: "web.read" }] },
      },
    });
    setSecret(secretsPath, "github", "github_app", {
      app_id: 1,
      installation_id: 2,
      private_key: PEM,
    });
    const { fetch, calls } = fakeFetch(() => json(201, { token: "ghs_x0123456789" }));

    await prepareBoxSecrets({
      config,
      effective: effective(config, "dev-implementer"),
      secretsPath,
      fetch,
      now: NOW,
    });

    const body = JSON.parse(String((calls[0] as Call).init.body));
    expect(body.repositories.sort()).toEqual(["app", "lib"]);
    expect(body.permissions).toEqual({
      contents: "write",
      issues: "read",
      pull_requests: "read",
      metadata: "read",
    });
  });

  it("github_app の発行に失敗したら、ステータスだけを含む日本語のエラー（JWT・鍵・応答の本文は出さない）", async () => {
    const config = devConfig();
    setSecret(secretsPath, "github", "github_app", {
      app_id: 1,
      installation_id: 2,
      private_key: PEM,
    });
    const { fetch } = fakeFetch(() => json(401, { message: "Bad credentials ghs_LEAK" }));
    const run = prepareBoxSecrets({
      config,
      effective: effective(config, "dev-implementer"),
      secretsPath,
      fetch,
      now: NOW,
    });
    await expect(run).rejects.toThrow(/GitHub App.*401/);
    await expect(run).rejects.not.toThrow(/ghs_LEAK|PRIVATE KEY|Bearer/);
  });

  it.each([
    ["github_app", { app_id: 1, installation_id: 2, private_key: PEM }, "github", /GitHub App/],
    ["google_oauth", { client_id: "c", client_secret: "s", refresh_token: "r" }, "gmail", /Google/],
  ] as const)(
    "%s の発行先が答えなければ、時間内にあきらめて CredentialError（実行を starting のまま止めない）",
    async (kind, value, id, message) => {
      const config = devConfig({
        groups: {
          dev: {
            name: "開発部",
            box: "vm",
            ceiling: [{ op: "github.repo.read" }, { op: "gmail.draft.create" }],
          },
        },
        roles: {
          implementer: {
            name: "実装",
            allow: [{ op: "github.repo.read" }, { op: "gmail.draft.create" }],
          },
        },
        members: { "dev-implementer": { name: "実装AI", group: "dev", role: "implementer" } },
      });
      setSecret(secretsPath, id, kind, value);
      let aborted = false;
      const hanging = (async (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "TimeoutError"));
          });
        })) as typeof fetch;
      const run = prepareBoxSecrets({
        config,
        effective: effective(config, "dev-implementer").filter((p) => p.op.startsWith(`${id}.`)),
        secretsPath,
        fetch: hanging,
        now: NOW,
        timeoutMs: 50,
      });
      await expect(run).rejects.toBeInstanceOf(CredentialError);
      await expect(run).rejects.toThrow(message);
      await expect(run).rejects.toThrow(/時間内/);
      expect(aborted).toBe(true);
    },
  );

  it("google_oauth：リフレッシュトークンから、トークンのエンドポイントでアクセストークンを発行する", async () => {
    const config = devConfig({
      groups: {
        dev: { name: "開発部", box: "vm", ceiling: [{ op: "github.repo.read" }] },
        sales: {
          name: "営業部",
          box: "vm",
          ceiling: [{ op: "gmail.message.read" }, { op: "web.read" }],
        },
      },
      roles: {
        implementer: { name: "実装担当", allow: [{ op: "github.repo.read" }] },
        reviewer: { name: "レビュー担当", allow: [{ op: "github.repo.read" }] },
        researcher: { name: "調査担当", allow: [{ op: "gmail.message.read" }, { op: "web.read" }] },
      },
    });
    setSecret(secretsPath, "gmail", "google_oauth", {
      client_id: "cid.apps.googleusercontent.com",
      client_secret: "csecret-REAL",
      refresh_token: "1//refresh-REAL",
    });
    const { fetch, calls } = fakeFetch(() =>
      json(200, { access_token: "ya29.ISSUEDaccess", expires_in: 3599, token_type: "Bearer" }),
    );

    const prepared = await prepareBoxSecrets({
      config,
      effective: effective(config, "sales-researcher"),
      secretsPath,
      fetch,
      now: NOW,
    });

    expect(prepared.secrets).toEqual([
      { env: "GMAIL_ACCESS_TOKEN", hosts: ["gmail.googleapis.com"], value: "ya29.ISSUEDaccess" },
    ]);
    const call = calls[0] as Call;
    expect(call.url).toBe("https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(String(call.init.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "refresh_token",
      client_id: "cid.apps.googleusercontent.com",
      client_secret: "csecret-REAL",
      refresh_token: "1//refresh-REAL",
    });
  });
});

describe("GitHub App の権限とリポジトリの絞り方", () => {
  it("リポジトリを絞らない：制限のない項目・ワイルドカード・owner が2つ以上", () => {
    const config = devConfig();
    expect(githubRepositoriesFor(config, effective(config, "dev-implementer"))).toBeNull();
    const fake = (lists: string[][]) => [
      {
        op: "github.repo.read",
        mode: "allow" as const,
        params: { repo: lists },
        source: { kind: "role" as const },
      },
    ];
    expect(githubRepositoriesFor(config, fake([["a/x", "b/y"]]))).toBeNull();
    expect(githubRepositoriesFor(config, fake([["a/*"]]))).toBeNull();
    expect(githubRepositoriesFor(config, fake([["a/x"], ["a/*"]]))).toEqual(["x"]);
    expect(
      githubRepositoriesFor(config, [
        ...fake([["a/x"]]),
        { op: "github.pr.create", mode: "allow", params: {}, source: { kind: "role" } },
      ]),
    ).toBeNull();
  });

  it("権限は write が read に勝ち、metadata: read を必ず含む", () => {
    const config = devConfig();
    expect(
      githubPermissionsFor(config, [
        { op: "github.repo.read", mode: "allow", params: {}, source: { kind: "role" } },
      ]),
    ).toEqual({ contents: "read", issues: "read", pull_requests: "read", metadata: "read" });
    expect(githubPermissionsFor(config, [])).toEqual({ metadata: "read" });
  });

  it("JWT の iss は app_id（数のときは数）", () => {
    const jwt = githubAppJwt("Iv1.abc", PEM, NOW);
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] as string, "base64url").toString());
    expect(payload.iss).toBe("Iv1.abc");
  });
});

describe("5.4.1：Claude のログインのトークン", () => {
  it("anthropic_oauth の資格を読む", () => {
    setSecret(secretsPath, "anthropic", "anthropic_oauth", { token: "sk-ant-oat01-REAL" });
    expect(readAnthropicToken(secretsPath)).toEqual({ ok: true, token: "sk-ant-oat01-REAL" });
  });

  it("無ければ、登録のしかたが分かる日本語のエラー", () => {
    const result = readAnthropicToken(secretsPath);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(
      /aicoop login.*aicoop secret set anthropic --kind anthropic_oauth/,
    );
  });

  it("種類が違えば（static_token など）エラー。値は出さない", () => {
    setSecret(secretsPath, "anthropic", "static_token", { token: "sk-ant-WRONGKIND" });
    const result = readAnthropicToken(secretsPath);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/anthropic_oauth/);
    expect(!result.ok && result.error).not.toMatch(/WRONGKIND/);
  });
});
