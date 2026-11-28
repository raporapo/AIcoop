/**
 * 5.14 の3（準備の画面）を、本物の daemon と、承認アプリと同じ HTTP の流れ（端末の登録 → ログイン →
 * 変更を作る → 承認の意思 → パスキーで署名）で確かめる。
 *
 * - Claude へのログイン：setup-token は、Ink の画面に似せた偽物（`testing/fake-setup-token.mjs`）を node で動かす
 * - 箱のイメージ：`aicoop image build` の代わりに、行を出してイメージの記録を書く偽物を差し込む
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_METADATA_FILE, imageDir } from "@aicoop/box-gondolin";
import { canonicalJson, DEFAULT_COMPANY_NAME } from "@aicoop/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { aicoopPaths } from "../paths.ts";
import { listSecrets, readSecret } from "../secrets/store.ts";
import type { ImageBuildRunner } from "../setup/image-build.ts";
import { spawnPty } from "../setup/pty.ts";
import { type Browser, browser } from "../testing/browser.ts";
import { TEST_COMPANY, writeCompanyFiles } from "../testing/company-config.ts";
import { unusedVmDriver } from "../testing/daemon.ts";
import { fakeStartRun } from "../testing/fake-start-run.ts";
import { apiRequest, type TestRequest } from "../testing/http.ts";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import { type DaemonHandle, startDaemon } from "./start.ts";

const FAKE = join(import.meta.dirname, "..", "testing", "fake-setup-token.mjs");
const TOKEN = `sk-ant-oat01-${"R".repeat(20)}SETUP_SCREEN_REAL_TOKEN_${"y".repeat(40)}`;
const GITHUB_TOKEN = "github_pat_SETUP_SCREEN_GITHUB_TOKEN_0123456789";
const GOOD_CODE = "AbCdEf0123456789_-AbCdEf0123456789#state_0123456789";
const CHANGE_ID = /^x_[0-9A-Z]{26}$/;

let dir: TempDir;
let home: string;
let daemon: DaemonHandle;
let owner: Browser;
let fakeMode = "ok";
let buildLines: ((line: string) => void) | undefined;
let finishBuild: ((code: number) => void) | undefined;
const builds: string[] = [];

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const read = (relative: string) => readFileSync(join(home, relative), "utf8");
const bearer = (req: TestRequest) => apiRequest(daemon.port, { token: daemon.token, ...req });

/** 偽の aicoop image build：行を出し、終わるときにイメージの記録（aicoop-image.json）を書く */
const runImageBuild: ImageBuildRunner = ({ home: h, onLine }) => {
  builds.push(h);
  buildLines = onLine;
  return new Promise((resolve) => {
    finishBuild = (code) => {
      if (code === 0) {
        for (const d of [imageDir(h), imageDir(h, "dev")]) {
          mkdirSync(d, { recursive: true });
          writeFileSync(
            join(d, IMAGE_METADATA_FILE),
            JSON.stringify({ claudeCodeVersion: "2.1.3", packages: ["git", "nodejs", "npm"] }),
          );
        }
      }
      resolve({ exitCode: code });
    };
  });
};

async function signAndSend(type: string, id: string, decision: "approve" | "reject" = "approve") {
  const intent = await owner.post("/approvals/intent", { type, id, decision });
  expect(intent.status, intent.text).toBe(200);
  const response = owner.auth.getAssertion(intent.json.options as never);
  return owner.post("/approvals/assert", { payload: intent.json.payload, response });
}

function everything(): string {
  const parts: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else parts.push(readFileSync(p, "utf8"));
    }
  };
  walk(aicoopPaths(home).logsDir);
  return parts.join("\n");
}

async function auditText(): Promise<string> {
  const res = await bearer({ path: "/audit?limit=1000" });
  return JSON.stringify(res.json);
}

const stepOf = (body: { steps: Array<{ id: string; ok: boolean }> }, id: string) =>
  body.steps.find((s) => s.id === id);

