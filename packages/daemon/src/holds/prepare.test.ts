import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import type { CompanyConfig } from "@aicoop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSecret } from "../secrets/store.ts";
import { loadTestCompany, P2_FILES } from "../testing/company-config.ts";
import { base64url, type FakeServices, fakeServices, rfc2822 } from "../testing/fake-services.ts";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import type { SavedHoldRequest } from "./hold-file.ts";
import { prepareHold } from "./prepare.ts";

const NOW = new Date("2026-11-28T00:00:00.000Z");
let tmp: TempDir;
let home: string;
let secretsPath: string;
let config: CompanyConfig;
let services: FakeServices;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.path, ".aicoop");
  secretsPath = join(home, "secrets.json");
  config = loadTestCompany(home, P2_FILES);
  services = fakeServices();
  setSecret(secretsPath, "gmail", "google_oauth", {
    client_id: "cid",
    client_secret: "csecret",
    refresh_token: "1//refresh-REAL",
  });
  setSecret(secretsPath, "github", "static_token", { token: "github_pat_REALTOKEN0123" });
});
afterEach(() => tmp.cleanup());

const enc = (text: string) => new TextEncoder().encode(text);

function saved(over: Partial<SavedHoldRequest> = {}): SavedHoldRequest {
  return {
    method: "POST",
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    headers: { "content-type": "application/json" },
    body: new Uint8Array(),
    auth: { header: "authorization", template: "Bearer GONDOLIN_SECRET_****" },
    ...over,
  };
}

function prepare(
  operationId: string,
  request: SavedHoldRequest,
  params: Record<string, string> = {},
  memberId = "sales-mailer",
) {
  const operation = config.catalog.getOperation(operationId);
  if (operation === undefined) throw new Error(operationId);
  return prepareHold({
    config,
    operation,
    params,
    memberId,
    request,
    secretsPath,
    fetch: services.fetch,
    now: NOW,
  });
}

