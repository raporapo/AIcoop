/**
 * 5.14 の4・5・6 の受け入れ条件（設定の画面と資格の画面）を、本物の daemon と、承認アプリと同じ HTTP の流れ
 * （端末の登録 → ログイン → 変更を作る → 承認の意思 → パスキーで署名）で確かめる。
 *
 * - 要約のハッシュ：承認アプリは、変更を作ったときの応答の summary を表示し、その正規化JSON の SHA-256 が
 *   payload の summary_sha256 と合わなければ署名しない（5.8）。daemon の値と一致することを、本物の応答で確かめる
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "@aicoop/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { aicoopPaths } from "../paths.ts";
import { listSecrets, readSecret, setSecret } from "../secrets/store.ts";
import { type Browser, browser } from "../testing/browser.ts";
import { DEFAULT_GROUPS, TEST_COMPANY, writeCompanyFiles } from "../testing/company-config.ts";
import { unusedVmDriver } from "../testing/daemon.ts";
import { fakeStartRun } from "../testing/fake-start-run.ts";
import { apiRequest, type TestRequest, type TestResponse } from "../testing/http.ts";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import { type DaemonHandle, startDaemon } from "./start.ts";

const SECRET_VALUE = "ghp_SETTINGS_SCREEN_REAL_TOKEN_0123456789";
const OLD_SECRET = "ghp_OLD_TOKEN_abcdefghijklmnop";
const CHANGE_ID = /^x_[0-9A-Z]{26}$/;
const MINUTE = 60_000;

let dir: TempDir;
let home: string;
let daemon: DaemonHandle;
let owner: Browser;
let offset = 0;

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const read = (relative: string) => readFileSync(join(home, relative), "utf8");
const bearer = (req: TestRequest) => apiRequest(daemon.port, { token: daemon.token, ...req });

/** 承認アプリと同じやり方で、表示した要約から summary_sha256 を作る（5.8 の3の3） */
const shownSha = (summary: unknown) => sha(canonicalJson(summary));

async function createChange(
  files: Array<{ path: string; content: string; base_sha256: string | null }>,
): Promise<TestResponse> {
  return owner.post("/config/changes", { files });
}

async function editFile(path: string, edit: (text: string) => string) {
  const got = await owner.get(`/config/files/${path}`);
  expect(got.status, got.text).toBe(200);
  return createChange([
    { path, content: edit(got.json.content as string), base_sha256: got.json.sha256 as string },
  ]);
}

async function intent(type: string, id: string, decision: "approve" | "reject" = "approve") {
  const res = await owner.post("/approvals/intent", { type, id, decision });
  expect(res.status, res.text).toBe(200);
  return res.json as { payload: Record<string, unknown>; options: Record<string, unknown> };
}

async function signAndSend(type: string, id: string, decision: "approve" | "reject" = "approve") {
  const i = await intent(type, id, decision);
  const response = owner.auth.getAssertion(i.options as never);
  return owner.post("/approvals/assert", { payload: i.payload, response });
}

async function auditOf(kind: string) {
  const res = await bearer({ path: "/audit?limit=1000" });
  return (res.json.entries as Array<{ kind: string; data: unknown; subject: string }>).filter(
    (e) => e.kind === kind,
  );
}

function allLogs(): string {
  const logs = aicoopPaths(home).logsDir;
  if (!existsSync(logs)) return "";
  let text = "";
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else text += readFileSync(p, "utf8");
    }
  };
  walk(logs);
  return text;
}