beforeAll(async () => {
  dir = tempDir();
  home = join(dir.path, ".aicoop");
  writeCompanyFiles(home, { aicoop: { company: { ...TEST_COMPANY, name: DEFAULT_COMPANY_NAME } } });
  // 雛形と同じく、部署の上限は your-org のまま
  writeFileSync(join(home, "groups.yaml"), read("groups.yaml").replaceAll("myorg/*", "your-org/*"));
  daemon = await startDaemon({
    home,
    startRun: fakeStartRun({ auto: true }).startRun,
    drivers: { vm: unusedVmDriver },
    port: 0,
    setup: {
      host: {
        platform: "linux",
        arch: "x64",
        which: (command) => `/usr/bin/${command}`,
        canAccess: () => true,
      },
      userHome: dir.path,
      spawnPty: (_argv, env) =>
        spawnPty([process.execPath, FAKE, "setup-token"], {
          ...env,
          FAKE_SETUP_TOKEN_MODE: fakeMode,
          FAKE_SETUP_TOKEN_VALUE: TOKEN,
        }),
      runImageBuild,
    },
  });
  owner = browser(daemon.port);
  await owner.pair(daemon.token, "オーナーのPC");
  const login = await owner.login();
  expect(login.status, login.text).toBe(200);
}, 30_000);

afterAll(async () => {
  finishBuild?.(1);
  await daemon?.stop();
  dir?.cleanup();
});

describe("5.14 の6：準備・イメージの道は、PC のブラウザのセッションだけ", () => {
  const calls: TestRequest[] = [
    { path: "/setup" },
    { method: "POST", path: "/setup/company", body: { name: "サンプル商会" } },
    { method: "POST", path: "/setup/github/repositories", body: { repositories: ["a/b"] } },
    { method: "POST", path: "/setup/claude-login", body: {} },
    {
      method: "POST",
      path: "/setup/claude-login/00000000-0000-4000-8000-000000000000/code",
      body: { code: GOOD_CODE },
    },
    { method: "POST", path: "/images/build", body: {} },
    { path: "/images/build" },
  ];

  it("Bearer トークンで呼ぶと 401（何も起こさない）", async () => {
    const before = read("aicoop.yaml");
    for (const req of calls) {
      const res = await bearer(req);
      expect(res.status, `${req.method ?? "GET"} ${req.path}`).toBe(401);
      expect(res.json.error).toBe("unauthorized");
    }
    expect(read("aicoop.yaml")).toBe(before);
    expect(builds).toHaveLength(0);
  });

  it("Origin が違う POST・Origin のない POST・クッキーのない呼び出しは拒否される", async () => {
    for (const req of calls.filter((r) => r.method === "POST")) {
      const other = await owner.post(req.path, req.body, { origin: "http://evil.example" });
      expect(other.status, req.path).toBe(403);
      const none = await owner.post(req.path, req.body, { origin: null });
      expect(none.status, req.path).toBe(403);
    }
    for (const req of calls) {
      const res =
        req.method === "POST"
          ? await owner.post(req.path, req.body, { cookie: null })
          : await owner.get(req.path, { cookie: null });
      expect(res.status, req.path).toBe(401);
    }
    expect(builds).toHaveLength(0);
  });
});

describe("5.14 の3：準備の確認を、段階に分けて返す", () => {
  it("会社の名前 → Claude → GitHub → イメージ の順。済んでいないものに印がない", async () => {
    const res = await owner.get("/setup");
    expect(res.status, res.text).toBe(200);
    expect(res.json.steps.map((s: { id: string }) => s.id)).toEqual([
      "company",
      "claude",
      "github",
      "image",
    ]);
    expect(res.json.ready).toBe(false);
    expect(stepOf(res.json, "company")?.ok).toBe(false);
    expect(stepOf(res.json, "claude")?.ok).toBe(false);
    expect(stepOf(res.json, "github")?.ok).toBe(false);
    expect(res.json.github).toMatchObject({
      placeholder: true,
      secret_kind: null,
      repositories: [],
    });
    expect(res.json.company).toEqual({ name: DEFAULT_COMPANY_NAME });
    // 制御サーバーの項目（daemon・daemon:reload）は出さない（ここで動いているので）
    expect(JSON.stringify(res.json)).not.toContain('"daemon');
  });
});

