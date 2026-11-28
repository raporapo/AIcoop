import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPANY_ID_PATTERN } from "@aicoop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createTestCli, type TestCli } from "../testing/harness.ts";

let cli: TestCli;
beforeEach(() => {
  cli = createTestCli();
});
afterEach(() => cli.cleanup());

function companyOf(home: string): { id: string; name: string } {
  return (
    parseYaml(readFileSync(join(home, "aicoop.yaml"), "utf8")) as {
      company: { id: string; name: string };
    }
  ).company;
}

describe("9.1 aicoop init：雛形と .gitignore を作り、company.id を発行する（6.1）", () => {
  it("設定ファイル・プロンプト・.gitignore と、data/・logs/・runtime/・state/holds/ を作る", async () => {
    const r = await cli.run(["init", "--name", "サンプル商会"]);
    expect(r.code, r.stderr).toBe(0);
    for (const file of [
      "aicoop.yaml",
      "groups.yaml",
      "roles.yaml",
      "members.yaml",
      "triggers.yaml",
    ]) {
      expect(existsSync(join(cli.home, file)), file).toBe(true);
    }
    expect(existsSync(join(cli.home, "prompts", "company.md"))).toBe(true);
    expect(readFileSync(join(cli.home, ".gitignore"), "utf8")).toContain("secrets.json");
    for (const dir of ["data", "logs", "runtime", join("state", "holds")]) {
      expect(statSync(join(cli.home, dir)).isDirectory(), dir).toBe(true);
    }
    const company = companyOf(cli.home);
    expect(company.id).toMatch(COMPANY_ID_PATTERN);
    expect(company.name).toBe("サンプル商会");
  });

  it("終わったら「次にすること」を番号つきで案内する", async () => {
    const r = await cli.run(["init"]);
    expect(r.stdout).toContain("次にすること");
    const steps = [
      "your-org",
      "aicoop login",
      "aicoop secret set github --kind github_app",
      "aicoop check",
      "aicoop image build",
      "aicoop start",
      "aicoop run ",
    ];
    let at = 0;
    for (const step of steps) {
      const found = r.stdout.indexOf(step, at);
      expect(found, step).toBeGreaterThan(-1);
      at = found;
    }
    expect(r.stdout).toMatch(/^\s+1\. /m);
    expect(r.stdout).toMatch(/^\s+7\. /m);
  });

  it("会社の名前を書かなければ「わたしの会社」", async () => {
    await cli.run(["init"]);
    expect(companyOf(cli.home).name).toBe("わたしの会社");
  });

  it("2回目は何も上書きせずに止まる（終了コード 1）", async () => {
    await cli.run(["init", "--name", "一回目"]);
    const before = readFileSync(join(cli.home, "aicoop.yaml"), "utf8");
    writeFileSync(join(cli.home, "groups.yaml"), "# 自分で書き換えた\n");
    const r = await cli.run(["init", "--name", "二回目"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("すでに設定があります");
    expect(r.stderr).toContain("--only-missing");
    expect(readFileSync(join(cli.home, "aicoop.yaml"), "utf8")).toBe(before);
    expect(readFileSync(join(cli.home, "groups.yaml"), "utf8")).toBe("# 自分で書き換えた\n");
  });

  it("--force はない：上書きの代わりにどうすればよいかを出す（終了コード 2、何も変えない）", async () => {
    await cli.run(["init"]);
    const before = readFileSync(join(cli.home, "aicoop.yaml"), "utf8");
    const r = await cli.run(["init", "--force"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("上書きしません");
    expect(r.stderr).toContain("--only-missing");
    expect(readFileSync(join(cli.home, "aicoop.yaml"), "utf8")).toBe(before);
  });

  it("--only-missing は、消したファイルだけを作り直し、会社の ID は変えない", async () => {
    await cli.run(["init", "--name", "サンプル商会"]);
    const id = companyOf(cli.home).id;
    writeFileSync(join(cli.home, "groups.yaml"), "# 自分で書き換えた\n");
    rmSync(join(cli.home, "prompts", "company.md"));
    const r = await cli.run(["init", "--only-missing"]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(cli.home, "prompts", "company.md"))).toBe(true);
    expect(readFileSync(join(cli.home, "groups.yaml"), "utf8")).toBe("# 自分で書き換えた\n");
    expect(companyOf(cli.home).id).toBe(id);
    expect(r.stdout).toContain("prompts/company.md");
  });

  it("--only-missing でも、aicoop.yaml がないのに state.db があれば作らない（会社の ID が変わるため）", async () => {
    await cli.run(["init"]);
    rmSync(join(cli.home, "aicoop.yaml"));
    writeFileSync(join(cli.home, "state.db"), "");
    const r = await cli.run(["init", "--only-missing"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("会社の ID");
    expect(existsSync(join(cli.home, "aicoop.yaml"))).toBe(false);
  });

  it("会社の名前が空・制御文字入りなら使い方の誤り（終了コード 2）", async () => {
    expect((await cli.run(["init", "--name", "  "])).code).toBe(2);
    expect((await cli.run(["init", "--name", "a\u001b[31mb"])).code).toBe(2);
    expect(existsSync(join(cli.home, "aicoop.yaml"))).toBe(false);
  });

  it("--home の場所に作り、以後のコマンドでも --home が要ると案内する", async () => {
    const r = await cli.run(["--home", "my-company", "init"]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(cli.userHome, "my-company", "aicoop.yaml"))).toBe(true);
    expect(r.stdout).toContain("--home");
  });

  it.skipIf(process.platform === "win32")("作った home は自分だけが入れる（0700）", async () => {
    await cli.run(["init"]);
    expect(statSync(cli.home).mode & 0o777).toBe(0o700);
  });
});

describe("Windows での init", () => {
  it("WSL2 の中で動かすように案内する", async () => {
    const win = createTestCli({ platform: "win32" });
    try {
      const r = await win.run(["init"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("WSL2");
    } finally {
      win.cleanup();
    }
  });
});