beforeAll(async () => {
  dir = tempDir();
  home = join(dir.path, ".aicoop");
  writeCompanyFiles(home);
  setSecret(aicoopPaths(home).secrets, "github", "static_token", { token: OLD_SECRET });
  daemon = await startDaemon({
    home,
    startRun: fakeStartRun({ auto: true }).startRun,
    drivers: { vm: unusedVmDriver },
    port: 0,
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

describe("5.14 の6：設定・資格の道は、PC のブラウザのセッションだけ", () => {
  it("5.14 の受け入れ条件：Bearer トークンで設定・資格の道を呼ぶと拒否される（何も変わらない）", async () => {
    const before = read("groups.yaml");
    const calls: TestRequest[] = [
      { path: "/config/files" },
      { path: "/config/files/groups.yaml" },
      {
        method: "POST",
        path: "/config/changes",
        body: {
          files: [{ path: "groups.yaml", content: "groups: {}\n", base_sha256: sha(before) }],
        },
      },
      { path: "/secrets" },
      {
        method: "POST",
        path: "/secrets/changes",
        body: { id: "github", kind: "static_token", value: { token: SECRET_VALUE } },
      },
    ];
    for (const req of calls) {
      const res = await bearer(req);
      expect(res.status, `${req.method ?? "GET"} ${req.path}`).toBe(401);
      expect(res.json.error).toBe("unauthorized");
    }
    expect(read("groups.yaml")).toBe(before);
    expect(readSecret(aicoopPaths(home).secrets, "github")?.value).toEqual({ token: OLD_SECRET });
  });

  it("Origin が違う POST・クッキーのない呼び出しは拒否される", async () => {
    const body = { files: [{ path: "groups.yaml", content: "x: 1\n", base_sha256: null }] };
    const other = await owner.post("/config/changes", body, { origin: "http://evil.example" });
    expect(other.status).toBe(403);
    expect(other.json.error).toBe("forbidden_origin");
    const noOrigin = await owner.post(
      "/secrets/changes",
      { id: "x", delete: true },
      { origin: null },
    );
    expect(noOrigin.status).toBe(403);
    const anonymous = await owner.get("/config/files", { cookie: null });
    expect(anonymous.status).toBe(401);
  });
});

describe("5.14 の4の1：設定のファイルの一覧と中身", () => {
  it("一覧は 6.1 の yaml と prompts の md だけ。secrets.json・state.db は出さない", async () => {
    const res = await owner.get("/config/files");
    expect(res.status, res.text).toBe(200);
    const paths = (res.json.files as Array<{ path: string }>).map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["aicoop.yaml", "groups.yaml", "prompts/company.md"]),
    );
    expect(paths).not.toContain("secrets.json");
    expect(paths).not.toContain("state.db");
    expect(paths.every((p) => /\.(yaml|md)$/.test(p))).toBe(true);
    const groups = (res.json.files as Array<Record<string, unknown>>).find(
      (f) => f.path === "groups.yaml",
    );
    expect(groups).toEqual({
      path: "groups.yaml",
      size: statSync(join(home, "groups.yaml")).size,
      sha256: sha(read("groups.yaml")),
      modified_at: expect.any(String),
    });
  });

  it("中身と SHA-256 を返す", async () => {
    const res = await owner.get("/config/files/prompts/company.md");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({
      path: "prompts/company.md",
      content: read("prompts/company.md"),
      sha256: sha(read("prompts/company.md")),
    });
  });

  it.each([
    "secrets.json",
    "state.db",
    "runtime/api_token",
    "..%2fsecrets.json",
    "%2e%2e/secrets.json",
    "prompts/%2e%2e/%2e%2e/secrets.json",
    "prompts%2f..%2f..%2fsecrets.json",
    "prompts/..%5c..%5csecrets.json",
    "%2fetc%2fpasswd",
    "C:%5cWindows%5cwin.ini",
    "prompts/company.md%00.yaml",
  ])("5.14 の受け入れ条件：%s は読めない", async (path) => {
    const res = await owner.get(`/config/files/${path}`);
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("secrets");
    expect(res.text).not.toContain(OLD_SECRET);
  });

  it("../ を含むパスは読めない（ほかの道にもならない）", async () => {
    const res = await apiRequest(daemon.port, {
      path: "/api/v1/config/files/../../secrets.json",
      raw: true,
      token: null,
      host: `localhost:${daemon.port}`,
      headers: { cookie: `aicoop_session=${owner.session}` },
    });
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(OLD_SECRET);
  });

  it("シンボリックリンクは一覧に出さず、読めず、変更も作れない", async (ctx) => {
    try {
      symlinkSync(join(home, "secrets.json"), join(home, "prompts", "link.md"), "file");
    } catch {
      ctx.skip();
    }
    try {
      const list = await owner.get("/config/files");
      expect((list.json.files as Array<{ path: string }>).map((f) => f.path)).not.toContain(
        "prompts/link.md",
      );
      const got = await owner.get("/config/files/prompts/link.md");
      expect(got.status).toBe(404);
      expect(got.text).not.toContain(OLD_SECRET);
      const change = await createChange([
        { path: "prompts/link.md", content: "上書き", base_sha256: null },
      ]);
      expect(change.status).toBe(400);
      expect(readSecret(aicoopPaths(home).secrets, "github")?.value).toEqual({
        token: OLD_SECRET,
      });
    } finally {
      // prompts の中のシンボリックリンクは、設定のエラー（E-013）になるので片付ける
      rmSync(join(home, "prompts", "link.md"), { force: true });
    }
  });
});

describe("5.14 の4：設定の変更を作り、署名してから保存する", () => {
  it("変更を作る：要約はファイルごとの path・前後の SHA-256・差分。署名するまでファイルは変わらない", async () => {
    const before = read("aicoop.yaml");
    const res = await editFile("aicoop.yaml", (t) => t.replace(TEST_COMPANY.name, "新しい商会"));
    expect(res.status, res.text).toBe(201);
    expect(res.json.id).toMatch(CHANGE_ID);
    const after = before.replace(TEST_COMPANY.name, "新しい商会");
    expect(res.json.summary).toEqual({
      files: [
        {
          path: "aicoop.yaml",
          before_sha256: sha(before),
          after_sha256: sha(after),
          diff: expect.stringContaining("+++ b/aicoop.yaml"),
        },
      ],
    });
    expect(res.json.summary.files[0].diff).toContain(`-  name: ${TEST_COMPANY.name}`);
    expect(res.json.summary.files[0].diff).toContain("+  name: 新しい商会");
    expect(res.json.warnings).toEqual([]);
    // 5.14 の受け入れ条件：署名のない変更では、設定は変わらない
    expect(read("aicoop.yaml")).toBe(before);
  });

  it("5.14 の4の3：署名が通ったら書き、読み直す（aicoop reload と同じ）。監査ログに config.change（中身は書かない）", async () => {
    const before = read("aicoop.yaml");
    const res = await editFile("aicoop.yaml", (t) => t.replace(TEST_COMPANY.name, "署名した商会"));
    expect(res.status, res.text).toBe(201);
    const id = res.json.id as string;

    const i = await intent("config_change", id);
    // 5.8：daemon の summary_sha256 と、承認アプリが表示した要約から作る値が一致する
    expect(i.payload.summary_sha256).toBe(shownSha(res.json.summary));
    expect(i.payload.type).toBe("config_change");
    const response = owner.auth.getAssertion(i.options as never);
    const sent = await owner.post("/approvals/assert", { payload: i.payload, response });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.json.subject_status).toBe("applied");

    expect(read("aicoop.yaml")).toBe(before.replace(TEST_COMPANY.name, "署名した商会"));
    const status = await bearer({ path: "/status" });
    expect(status.json.company.name).toBe("署名した商会");

    const changes = await auditOf("config.change");
    const last = changes[changes.length - 1];
    expect(last?.data).toEqual({
      change: id,
      files: [
        {
          path: "aicoop.yaml",
          before_sha256: sha(before),
          after_sha256: sha(read("aicoop.yaml")),
        },
      ],
    });
    expect(JSON.stringify(last)).not.toContain("署名した商会");
    expect((await auditOf("config.load")).length).toBeGreaterThanOrEqual(2);

    // 5.14 の受け入れ条件：使い回した署名では変わらない
    writeFileSync(join(home, "aicoop.yaml"), before);
    const again = await owner.post("/approvals/assert", { payload: i.payload, response });
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("nonce_used");
    expect(read("aicoop.yaml")).toBe(before);
  });

  it("新しいファイルは base_sha256: null で作れる", async () => {
    const res = await createChange([
      {
        path: "prompts/members/dev-implementer.md",
        content: "# 個人への調整\n",
        base_sha256: null,
      },
    ]);
    expect(res.status, res.text).toBe(201);
    expect(res.json.summary.files[0]).toMatchObject({ before_sha256: null });
    expect(res.json.summary.files[0].diff).toContain("--- /dev/null");
    const sent = await signAndSend("config_change", res.json.id);
    expect(sent.status, sent.text).toBe(200);
    expect(read("prompts/members/dev-implementer.md")).toBe("# 個人への調整\n");
  });

  it("5.14 の4の2・受け入れ条件：エラーのある変更は 422 config_invalid（issues つき）で、変更は作らない", async () => {
    const before = read("members.yaml");
    const res = await editFile("members.yaml", (t) =>
      t.replace("role: implementer", "role: nobody"),
    );
    expect(res.status, res.text).toBe(422);
    expect(res.json.error).toBe("config_invalid");
    expect(res.json.issues.map((i: { code: string }) => i.code)).toContain("E-001");
    expect(res.json.id).toBeUndefined();
    expect(read("members.yaml")).toBe(before);
  });

  it("5.14 の受け入れ条件：変更を作ったあとで設定にエラーが入ったら、署名しても保存しない", async () => {
    const groupsBefore = read("groups.yaml");
    const res = await editFile("groups.yaml", (t) => t.replace("開発部", "開発本部"));
    expect(res.status, res.text).toBe(201);
    // 変更に入っていない members.yaml が、あとから壊れた
    const members = read("members.yaml");
    writeFileSync(join(home, "members.yaml"), members.replace("role: implementer", "role: nobody"));
    try {
      const sent = await signAndSend("config_change", res.json.id);
      expect(sent.status, sent.text).toBe(422);
      expect(sent.json.error).toBe("config_invalid");
      expect(sent.json.issues.length).toBeGreaterThan(0);
      expect(read("groups.yaml")).toBe(groupsBefore);
    } finally {
      writeFileSync(join(home, "members.yaml"), members);
    }
  });

  it("5.14 の4の4・受け入れ条件：変更を作ったあとにファイルが書き換えられていたら、署名しても書かない（409）", async () => {
    const original = read("groups.yaml");
    const res = await editFile("groups.yaml", (t) => t.replace("開発部", "開発本部"));
    expect(res.status, res.text).toBe(201);
    const external = stringify({ groups: { ...DEFAULT_GROUPS } }).replace("開発部", "外で直した部");
    writeFileSync(join(home, "groups.yaml"), external);
    const sent = await signAndSend("config_change", res.json.id);
    expect(sent.status, sent.text).toBe(409);
    expect(sent.json.error).toBe("conflict");
    expect(read("groups.yaml")).toBe(external);
    writeFileSync(join(home, "groups.yaml"), original);
    // この変更はもう使えない
    const again = await owner.post("/approvals/intent", {
      type: "config_change",
      id: res.json.id,
      decision: "approve",
    });
    expect(again.status).toBe(404);
  });

  it("作るときの base_sha256 が、いまの中身と違えば 409（新しいファイルのつもりで、もうあるときも）", async () => {
    const wrong = await createChange([
      { path: "groups.yaml", content: "groups: {}\n", base_sha256: "0".repeat(64) },
    ]);
    expect(wrong.status).toBe(409);
    expect(wrong.json.error).toBe("conflict");
    const exists = await createChange([
      { path: "groups.yaml", content: "groups: {}\n", base_sha256: null },
    ]);
    expect(exists.status).toBe(409);
  });

  it("6.1・ST-8：company.id を変える変更は、作るときに 422 で拒む（変更は作らない）", async () => {
    const before = read("aicoop.yaml");
    const res = await editFile("aicoop.yaml", (t) =>
      t.replace(TEST_COMPANY.id, "c_01JD6V8X3S0Q5W7KQ9M2T4R6YC"),
    );
    expect(res.status, res.text).toBe(422);
    expect(res.json.error).toBe("config_invalid");
    expect(res.json.issues).toEqual([
      expect.objectContaining({ code: "E-013", source: "aicoop.yaml", path: "company.id" }),
    ]);
    expect(res.json.id).toBeUndefined();
    expect(read("aicoop.yaml")).toBe(before);
    const status = await bearer({ path: "/status" });
    expect(status.json.company.id).toBe(TEST_COMPANY.id);
  });

  it("5.14 の受け入れ条件：ほかの変更の署名では、設定は変わらない", async () => {
    const before = read("groups.yaml");
    const a = await editFile("groups.yaml", (t) => t.replace("開発部", "A部"));
    const b = await editFile("groups.yaml", (t) => t.replace("開発部", "B部"));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const ia = await intent("config_change", a.json.id);
    const ib = await intent("config_change", b.json.id);
    // B の署名を、A の payload に付けて送る
    const signedB = owner.auth.getAssertion(ib.options as never);
    const sent = await owner.post("/approvals/assert", { payload: ia.payload, response: signedB });
    expect(sent.status).toBe(400);
    expect(sent.json.error).toBe("signature_invalid");
    // B の payload の id を A に書き換えても通らない
    const forged = await owner.post("/approvals/assert", {
      payload: { ...ib.payload, id: a.json.id },
      response: signedB,
    });
    expect(forged.status).toBe(400);
    expect(read("groups.yaml")).toBe(before);
  });

  it("5.14 の受け入れ条件：期限切れの署名では、設定は変わらない（署名は2分、変更は10分）", async () => {
    const before = read("groups.yaml");
    const res = await editFile("groups.yaml", (t) => t.replace("開発部", "期限部"));
    const i = await intent("config_change", res.json.id);
    const response = owner.auth.getAssertion(i.options as never);
    offset += 3 * MINUTE;
    const sent = await owner.post("/approvals/assert", { payload: i.payload, response });
    expect(sent.status).toBe(400);
    expect(sent.json.error).toBe("approval_expired");
    expect(read("groups.yaml")).toBe(before);

    offset += 8 * MINUTE;
    const late = await owner.post("/approvals/intent", {
      type: "config_change",
      id: res.json.id,
      decision: "approve",
    });
    expect(late.status).toBe(409);
    expect(late.json.error).toBe("not_pending");
  });

  it("却下（reject）すると変更を取り消し、そのあとは承認できない", async () => {
    const before = read("groups.yaml");
    const res = await editFile("groups.yaml", (t) => t.replace("開発部", "取消部"));
    const sent = await signAndSend("config_change", res.json.id, "reject");
    expect(sent.status, sent.text).toBe(200);
    expect(sent.json.subject_status).toBe("cancelled");
    const after = await owner.post("/approvals/intent", {
      type: "config_change",
      id: res.json.id,
      decision: "approve",
    });
    expect(after.status).toBe(404);
    expect(read("groups.yaml")).toBe(before);
  });

  it("書けないパス（secrets.json・state.db・../）の変更は作れない", async () => {
    for (const path of ["secrets.json", "state.db", "../x.yaml", "prompts/../secrets.json"]) {
      const res = await createChange([{ path, content: "{}", base_sha256: null }]);
      expect(res.status, path).toBe(400);
      expect(res.json.error).toBe("invalid_input");
    }
    expect(readSecret(aicoopPaths(home).secrets, "github")?.value).toEqual({ token: OLD_SECRET });
  });

  it("64 KiB を超える変更も送れる（この道だけ 1 MiB まで）", async () => {
    const big = `# 方針\n${"あいうえお".repeat(15_000)}\n`;
    const got = await owner.get("/config/files/prompts/company.md");
    const res = await createChange([
      { path: "prompts/company.md", content: big, base_sha256: got.json.sha256 },
    ]);
    expect(res.status, res.text.slice(0, 200)).toBe(201);
    const tooBig = await owner.post("/tasks", { member: "x", purpose: big, done_when: "x" });
    expect(tooBig.status).toBe(413);
  });
});

describe("5.14 の5：資格の画面", () => {
  it("一覧は ID・種類・更新日時だけ（中身は出さない）", async () => {
    const res = await owner.get("/secrets");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toEqual({
      secrets: [{ id: "github", kind: "static_token", updated_at: expect.any(String) }],
    });
    expect(res.text).not.toContain(OLD_SECRET);
  });

  it("置き換え：要約は {id, kind, action} だけ。署名するまで変わらず、署名したら store に書き、監査ログに secret.change", async () => {
    const res = await owner.post("/secrets/changes", {
      id: "github",
      kind: "static_token",
      value: { token: SECRET_VALUE },
    });
    expect(res.status, res.text).toBe(201);
    expect(res.json.summary).toEqual({ id: "github", kind: "static_token", action: "replace" });
    expect(res.text).not.toContain(SECRET_VALUE);
    expect(readSecret(aicoopPaths(home).secrets, "github")?.value).toEqual({ token: OLD_SECRET });

    const i = await intent("secret_change", res.json.id);
    expect(i.payload.summary_sha256).toBe(shownSha(res.json.summary));
    const response = owner.auth.getAssertion(i.options as never);
    const sent = await owner.post("/approvals/assert", { payload: i.payload, response });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.text).not.toContain(SECRET_VALUE);
    expect(readSecret(aicoopPaths(home).secrets, "github")?.value).toEqual({ token: SECRET_VALUE });

    const audit = await auditOf("secret.change");
    expect(audit[audit.length - 1]?.data).toEqual({ secret_id: "github", change: "set" });

    // 使い回しでは変わらない
    setSecret(aicoopPaths(home).secrets, "github", "static_token", { token: OLD_SECRET });
    const again = await owner.post("/approvals/assert", { payload: i.payload, response });
    expect(again.status).toBe(409);
    expect(readSecret(aicoopPaths(home).secrets, "github")?.value).toEqual({ token: OLD_SECRET });
  });

  it("登録（トークンだけの文字列でもよい）と削除", async () => {
    const res = await owner.post("/secrets/changes", {
      id: "anthropic",
      kind: "anthropic_oauth",
      value: `  ${SECRET_VALUE}\n`,
    });
    expect(res.status, res.text).toBe(201);
    expect(res.json.summary).toEqual({
      id: "anthropic",
      kind: "anthropic_oauth",
      action: "create",
    });
    expect((await signAndSend("secret_change", res.json.id)).status).toBe(200);
    expect(readSecret(aicoopPaths(home).secrets, "anthropic")?.value).toEqual({
      token: SECRET_VALUE,
    });

    const del = await owner.post("/secrets/changes", { id: "anthropic", delete: true });
    expect(del.status, del.text).toBe(201);
    expect(del.json.summary).toEqual({
      id: "anthropic",
      kind: "anthropic_oauth",
      action: "delete",
    });
    expect(readSecret(aicoopPaths(home).secrets, "anthropic")).toBeDefined();
    expect((await signAndSend("secret_change", del.json.id)).status).toBe(200);
    expect(readSecret(aicoopPaths(home).secrets, "anthropic")).toBeUndefined();
    const audit = await auditOf("secret.change");
    expect(audit[audit.length - 1]?.data).toEqual({ secret_id: "anthropic", change: "rm" });
  });

  it("5.14 の受け入れ条件：署名のない・期限切れ・ほかの変更の署名では、資格は変わらない", async () => {
    const a = await owner.post("/secrets/changes", {
      id: "github",
      kind: "static_token",
      value: { token: SECRET_VALUE },
    });
    const b = await owner.post("/secrets/changes", { id: "github", delete: true });
    const ia = await intent("secret_change", a.json.id);
    const ib = await intent("secret_change", b.json.id);
    const other = await owner.post("/approvals/assert", {
      payload: ia.payload,
      response: owner.auth.getAssertion(ib.options as never),
    });
    expect(other.status).toBe(400);
    const ia2 = await intent("secret_change", a.json.id);
    const response = owner.auth.getAssertion(ia2.options as never);
    offset += 3 * MINUTE;
    const expired = await owner.post("/approvals/assert", { payload: ia2.payload, response });
    expect(expired.json.error).toBe("approval_expired");
    expect(readSecret(aicoopPaths(home).secrets, "github")?.value).toEqual({ token: OLD_SECRET });
  });

  it("変更を作ったあとで資格が変えられていたら、署名しても書かない（409）", async () => {
    const res = await owner.post("/secrets/changes", {
      id: "github",
      kind: "static_token",
      value: { token: SECRET_VALUE },
    });
    setSecret(aicoopPaths(home).secrets, "github", "static_token", { token: "ghp_CLI_CHANGED" });
    const sent = await signAndSend("secret_change", res.json.id);
    expect(sent.status).toBe(409);
    expect(sent.json.error).toBe("conflict");
    expect(readSecret(aicoopPaths(home).secrets, "github")?.value).toEqual({
      token: "ghp_CLI_CHANGED",
    });
    setSecret(aicoopPaths(home).secrets, "github", "static_token", { token: OLD_SECRET });
  });

  it("形の違う値・知らない種類・ない資格の削除は、値を出さずに 400・404", async () => {
    const badKey = await owner.post("/secrets/changes", {
      id: "github",
      kind: "static_token",
      value: { [SECRET_VALUE]: "" },
    });
    expect(badKey.status).toBe(400);
    expect(badKey.text).not.toContain(SECRET_VALUE);
    const spaces = await owner.post("/secrets/changes", {
      id: "github",
      kind: "static_token",
      value: `${SECRET_VALUE} ${SECRET_VALUE}`,
    });
    expect(spaces.status).toBe(400);
    expect(spaces.text).not.toContain(SECRET_VALUE);
    const kind = await owner.post("/secrets/changes", {
      id: "github",
      kind: SECRET_VALUE,
      value: { token: SECRET_VALUE },
    });
    expect(kind.status).toBe(400);
    expect(kind.text).not.toContain(SECRET_VALUE);
    const id = await owner.post("/secrets/changes", { id: SECRET_VALUE, delete: true });
    expect(id.status).toBe(400);
    expect(id.text).not.toContain(SECRET_VALUE);
    const missing = await owner.post("/secrets/changes", { id: "nothing", delete: true });
    expect(missing.status).toBe(404);
  });

  it("5.14 の受け入れ条件：資格の API の応答・ログ・監査ログに、資格の中身が出ない", async () => {
    const list = await owner.get("/secrets");
    expect(list.text).not.toContain(SECRET_VALUE);
    expect(list.text).not.toContain(OLD_SECRET);
    expect(allLogs()).not.toContain(SECRET_VALUE);
    expect(allLogs()).not.toContain(OLD_SECRET);
    const audit = await bearer({ path: "/audit?limit=1000" });
    expect(audit.text).not.toContain(SECRET_VALUE);
    expect(audit.text).not.toContain(OLD_SECRET);
    expect(listSecrets(aicoopPaths(home).secrets).map((s) => s.id)).toEqual(["github"]);
  });
});