describe("5.14 の3の1：会社の名前", () => {
  it("名前を変える設定の変更を作り、署名してから書く（コメントと並びはそのまま）", async () => {
    const before = read("aicoop.yaml");
    const res = await owner.post("/setup/company", { name: "サンプル商会" });
    expect(res.status, res.text).toBe(201);
    expect(res.json.id).toMatch(CHANGE_ID);
    expect(res.json.summary.files[0].path).toBe("aicoop.yaml");
    expect(res.json.summary.files[0].before_sha256).toBe(sha(before));
    // 署名するまでは書かない
    expect(read("aicoop.yaml")).toBe(before);
    expect((await owner.get("/setup")).json.company.name).toBe(DEFAULT_COMPANY_NAME);
    const signed = await signAndSend("config_change", res.json.id);
    expect(signed.status, signed.text).toBe(200);
    expect((parse(read("aicoop.yaml")) as { company: { name: string } }).company.name).toBe(
      "サンプル商会",
    );
    const after = await owner.get("/setup");
    expect(after.json.company.name).toBe("サンプル商会");
    expect(stepOf(after.json, "company")?.ok).toBe(true);
  });

  it.each([
    ["空", { name: "   " }],
    ["改行", { name: "a\nb" }],
    ["制御文字", { name: "a\x1bb" }],
    ["長すぎる", { name: "あ".repeat(101) }],
    ["文字列でない", { name: 1 }],
    ["知らないキー", { name: "x", sk_ant_oat01_pasted_here: 1 }],
  ])("%s の名前は 400（変更を作らない）", async (_, body) => {
    const before = read("aicoop.yaml");
    const res = await owner.post("/setup/company", body);
    expect(res.status, res.text).toBe(400);
    expect(res.json.error).toBe("invalid_input");
    expect(res.text).not.toContain("sk_ant_oat01_pasted_here");
    expect(read("aicoop.yaml")).toBe(before);
  });
});