describe("5.7.1 の2：保留の要約（gmail_message）", () => {
  it("messages/send：本文の raw（base64url の RFC 2822）から、宛先・件名・本文のテキストを読む", async () => {
    const mail = rfc2822({
      to: "yamada@customer.example",
      cc: "c@customer.example",
      bcc: "boss@example.co.jp",
      subject: "お見積りのご案内",
      body: "山田様\r\n\r\nお見積りをお送りします。",
    });
    const body = enc(JSON.stringify({ raw: base64url(mail), threadId: "thread-9" }));
    const result = await prepare("gmail.message.send", saved({ body }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toEqual({
      kind: "gmail_message",
      operation: "gmail.message.send",
      member_id: "sales-mailer",
      source: "message",
      draft_id: null,
      from: ["sales@example.co.jp"],
      to: ["yamada@customer.example"],
      cc: ["c@customer.example"],
      bcc: ["boss@example.co.jp"],
      subject: ["お見積りのご案内"],
      body_kind: "text",
      body_text: "山田様\n\nお見積りをお送りします。",
      body_truncated: false,
      attachments: [],
      warnings: [],
    });
    // 送るリクエストは変えない
    expect(result.request.body).toEqual(body);
    // 資格は使わない
    expect(services.calls).toEqual([]);
  });

  it("本文のテキストは先頭4000文字まで", async () => {
    const mail = rfc2822({ to: "a@example.com", subject: "s", body: "あ".repeat(5000) });
    const result = await prepare(
      "gmail.message.send",
      saved({ body: enc(JSON.stringify({ raw: base64url(mail) })) }),
    );
    if (!result.ok) throw new Error("ok ではない");
    const summary = result.summary as { body_text: string; body_truncated: boolean };
    expect([...summary.body_text]).toHaveLength(4000);
    expect(summary.body_truncated).toBe(true);
  });

  it("drafts/send：本物の資格で下書きを取ってきて要約し、送るリクエストを、その時点の中身の messages/send に固める", async () => {
    services.drafts.set("r-123", {
      mail: rfc2822({ to: "client@example.com", subject: "ご挨拶", body: "よろしくお願いします" }),
      threadId: "thread-7",
    });
    const result = await prepare(
      "gmail.message.send",
      saved({
        url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
        body: enc(JSON.stringify({ id: "r-123" })),
      }),
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.summary).toMatchObject({
      kind: "gmail_message",
      source: "draft",
      draft_id: "r-123",
      to: ["client@example.com"],
      subject: ["ご挨拶"],
      body_text: "よろしくお願いします",
    });
    // 下書きは本物の資格（Google のアクセストークン）で取る
    const get = services.calls.find((c) => c.url.includes("/drafts/r-123"));
    expect(get?.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts/r-123?format=raw");
    expect(get?.headers.authorization).toBe(`Bearer ${services.issued[0]}`);
    // 承認のあとで下書きを書き換えられても、要約と同じ中身を送る
    expect(result.request.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect(result.request.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(result.request.body))).toEqual({
      raw: base64url(services.drafts.get("r-123")?.mail ?? ""),
      threadId: "thread-7",
    });
    expect(result.request.auth).toEqual({
      header: "authorization",
      template: "Bearer GONDOLIN_SECRET_****",
    });
  });

  it("拒否：下書きを取れない（無い・通信できない・ID の形が違う）なら、保留にしない（ok: false）", async () => {
    const draftsSend = (body: unknown) =>
      saved({
        url: "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send",
        body: enc(JSON.stringify(body)),
      });
    expect((await prepare("gmail.message.send", draftsSend({ id: "missing" }))).ok).toBe(false);
    expect((await prepare("gmail.message.send", draftsSend({ id: "../x" }))).ok).toBe(false);
    expect((await prepare("gmail.message.send", draftsSend({}))).ok).toBe(false);
    services.offline = true;
    services.drafts.set("r-1", { mail: rfc2822({ to: "a@b.c", subject: "s", body: "b" }) });
    expect((await prepare("gmail.message.send", draftsSend({ id: "r-1" }))).ok).toBe(false);
  });

  it("raw が読めなければ、指定なしの要約（メソッド・URL・本文の先頭2KB）に警告を付ける", async () => {
    const result = await prepare("gmail.message.send", saved({ body: enc("not json") }));
    if (!result.ok) throw new Error("ok ではない");
    expect(result.summary).toMatchObject({
      kind: "default",
      method: "POST",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      body_head: "not json",
    });
    expect(result.summary.warnings[0]).toMatch(/メール/);
  });
});

describe("5.7.1 の2：保留の要約（指定なし）", () => {
  it("メソッド・URL・本文の先頭2KB。UTF-8 として読めなければ base64", async () => {
    const custom = loadTestCompany(home, {
      ...P2_FILES,
      groups: {
        ...P2_FILES.groups,
        dev: {
          ...(P2_FILES.groups?.dev as object),
          ceiling: [{ op: "github.pr.create", mode: "hold" }],
        },
      },
    });
    config = custom;
    const text = "x".repeat(3000);
    const result = await prepare(
      "github.pr.create",
      saved({ url: "https://api.github.com/repos/myorg/app/pulls", body: enc(text) }),
      { repo: "myorg/app" },
      "dev-implementer",
    );
    if (!result.ok) throw new Error("ok ではない");
    expect(result.summary).toEqual({
      kind: "default",
      operation: "github.pr.create",
      member_id: "dev-implementer",
      method: "POST",
      url: "https://api.github.com/repos/myorg/app/pulls",
      body_bytes: 3000,
      body_head: "x".repeat(2048),
      body_head_encoding: "text",
      body_truncated: true,
      warnings: [],
    });
    const binary = await prepare(
      "github.pr.create",
      saved({
        url: "https://api.github.com/repos/myorg/app/pulls",
        body: new Uint8Array([0xff, 0xfe]),
      }),
      { repo: "myorg/app" },
      "dev-implementer",
    );
    if (!binary.ok) throw new Error("ok ではない");
    expect(binary.summary).toMatchObject({ body_head: "//4=", body_head_encoding: "base64" });
  });
});

describe("5.7.1 の2：保留の要約（github_pr_merge）", () => {
  const merge = (body: unknown) =>
    saved({
      method: "PUT",
      url: "https://api.github.com/repos/myorg/app/pulls/7/merge",
      body: enc(body === undefined ? "" : JSON.stringify(body)),
    });

  beforeEach(() => {
    services.pulls.set("myorg/app#7", {
      title: "ログイン画面を直す",
      changed_files: 3,
      head: { sha: "a".repeat(40), ref: "fix-login" },
      base: { ref: "main" },
    });
  });

  it("リポジトリ・PR 番号と、本物の資格で取った PR のタイトルと変更ファイル数。sha を付けて、見たときの head でだけマージさせる", async () => {
    const result = await prepare(
      "github.pr.merge",
      merge({ merge_method: "squash" }),
      { repo: "myorg/app" },
      "dev-implementer",
    );
    if (!result.ok) throw new Error(result.message);
    expect(result.summary).toEqual({
      kind: "github_pr_merge",
      operation: "github.pr.merge",
      member_id: "dev-implementer",
      repo: "myorg/app",
      number: 7,
      title: "ログイン画面を直す",
      changed_files: 3,
      head_sha: "a".repeat(40),
      head_ref: "fix-login",
      base_ref: "main",
      merge_method: "squash",
      warnings: [],
    });
    const get = services.calls.find((c) => c.url.endsWith("/pulls/7"));
    expect(get?.headers.authorization).toBe("Bearer github_pat_REALTOKEN0123");
    expect(JSON.parse(new TextDecoder().decode(result.request.body))).toEqual({
      merge_method: "squash",
      sha: "a".repeat(40),
    });
  });

  it("GitHub App なら、PR を読むトークンは、そのリポジトリだけ・読む権限だけにする", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    setSecret(secretsPath, "github", "github_app", {
      app_id: 1,
      installation_id: 2,
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    const result = await prepare(
      "github.pr.merge",
      merge({}),
      { repo: "myorg/app" },
      "dev-implementer",
    );
    expect(result.ok).toBe(true);
    const issue = services.calls.find((c) => c.url.endsWith("/access_tokens"));
    expect(JSON.parse(issue?.body ?? "null")).toEqual({
      permissions: { pull_requests: "read", metadata: "read" },
      repositories: ["app"],
    });
  });

  it("本文に sha が書いてあれば変えず、いまの head と違えば警告する", async () => {
    const result = await prepare(
      "github.pr.merge",
      merge({ sha: "b".repeat(40) }),
      { repo: "myorg/app" },
      "dev-implementer",
    );
    if (!result.ok) throw new Error(result.message);
    expect(JSON.parse(new TextDecoder().decode(result.request.body))).toEqual({
      sha: "b".repeat(40),
    });
    expect(result.summary.warnings[0]).toMatch(/sha/);
  });

  it("本文が空でも、sha を付けた JSON にする", async () => {
    const result = await prepare(
      "github.pr.merge",
      merge(undefined),
      { repo: "myorg/app" },
      "dev-implementer",
    );
    if (!result.ok) throw new Error(result.message);
    expect(JSON.parse(new TextDecoder().decode(result.request.body))).toEqual({
      sha: "a".repeat(40),
    });
    expect(result.request.headers["content-type"]).toBe("application/json");
  });

  it("拒否：PR を取れない（無い・通信できない）・本文が JSON でないなら、保留にしない", async () => {
    const missing = saved({
      method: "PUT",
      url: "https://api.github.com/repos/myorg/app/pulls/8/merge",
      body: enc("{}"),
    });
    expect(
      (await prepare("github.pr.merge", missing, { repo: "myorg/app" }, "dev-implementer")).ok,
    ).toBe(false);
    expect(
      (
        await prepare(
          "github.pr.merge",
          saved({
            method: "PUT",
            url: "https://api.github.com/repos/myorg/app/pulls/7/merge",
            body: enc("["),
          }),
          { repo: "myorg/app" },
          "dev-implementer",
        )
      ).ok,
    ).toBe(false);
    services.offline = true;
    expect(
      (await prepare("github.pr.merge", merge({}), { repo: "myorg/app" }, "dev-implementer")).ok,
    ).toBe(false);
  });
});
