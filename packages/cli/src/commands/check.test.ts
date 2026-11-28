import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_METADATA_FILE, imageDir } from "@aicoop/box-gondolin";
import { setSecret } from "@aicoop/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeDaemon } from "../testing/fake-daemon.ts";
import { createTestCli, type TestCli } from "../testing/harness.ts";

let cli: TestCli;
beforeEach(async () => {
  cli = createTestCli();
  await cli.run(["init", "--name", "テスト商会"]);
});
afterEach(() => cli.cleanup());

const secrets = () => join(cli.home, "secrets.json");

function edit(file: string, from: string, to: string) {
  const path = join(cli.home, file);
  const text = readFileSync(path, "utf8");
  if (!text.includes(from)) throw new Error(`${file} に ${from} がありません`);
  writeFileSync(path, text.replace(from, to));
}

function makeImage(group?: string, packages: string[] = []) {
  const dir = imageDir(cli.home, group);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, IMAGE_METADATA_FILE),
    JSON.stringify({ claudeCodeVersion: "2.3.4", packages, builtAt: "2026-11-27T01:00:00.000Z" }),
  );
}

describe("9.1 aicoop check：設定を検証し、エラーと警告を表示する（6.10）", () => {
  it("aicoop init の直後は、エラーも警告もなく通る（終了コード 0）", async () => {
    const r = await cli.run(["check"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("エラーも警告もありません");
    expect(r.stdout).not.toMatch(/[EW]-\d{3}/);
  });

  it("--json：機械向けに、エラー・警告・準備の確認を出す", async () => {
    const r = await cli.run(["check", "--json"]);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json).toMatchObject({ ok: true, errors: [], warnings: [] });
    expect(Array.isArray(json.readiness)).toBe(true);
    expect(json.readiness.map((x: { id: string }) => x.id)).toContain("secret:anthropic");
  });

  it("エラーがあれば、ファイル・場所・直し方つきで出し、終了コード 1", async () => {
    edit("aicoop.yaml", "timeout_minutes: 45", "timeout_minutes: 60");
    const r = await cli.run(["check"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("エラー 1件");
    expect(r.stdout).toContain("aicoop.yaml");
    expect(r.stdout).toContain("task.timeout_minutes");
    expect(r.stdout).toMatch(/55/);
    const json = JSON.parse((await cli.run(["check", "--json"])).stdout);
    expect(json.ok).toBe(false);
    expect(json.errors[0]).toMatchObject({ source: "aicoop.yaml", path: "task.timeout_minutes" });
  });

  it("警告だけなら通る（終了コード 0）が、警告として見せる", async () => {
    // 開発部に web.read を足すと、持ち出しの危険（W-002）
    edit(
      "groups.yaml",
      '- { op: "github.pr.create", params: { repo: ["your-org/*"] } }',
      '- { op: "github.pr.create", params: { repo: ["your-org/*"] } }\n      - { op: "web.read" }',
    );
    edit(
      "roles.yaml",
      '- { op: "github.git.push" }',
      '- { op: "github.git.push" }\n      - { op: "web.read" }',
    );
    const r = await cli.run(["check"]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain("警告");
    expect(r.stdout).toContain("W-002");
  });

  it("設定がなければ、aicoop init を案内する（終了コード 1）", async () => {
    const r = await cli.run(["--home", join(cli.userHome, "nowhere"), "check"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("aicoop init");
  });
});

describe("aicoop check の「準備の確認」（エラーにはしない）", () => {
  it("資格が足りなければ、登録のしかたを出す。それでも終了コードは 0", async () => {
    const r = await cli.run(["check"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("準備の確認");
    expect(r.stdout).toContain("aicoop login");
    expect(r.stdout).toContain("aicoop secret set github --kind github_app");
  });

  it("登録した資格は ✓ になる。中身は出さない", async () => {
    setSecret(secrets(), "anthropic", "anthropic_oauth", { token: "sk-ant-oat01-SECRETVALUE" });
    const r = await cli.run(["check"]);
    expect(r.stdout).toMatch(/✓ .*anthropic/);
    expect(r.stdout).not.toContain("SECRETVALUE");
  });

  it("資格の種類が違えば、登録し直すように言う", async () => {
    setSecret(secrets(), "github", "static_token", { token: "ghp_SECRETVALUE" });
    const r = await cli.run(["check", "--json"]);
    const item = JSON.parse(r.stdout).readiness.find(
      (x: { id: string }) => x.id === "secret:github",
    );
    expect(item.ok).toBe(false);
    expect(item.message).toContain("static_token");
    expect(item.hint).toContain("--kind github_app");
    expect(r.stdout).not.toContain("SECRETVALUE");
  });

  it("groups.yaml の your-org を書き換えていなければ知らせる", async () => {
    const before = await cli.run(["check"]);
    expect(before.stdout).toContain("your-org");
    const path = join(cli.home, "groups.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("your-org", "myorg"));
    const after = await cli.run(["check", "--json"]);
    const ids = JSON.parse(after.stdout).readiness.map((x: { id: string }) => x.id);
    expect(ids).not.toContain("placeholder:your-org");
  });

  it("vm のイメージがなければ aicoop image build を案内し、あれば版を出す", async () => {
    expect((await cli.run(["check"])).stdout).toContain("aicoop image build");
    makeImage();
    makeImage("dev", ["nodejs", "npm"]);
    const r = await cli.run(["check"]);
    expect(r.stdout).toMatch(/✓ .*イメージ.*2\.3\.4/);
  });

  it("部署のイメージが packages より古ければ、作り直すように言う", async () => {
    makeImage();
    makeImage("dev", ["nodejs"]);
    const r = await cli.run(["check"]);
    expect(r.stdout).toContain("aicoop image build --group dev");
  });

  it("Windows では、WSL2 の中で動かすように言う", async () => {
    const win = createTestCli({ platform: "win32" });
    try {
      await win.run(["init"]);
      const r = await win.run(["check"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("WSL2");
    } finally {
      win.cleanup();
    }
  });

  it("Linux では KVM と QEMU を確かめる", async () => {
    const r = await cli.run(["check"]);
    expect(r.stdout).toContain("/dev/kvm");
    expect(r.stdout).toContain("qemu-system-x86_64");
    const ok = createTestCli({ deps: { canAccess: () => true, which: (c) => `/usr/bin/${c}` } });
    try {
      await ok.run(["init"]);
      const r2 = await ok.run(["check", "--json"]);
      const items = JSON.parse(r2.stdout).readiness as { id: string; ok: boolean }[];
      expect(items.find((x) => x.id === "os:kvm")?.ok).toBe(true);
      expect(items.find((x) => x.id === "os:qemu")?.ok).toBe(true);
    } finally {
      ok.cleanup();
    }
  });

  it("5.1.8：Linux ではイメージを作る道具（mke2fs・cpio・lz4）を確かめ、足りないものと入れ方を言う", async () => {
    const r = await cli.run(["check"]);
    expect(r.stdout).toContain("mke2fs・cpio・lz4");
    expect(r.stdout).toContain("sudo apt install e2fsprogs cpio lz4");
    const some = createTestCli({
      deps: { canAccess: () => true, which: (c) => (c === "lz4" ? null : `/usr/bin/${c}`) },
    });
    try {
      await some.run(["init"]);
      const items = JSON.parse((await some.run(["check", "--json"])).stdout).readiness as {
        id: string;
        ok: boolean;
        message: string;
        hint?: string;
      }[];
      const tools = items.find((x) => x.id === "os:image-tools");
      expect(tools?.ok).toBe(false);
      expect(tools?.message).toContain("lz4");
      expect(tools?.message).not.toContain("cpio");
      expect(tools?.hint).toContain("sudo apt install lz4");
    } finally {
      some.cleanup();
    }
    const all = createTestCli({ deps: { canAccess: () => true, which: (c) => `/usr/bin/${c}` } });
    try {
      await all.run(["init"]);
      const items = JSON.parse((await all.run(["check", "--json"])).stdout).readiness as {
        id: string;
        ok: boolean;
      }[];
      expect(items.find((x) => x.id === "os:image-tools")?.ok).toBe(true);
    } finally {
      all.cleanup();
    }
  });

  it("daemon が動いていなければ aicoop start、動いていれば ✓", async () => {
    expect((await cli.run(["check"])).stdout).toContain("aicoop start");
    const fake = await startFakeDaemon(cli.home);
    fake.on("GET /status", {
      body: { daemon: { config_loaded_at: new Date(Date.now() + 60_000).toISOString() } },
    });
    try {
      const r = await cli.run(["check"]);
      expect(r.stdout).toMatch(/✓ .*制御サーバーが動いています/);
      expect(r.stdout).not.toContain("aicoop reload");
    } finally {
      await fake.close();
    }
  });

  it("daemon が読んだあとに設定を変えていたら aicoop reload を案内する", async () => {
    const fake = await startFakeDaemon(cli.home);
    fake.on("GET /status", { body: { daemon: { config_loaded_at: "2026-01-01T00:00:00.000Z" } } });
    const now = new Date();
    utimesSync(join(cli.home, "groups.yaml"), now, now);
    try {
      const r = await cli.run(["check"]);
      expect(r.stdout).toContain("aicoop reload");
    } finally {
      await fake.close();
    }
  });
});