describe("5.14 の3の3：GitHub（資格とリポジトリ）", () => {
  it.each([
    ["*/*"],
    ["../x"],
    ["owner/re po"],
    [" owner/repo"],
    ["owner/repo/extra"],
    ["your-org/*"],
    [""],
  ])("リポジトリ %j は 400（変更を作らない）", async (repo) => {
    const before = read("groups.yaml");
    const res = await owner.post("/setup/github/repositories", { repositories: [repo] });
    expect(res.status, res.text).toBe(400);
    expect(read("groups.yaml")).toBe(before);
  });

  it("配列でない・空・多すぎるものは 400", async () => {
    for (const repositories of [
      [],
      "raporapo/*",
      Array.from({ length: 21 }, (_, i) => `a/r${i}`),
    ]) {
      const res = await owner.post("/setup/github/repositories", { repositories });
      expect(res.status, JSON.stringify(repositories)).toBe(400);
    }
  });

  it("your-org を書き換える設定の変更を作り、署名するまで書かない。署名したら書いて読み直す", async () => {
    const before = read("groups.yaml");
    const res = await owner.post("/setup/github/repositories", {
      repositories: ["raporapo/*", "me/app", "me/app"],
    });
    expect(res.status, res.text).toBe(201);
    expect(res.json.summary.files[0].diff).toContain('+            - "raporapo/*"');
    expect(read("groups.yaml")).toBe(before);
    // 取り消すと書かない
    const rejected = await signAndSend("config_change", res.json.id, "reject");
    expect(rejected.status, rejected.text).toBe(200);
    expect(read("groups.yaml")).toBe(before);

    const again = await owner.post("/setup/github/repositories", {
      repositories: ["raporapo/*", "me/app"],
    });
    const signed = await signAndSend("config_change", again.json.id);
    expect(signed.status, signed.text).toBe(200);
    const groups = parse(read("groups.yaml")) as {
      groups: { dev: { ceiling: Array<{ params?: { repo?: string[] } }> } };
    };
    expect(groups.groups.dev.ceiling[0]?.params?.repo).toEqual(["raporapo/*", "me/app"]);
    const setup = await owner.get("/setup");
    expect(setup.json.github).toMatchObject({
      placeholder: false,
      repositories: ["me/app", "raporapo/*"],
    });
    // もう your-org がないので、準備の画面からは作らない（設定の画面で書き換える）
    const more = await owner.post("/setup/github/repositories", { repositories: ["x/y"] });
    expect(more.status).toBe(409);
  });

  it("GitHub の資格は、資格の変更（署名を待つ）で登録する。署名するまで変わらない。応答に中身を出さない", async () => {
    const res = await owner.post("/secrets/changes", {
      id: "github",
      kind: "static_token",
      value: GITHUB_TOKEN,
    });
    expect(res.status, res.text).toBe(201);
    expect(res.text).not.toContain(GITHUB_TOKEN);
    expect(readSecret(aicoopPaths(home).secrets, "github")).toBeUndefined();
    const signed = await signAndSend("secret_change", res.json.id);
    expect(signed.status, signed.text).toBe(200);
    const setup = await owner.get("/setup");
    expect(setup.json.github.secret_kind).toBe("static_token");
    expect(stepOf(setup.json, "github")?.ok).toBe(true);
    expect(setup.text).not.toContain(GITHUB_TOKEN);
  });
});

