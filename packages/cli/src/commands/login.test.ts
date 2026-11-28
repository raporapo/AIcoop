import { join } from "node:path";
import { listAuditLog, openStateDb, readSecret, setSecret } from "@aicoop/daemon";
import { afterEach, describe, expect, it } from "vitest";
import type { CliDeps } from "../context.ts";
import { createTestCli, FakeInput, type RunResult, type TestCli } from "../testing/harness.ts";

const TOKEN = `sk-ant-oat01-TOPSECRET${"x1Y2z3".repeat(12)}AA`;
const SCREEN = `\x1b[1mYour\x1b[1COAuth\x1b[1Ctoken:\x1b[22m\r\n\r\n${TOKEN}\r\n\r\nStore\x1b[1Cthis\x1b[1Ctoken\r\n`;

const tools: CliDeps["which"] = (c) => (c === "claude" || c === "script" ? `/usr/bin/${c}` : null);

let cli: TestCli;
afterEach(() => cli.cleanup());

async function setup(
  deps: Partial<CliDeps> = {},
  platform: NodeJS.Platform = "linux",
): Promise<{ calls: (readonly string[])[] }> {
  const calls: (readonly string[])[] = [];
  cli = createTestCli({
    platform,
    deps: {
      which: tools,
      runInTerminal: async (argv) => {
        calls.push(argv);
        return { exitCode: 0, output: SCREEN };
      },
      ...deps,
    },
  });
  await cli.run(["init"]);
  return { calls };
}

const secret = () => readSecret(join(cli.home, "secrets.json"), "anthropic");

function expectNoLeak(r: RunResult) {
  expect(r.stdout).not.toContain("TOPSECRET");
  expect(r.stderr).not.toContain("TOPSECRET");
}

describe("aicoop login：claude setup-token を動かし、出たトークンを anthropic として保存する", () => {
  it("端末から：setup-token を擬似端末（script）で動かし、トークンを保存して、監査ログに書く", async () => {
    const { calls } = await setup();
    const r = await cli.run(["login"], { tty: true, stdin: new FakeInput({ tty: true }) });
    expect(r.code, r.stderr).toBe(0);
    expect(calls).toEqual([
      ["/usr/bin/script", "-q", "-e", "-f", "-c", "'/usr/bin/claude' setup-token", "/dev/null"],
    ]);
    expect(secret()).toMatchObject({ kind: "anthropic_oauth", value: { token: TOKEN } });
    const db = openStateDb(join(cli.home, "state.db"));
    try {
      const rows = listAuditLog(db);
      expect(rows.at(-1)).toMatchObject({
        kind: "secret.change",
        subject: "anthropic",
        actor: "owner:cli",
      });
      expect(JSON.stringify(rows)).not.toContain("TOPSECRET");
    } finally {
      db.close();
    }
    expect(r.stdout).toContain("Claude にログインしました");
    // setup-token が画面に出したトークンを、画面と端末の履歴から消す
    expect(r.stdout).toContain("\x1b[3J");
    expectNoLeak(r);
  });

  it("macOS では BSD の script の書き方で動かす", async () => {
    const { calls } = await setup({}, "darwin");
    const r = await cli.run(["login"], { tty: true, stdin: new FakeInput({ tty: true }) });
    expect(r.code, r.stderr).toBe(0);
    expect(calls).toEqual([
      ["/usr/bin/script", "-q", "/dev/null", "/usr/bin/claude", "setup-token"],
    ]);
  });

  it("端末でなければ動かさずに 2（ブラウザでのログインと画面の確かめが要る）", async () => {
    const { calls } = await setup();
    const r = await cli.run(["login"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("aicoop secret set anthropic --kind anthropic_oauth");
    expect(calls).toEqual([]);
  });

  it("claude が見つからなければ、入れ方を言う", async () => {
    const { calls } = await setup({ which: (c) => (c === "script" ? "/usr/bin/script" : null) });
    const r = await cli.run(["login"], { tty: true, stdin: new FakeInput({ tty: true }) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("https://claude.ai/install.sh");
    expect(calls).toEqual([]);
  });

  it("Windows では、WSL2 の中で実行するように言う", async () => {
    const { calls } = await setup({}, "win32");
    const r = await cli.run(["login"], { tty: true, stdin: new FakeInput({ tty: true }) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("WSL2");
    expect(calls).toEqual([]);
  });

  it("すでに登録されていれば確かめ、N なら何もしない", async () => {
    const { calls } = await setup();
    setSecret(
      join(cli.home, "secrets.json"),
      "anthropic",
      "anthropic_oauth",
      { token: "sk-ant-oat01-old" },
      new Date(),
    );
    const stdin = new FakeInput({ tty: true });
    const run = cli.start(["login"], { tty: true, stdin });
    stdin.type("n\n");
    const r = await run.done;
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("置き換えますか");
    expect(calls).toEqual([]);
    expect(secret()?.value).toEqual({ token: "sk-ant-oat01-old" });
  });

  it("すでに登録されていても、y なら置き換える", async () => {
    await setup();
    setSecret(
      join(cli.home, "secrets.json"),
      "anthropic",
      "anthropic_oauth",
      { token: "sk-ant-oat01-old" },
      new Date(),
    );
    const stdin = new FakeInput({ tty: true });
    const run = cli.start(["login"], { tty: true, stdin });
    stdin.type("y\n");
    const r = await run.done;
    expect(r.code, r.stderr).toBe(0);
    expect(secret()?.value).toEqual({ token: TOKEN });
    expect(r.stdout).toContain("更新");
  });

  it("画面からトークンを取り出せなければ、貼り付けに切り替える（打った文字は出さない）", async () => {
    await setup({ runInTerminal: async () => ({ exitCode: 0, output: "Welcome\r\n" }) });
    const stdin = new FakeInput({ tty: true });
    const run = cli.start(["login"], { tty: true, stdin });
    await new Promise((r) => setTimeout(r, 20));
    stdin.type(`${TOKEN}\r`);
    const r = await run.done;
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("貼り付けて");
    expect(secret()?.value).toEqual({ token: TOKEN });
    expectNoLeak(r);
  });

  it("setup-token が途中で終わった（Ctrl+C・失敗）なら、何も保存せずに 1", async () => {
    await setup({ runInTerminal: async () => ({ exitCode: 130, output: "Welcome\r\n" }) });
    const r = await cli.run(["login"], { tty: true, stdin: new FakeInput({ tty: true }) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("保存していません");
    expect(secret()).toBeUndefined();
  });

  it("script が見つからなければ、入れ方を言う", async () => {
    await setup({ which: (c) => (c === "claude" ? "/usr/bin/claude" : null) });
    const r = await cli.run(["login"], { tty: true, stdin: new FakeInput({ tty: true }) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("util-linux");
  });
});
