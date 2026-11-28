import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_METADATA_FILE, imageDir } from "@aicoop/box-gondolin";
import { DEFAULT_COMPANY_NAME } from "@aicoop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aicoopPaths } from "../paths.ts";
import { setSecret } from "../secrets/store.ts";
import { loadTestCompany, writeCompanyFiles } from "../testing/company-config.ts";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import {
  checkHostReadiness,
  companyNameItem,
  type ReadinessHost,
  type ReadinessItem,
} from "./readiness.ts";

let dir: TempDir;
let home: string;

const host = (over: Partial<ReadinessHost> = {}): ReadinessHost => ({
  platform: "linux",
  arch: "x64",
  which: (command) => `/usr/bin/${command}`,
  canAccess: () => true,
  now: () => new Date("2026-11-29T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  dir = tempDir();
  home = join(dir.path, ".aicoop");
  writeCompanyFiles(home);
});

afterEach(() => dir.cleanup());

const byId = (items: readonly ReadinessItem[], id: string) => items.find((i) => i.id === id);

describe("5.14 の3：準備の確認（aicoop check と同じ判定を daemon から使う）", () => {
  it("資格・イメージ・OS の項目を返し、制御サーバーの項目（daemon・daemon:reload）は入れない", async () => {
    const items = await checkHostReadiness(host(), home, loadTestCompany(home));
    expect(byId(items, "secret:anthropic")?.ok).toBe(false);
    expect(byId(items, "secret:github")?.ok).toBe(false);
    expect(byId(items, "image:base")?.ok).toBe(false);
    expect(byId(items, "os:kvm")?.ok).toBe(true);
    expect(items.some((i) => i.id.startsWith("daemon"))).toBe(false);
  });

  it("登録した資格・作ったイメージは済み（中身はどこにも出さない）", async () => {
    const paths = aicoopPaths(home);
    setSecret(paths.secrets, "anthropic", "anthropic_oauth", { token: "sk-ant-oat01-SECRETVALUE" });
    setSecret(paths.secrets, "github", "github_app", {
      app_id: "1",
      installation_id: "2",
      private_key: "-----BEGIN PRIVATE KEY-----\nSECRETKEY\n-----END PRIVATE KEY-----",
    });
    const base = imageDir(home);
    mkdirSync(base, { recursive: true });
    writeFileSync(
      join(base, IMAGE_METADATA_FILE),
      JSON.stringify({ claudeCodeVersion: "2.1.3", builtAt: "2026-11-28T00:00:00Z" }),
    );
    const items = await checkHostReadiness(host(), home, loadTestCompany(home));
    expect(byId(items, "secret:anthropic")?.ok).toBe(true);
    expect(byId(items, "secret:github")?.ok).toBe(true);
    expect(byId(items, "image:base")?.ok).toBe(true);
    expect(JSON.stringify(items)).not.toContain("SECRET");
  });

  it("acceptStaticToken：static_token の資格は、どのサービスでも済みとする（資格の発行と同じ。5.2.8）", async () => {
    setSecret(aicoopPaths(home).secrets, "github", "static_token", { token: "ghp_SECRETVALUE" });
    const strict = await checkHostReadiness(host(), home, loadTestCompany(home));
    expect(byId(strict, "secret:github")?.ok).toBe(false);
    const lenient = await checkHostReadiness(host(), home, loadTestCompany(home), {
      acceptStaticToken: true,
    });
    expect(byId(lenient, "secret:github")?.ok).toBe(true);
    expect(JSON.stringify(lenient)).not.toContain("SECRETVALUE");
  });

  it("Windows では vm の箱が動かないことを返す", async () => {
    const items = await checkHostReadiness(
      host({ platform: "win32" }),
      home,
      loadTestCompany(home),
    );
    expect(byId(items, "os:platform")?.ok).toBe(false);
  });
});

describe("5.14 の3の1：会社の名前", () => {
  it("雛形の名前（わたしの会社）のままなら済んでいない", () => {
    expect(companyNameItem(DEFAULT_COMPANY_NAME).ok).toBe(false);
    expect(companyNameItem(`  ${DEFAULT_COMPANY_NAME} `).ok).toBe(false);
  });

  it("名前を変えたら済み", () => {
    const item = companyNameItem("サンプル商会");
    expect(item).toMatchObject({ id: "company:name", ok: true });
    expect(item.message).toContain("サンプル商会");
  });
});