describe("5.14 の3の2：Claude へのログイン", () => {
  it("始めると URL を返し、2つめは始めない。壊れたコードは渡さない", async () => {
    fakeMode = "ok";
    const started = await owner.post("/setup/claude-login", {});
    expect(started.status, started.text).toBe(201);
    expect(started.json.state).toBe("waiting_code");
    expect(started.json.url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?/);

    const second = await owner.post("/setup/claude-login", {});
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("invalid_state");

    for (const code of ["abc", "a b c d e f g h", `${GOOD_CODE}\x1b[A`, "x".repeat(600)]) {
      const bad = await owner.post(`/setup/claude-login/${started.json.id}/code`, { code });
      expect(bad.status, code).toBe(400);
    }
    const extra = await owner.post(`/setup/claude-login/${started.json.id}/code`, {
      code: GOOD_CODE,
      token: "x",
    });
    expect(extra.status).toBe(400);
    expect((await owner.get("/setup")).json.claude_login.state).toBe("waiting_code");

    // コードを渡すと、トークンから資格の変更（署名を待つ）を作る。ID と要約だけを返す
    const done = await owner.post(`/setup/claude-login/${started.json.id}/code`, {
      code: GOOD_CODE,
    });
    expect(done.status, done.text).toBe(200);
    expect(done.json.state).toBe("done");
    expect(done.json.change.id).toMatch(CHANGE_ID);
    expect(done.json.change.summary).toEqual({
      id: "anthropic",
      kind: "anthropic_oauth",
      action: "create",
    });
    expect(done.text).not.toContain("SETUP_SCREEN_REAL_TOKEN");

    // 署名するまでは、資格は変わらない
    expect(readSecret(aicoopPaths(home).secrets, "anthropic")).toBeUndefined();
    const setup = await owner.get("/setup");
    expect(stepOf(setup.json, "claude")?.ok).toBe(false);
    expect(setup.text).not.toContain("SETUP_SCREEN_REAL_TOKEN");

    // 承認アプリと同じく、表示した要約のハッシュで署名する
    const intent = await owner.post("/approvals/intent", {
      type: "secret_change",
      id: done.json.change.id,
      decision: "approve",
    });
    expect(intent.json.payload.summary_sha256).toBe(sha(canonicalJson(done.json.change.summary)));
    const signed = await signAndSend("secret_change", done.json.change.id);
    expect(signed.status, signed.text).toBe(200);
    expect(readSecret(aicoopPaths(home).secrets, "anthropic")).toMatchObject({
      kind: "anthropic_oauth",
      value: { token: TOKEN },
    });
    expect(stepOf((await owner.get("/setup")).json, "claude")?.ok).toBe(true);

    // トークン・コードは、ログ・監査ログに出さない
    const logs = everything();
    expect(logs).not.toContain("SETUP_SCREEN_REAL_TOKEN");
    expect(logs).not.toContain(GOOD_CODE);
    expect(logs).not.toContain(GITHUB_TOKEN);
    const audit = await auditText();
    expect(audit).not.toContain("SETUP_SCREEN_REAL_TOKEN");
    expect(audit).toContain("secret.change");
  });

  it.each([["bad-exit"], ["no-token"], ["token-exit1"]])(
    "setup-token が %s なら 422 で失敗し、資格の変更を作らない",
    async (mode) => {
      fakeMode = mode;
      const before = JSON.stringify(listSecrets(aicoopPaths(home).secrets));
      const started = await owner.post("/setup/claude-login", {});
      expect(started.status, started.text).toBe(201);
      const res = await owner.post(`/setup/claude-login/${started.json.id}/code`, {
        code: GOOD_CODE,
      });
      expect(res.status, res.text).toBe(422);
      expect(res.json.error).toBe("login_failed");
      expect(res.text).not.toContain("SETUP_SCREEN_REAL_TOKEN");
      const setup = await owner.get("/setup");
      expect(setup.json.claude_login).toMatchObject({ state: "failed", change: null });
      expect(JSON.stringify(listSecrets(aicoopPaths(home).secrets))).toBe(before);
      expect(everything()).not.toContain("SETUP_SCREEN_REAL_TOKEN");
    },
  );

  it("取り消せる。取り消したあとのコードは受けない", async () => {
    fakeMode = "hang";
    const started = await owner.post("/setup/claude-login", {});
    const cancelled = await owner.post(`/setup/claude-login/${started.json.id}/cancel`, {});
    expect(cancelled.status, cancelled.text).toBe(200);
    expect(cancelled.json.state).toBe("cancelled");
    const late = await owner.post(`/setup/claude-login/${started.json.id}/code`, {
      code: GOOD_CODE,
    });
    expect(late.status).toBe(409);
  });

  it("ない ID のログインには渡さない（404）", async () => {
    const res = await owner.post("/setup/claude-login/not-an-id/code", { code: GOOD_CODE });
    expect(res.status).toBe(404);
  });
});

describe("5.14 の3の4：箱のイメージ", () => {
  it("作り始めて進み具合を返し、二重には起こさない。終わったら済み", async () => {
    expect((await owner.get("/images/build")).json).toEqual({ build: null });
    const started = await owner.post("/images/build", {});
    expect(started.status, started.text).toBe(202);
    expect(started.json.state).toBe("running");
    expect(builds).toEqual([home]);

    const twice = await owner.post("/images/build", {});
    expect(twice.status).toBe(409);
    expect(twice.json.error).toBe("invalid_state");
    expect(builds).toHaveLength(1);

    buildLines?.("[1/2] ベースのイメージを作っています…");
    buildLines?.("Building guest assets for x86_64 (alpine)");
    const progress = await owner.get("/images/build");
    expect(progress.json.build.stage).toMatchObject({ index: 1, total: 2 });
    expect(progress.json.build.lines).toContain("Building guest assets for x86_64 (alpine)");

    finishBuild?.(0);
    await new Promise((r) => setTimeout(r, 20));
    const done = await owner.get("/setup");
    expect(done.json.image_build.state).toBe("succeeded");
    expect(stepOf(done.json, "image")?.ok).toBe(true);
    expect(done.json.ready).toBe(true);
  });
});
