import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { listAuditLog, openStateDb, readSecret, verifyAuditLog } from "@aicoop/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestCli, FakeInput, type RunResult, type TestCli } from "../testing/harness.ts";

/** 画面にもエラーにも監査ログにも出てはならない値 */
const TOKEN = "sk-ant-oat01-TOPSECRET-abcdefghijklmnop";
const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA-TOPSECRET-PEM\n-----END RSA PRIVATE KEY-----";

let cli: TestCli;
beforeEach(async () => {
  cli = createTestCli();
  await cli.run(["init"]);
});
afterEach(() => cli.cleanup());

const secretsPath = () => join(cli.home, "secrets.json");

function expectNoLeak(r: RunResult, ...values: string[]) {
  for (const v of [TOKEN, "TOPSECRET", ...values]) {
    expect(r.stdout, "標準出力に資格の中身が出ている").not.toContain(v);
    expect(r.stderr, "標準エラーに資格の中身が出ている").not.toContain(v);
  }
}

function auditRows() {
  const db = openStateDb(join(cli.home, "state.db"));
  try {
    return { rows: listAuditLog(db), verify: verifyAuditLog(db) };
  } finally {
    db.close();
  }
}

describe("5.2.8 aicoop secret set：標準入力から資格を登録する", () => {
  it("パイプの JSON を保存し、監査ログに secret.change（actor owner:cli）を書く", async () => {
    const r = await cli.run(["secret", "set", "anthropic", "--kind", "anthropic_oauth"], {
      stdin: new FakeInput({ data: JSON.stringify({ token: TOKEN }) }),
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("anthropic");
    expect(readSecret(secretsPath(), "anthropic")?.value).toEqual({ token: TOKEN });
    const { rows, verify } = auditRows();
    expect(verify.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: "owner:cli",
      kind: "secret.change",
      subject: "anthropic",
    });
    expect(JSON.parse(rows[0]?.data ?? "{}")).toEqual({ secret_id: "anthropic", change: "set" });
    expect(JSON.stringify(rows)).not.toContain("TOPSECRET");
    expectNoLeak(r);
  });

  it("static_token・anthropic_oauth は、トークンだけ（JSON でない）でも受け付ける", async () => {
    const r = await cli.run(["secret", "set", "anthropic", "--kind", "anthropic_oauth"], {
      stdin: new FakeInput({ data: `${TOKEN}\n` }),
    });
    expect(r.code, r.stderr).toBe(0);
    expect(readSecret(secretsPath(), "anthropic")?.value).toEqual({ token: TOKEN });
    expectNoLeak(r);
  });

  it("github_app の JSON（private_key は複数行）をファイルから受け付ける", async () => {
    const json = JSON.stringify({ app_id: 123, installation_id: 456, private_key: PEM }, null, 2);
    const r = await cli.run(["secret", "set", "github", "--kind", "github_app"], {
      stdin: new FakeInput({ data: json }),
    });
    expect(r.code, r.stderr).toBe(0);
    expect(readSecret(secretsPath(), "github")?.kind).toBe("github_app");
    expectNoLeak(r);
  });

  it.skipIf(process.platform === "win32")("secrets.json は 0600", async () => {
    await cli.run(["secret", "set", "anthropic", "--kind", "anthropic_oauth"], {
      stdin: new FakeInput({ data: TOKEN }),
    });
    expect(statSync(secretsPath()).mode & 0o777).toBe(0o600);
  });

  it("2回目は「更新しました」。種類が変わったら知らせる", async () => {
    await cli.run(["secret", "set", "github", "--kind", "static_token"], {
      stdin: new FakeInput({ data: TOKEN }),
    });
    const json = JSON.stringify({ app_id: 1, installation_id: 2, private_key: PEM });
    const r = await cli.run(["secret", "set", "github", "--kind", "github_app"], {
      stdin: new FakeInput({ data: json }),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("更新しました");
    expect(r.stdout).toContain("static_token");
    expectNoLeak(r);
  });

  it("端末からは、画面に出さずに1行読む（raw モード）。打った文字は出さない", async () => {
    const stdin = new FakeInput({ tty: true });
    const running = cli.start(["secret", "set", "anthropic", "--kind", "anthropic_oauth"], {
      stdin,
      tty: true,
    });
    await waitFor(() => stdin.rawMode);
    stdin.type(TOKEN);
    stdin.type("\r");
    const r = await running.done;
    expect(r.code, r.stderr).toBe(0);
    expect(stdin.rawModeHistory).toEqual([true, false]);
    expect(r.stderr).toContain("貼り付けて");
    expect(readSecret(secretsPath(), "anthropic")?.value).toEqual({ token: TOKEN });
    expectNoLeak(r);
  });

  it("端末で、複数行の JSON を貼り付けても、閉じるまで読む。Backspace も効く", async () => {
    const stdin = new FakeInput({ tty: true });
    const running = cli.start(["secret", "set", "gmail", "--kind", "google_oauth"], {
      stdin,
      tty: true,
    });
    await waitFor(() => stdin.rawMode);
    stdin.type('{\r  "client_id": "cid",\r  "client_secret": "TOPSECRET-x\u007f",\r');
    stdin.type('  "refresh_token": "TOPSECRET-r"\r}\r');
    const r = await running.done;
    expect(r.code, r.stderr).toBe(0);
    expect(readSecret(secretsPath(), "gmail")?.value).toEqual({
      client_id: "cid",
      client_secret: "TOPSECRET-",
      refresh_token: "TOPSECRET-r",
    });
    expectNoLeak(r);
  });

  it("端末で Ctrl+C を押したら、何も保存しない（終了コード 130）", async () => {
    const stdin = new FakeInput({ tty: true });
    const running = cli.start(["secret", "set", "anthropic", "--kind", "anthropic_oauth"], {
      stdin,
      tty: true,
    });
    await waitFor(() => stdin.rawMode);
    stdin.type("TOPSECRET-partial\u0003");
    const r = await running.done;
    expect(r.code).toBe(130);
    expect(existsSync(secretsPath())).toBe(false);
    expect(stdin.rawModeHistory).toEqual([true, false]);
    expectNoLeak(r);
  });
});

describe("5.2.8・11.5 aicoop secret set の拒否される側：中身を画面・エラーに出さない", () => {
  const cases: [string, string, string][] = [
    ["JSON として読めない", "anthropic_oauth", `{"token": "${TOKEN}"`],
    ["トークンに空白がある", "static_token", `${TOKEN} TOPSECRET-2`],
    ["知らないキー", "anthropic_oauth", JSON.stringify({ token: TOKEN, TOPSECRET_KEY: TOKEN })],
    // キーの位置にトークンを貼ってしまった（GitHub の古い形のトークンは40文字）
    [
      "キーの位置のトークン",
      "static_token",
      JSON.stringify({ ghp_TOPSECRET0123456789abcdefghijklmnop: "" }),
    ],
    ["全角の文字が混ざったトークン", "static_token", `${TOKEN}あ`],
    [
      "キーが足りない（github_app）",
      "github_app",
      JSON.stringify({ app_id: 1, private_key: TOKEN }),
    ],
    [
      "PEM でない private_key",
      "github_app",
      JSON.stringify({ app_id: 1, installation_id: 2, private_key: TOKEN }),
    ],
    ["JSON の配列", "static_token", JSON.stringify([TOKEN])],
    ["空の token", "static_token", JSON.stringify({ token: "   " })],
  ];
  for (const [name, kind, data] of cases) {
    it(`${name}：保存せず、終了コード 2、中身は出さない`, async () => {
      const r = await cli.run(["secret", "set", "x", "--kind", kind], {
        stdin: new FakeInput({ data }),
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("エラー");
      expect(existsSync(secretsPath())).toBe(false);
      expectNoLeak(r);
    });
  }

  it("入力が空なら、渡し方を案内する", async () => {
    const r = await cli.run(["secret", "set", "x", "--kind", "static_token"], {
      stdin: new FakeInput({ data: "" }),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("受け取りませんでした");
  });

  it("入力が大きすぎれば読まない", async () => {
    const r = await cli.run(["secret", "set", "x", "--kind", "static_token"], {
      stdin: new FakeInput({ data: "A".repeat(200 * 1024) }),
    });
    expect(r.code).toBe(2);
    expect(existsSync(secretsPath())).toBe(false);
  });

  it("知らない種類は、標準入力を読む前に止め、「もしかして」を出す", async () => {
    const r = await cli.run(["secret", "set", "github", "--kind", "github-app"], {
      stdin: new FakeInput({ data: TOKEN }),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("github_app");
    expectNoLeak(r);
  });

  it("使えない ID は、標準入力を読む前に止める", async () => {
    const r = await cli.run(["secret", "set", "../evil", "--kind", "static_token"], {
      stdin: new FakeInput({ data: TOKEN }),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ID");
    expect(existsSync(secretsPath())).toBe(false);
  });

  it("aicoop init の前なら、作らずに案内する", async () => {
    const r = await cli.run(
      ["--home", join(cli.userHome, "none"), "secret", "set", "x", "--kind", "static_token"],
      {
        stdin: new FakeInput({ data: TOKEN }),
      },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("aicoop init");
    expect(existsSync(join(cli.userHome, "none"))).toBe(false);
  });
});

describe("5.2.8 aicoop secret list：ID と種類と更新日時だけを出す", () => {
  it("中身は出さない。--json も同じ", async () => {
    await cli.run(["secret", "set", "anthropic", "--kind", "anthropic_oauth"], {
      stdin: new FakeInput({ data: TOKEN }),
    });
    const r = await cli.run(["secret", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("anthropic");
    expect(r.stdout).toContain("anthropic_oauth");
    expectNoLeak(r);
    const json = await cli.run(["secret", "list", "--json"]);
    const parsed = JSON.parse(json.stdout);
    expect(parsed).toEqual([
      { id: "anthropic", kind: "anthropic_oauth", updated_at: expect.any(String) },
    ]);
    expectNoLeak(json);
  });

  it("1つもなければ、登録のしかたを出す", async () => {
    const r = await cli.run(["secret", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("まだ登録されていません");
    expect(JSON.parse((await cli.run(["secret", "list", "--json"])).stdout)).toEqual([]);
  });

  it("secrets.json が壊れていても、中身を出さずに知らせる", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      secretsPath(),
      `{"version": 1, "secrets": {"a": {"kind": "static_token", "value": {"token": "${TOKEN}", "x": 1}}}}`,
    );
    const r = await cli.run(["secret", "list"]);
    expect(r.code).toBe(1);
    expectNoLeak(r);
  });
});

describe("aicoop secret rm", () => {
  beforeEach(async () => {
    await cli.run(["secret", "set", "github", "--kind", "static_token"], {
      stdin: new FakeInput({ data: TOKEN }),
    });
  });

  it("--yes で消し、監査ログに secret.change（rm）を書く", async () => {
    const r = await cli.run(["secret", "rm", "github", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(readSecret(secretsPath(), "github")).toBeUndefined();
    const { rows, verify } = auditRows();
    expect(verify.ok).toBe(true);
    expect(rows.map((row) => JSON.parse(row.data).change)).toEqual(["set", "rm"]);
  });

  it("端末なら確かめる。y で消す", async () => {
    const stdin = new FakeInput({ tty: true });
    const running = cli.start(["secret", "rm", "github"], { stdin, tty: true });
    await waitFor(() => running.stderr.text.includes("[y/N]"));
    stdin.type("y\n");
    expect((await running.done).code).toBe(0);
    expect(readSecret(secretsPath(), "github")).toBeUndefined();
  });

  it("端末で y 以外なら消さない（終了コード 1）", async () => {
    const stdin = new FakeInput({ tty: true });
    const running = cli.start(["secret", "rm", "github"], { stdin, tty: true });
    await waitFor(() => running.stderr.text.includes("[y/N]"));
    stdin.type("\n");
    expect((await running.done).code).toBe(1);
    expect(readSecret(secretsPath(), "github")).toBeDefined();
  });

  it("端末でなく --yes もなければ、消さない（終了コード 2）", async () => {
    const r = await cli.run(["secret", "rm", "github"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--yes");
    expect(readSecret(secretsPath(), "github")).toBeDefined();
  });

  it("ない ID なら「もしかして」を出す（終了コード 1）", async () => {
    const r = await cli.run(["secret", "rm", "githb", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("github");
    expect(readFileSync(secretsPath(), "utf8")).toContain("github");
  });
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("待ちきれませんでした");
    await new Promise((r) => setTimeout(r, 5));
  }
}
