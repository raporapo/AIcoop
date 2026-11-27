import { describe, expect, it } from "vitest";
import { COMMANDS } from "./registry.ts";
import { createTestCli } from "./testing/harness.ts";

const cli = createTestCli();

describe("11.7：使い方（--help）は日本語で、例と関連するコマンドを出す", () => {
  it("aicoop --help・aicoop help・引数なしは、コマンドの一覧（終了コード 0）", async () => {
    for (const args of [["--help"], ["-h"], ["help"], []]) {
      const r = await cli.run(args);
      expect(r.code, args.join(" ")).toBe(0);
      expect(r.stdout).toContain("使い方");
      for (const c of COMMANDS) expect(r.stdout).toContain(c.name);
      expect(r.stdout).toContain("--home <dir>");
    }
  });

  it("9.1 の P1 の行がすべてある", () => {
    const names = COMMANDS.map((c) => c.name);
    for (const name of [
      "init",
      "check",
      "image build",
      "daemon",
      "start",
      "stop",
      "reload",
      "secret set",
      "secret list",
      "secret rm",
      "run",
      "tasks",
      "status",
      "logs",
      "cancel",
      "audit verify",
    ]) {
      expect(names).toContain(name);
    }
  });

  it("9.1 の P2 の行（pair・devices・devices revoke）がある。承認をするコマンドはない（P-4）", () => {
    const names = COMMANDS.map((c) => c.name);
    for (const name of ["pair", "devices", "devices revoke"]) expect(names).toContain(name);
    for (const name of names) expect(name).not.toMatch(/approv|reject|accept|sign/);
  });

  it("どのコマンドにも、使い方・例・関連するコマンドがある", async () => {
    for (const c of COMMANDS) {
      const r = await cli.run([...c.name.split(" "), "--help"]);
      expect(r.code, c.name).toBe(0);
      expect(r.stdout, c.name).toContain(`aicoop ${c.name}`);
      expect(r.stdout, c.name).toContain("例");
      expect(r.stdout, c.name).toContain("関連するコマンド");
      expect(r.stdout, c.name).not.toContain("--force");
      // help は副作用を起こさない（init が home を作らない）
    }
    const { existsSync } = await import("node:fs");
    expect(existsSync(cli.home)).toBe(false);
  });

  it("aicoop help <コマンド> と aicoop <まとまり> --help", async () => {
    expect((await cli.run(["help", "run"])).stdout).toContain("--purpose <文>");
    const group = await cli.run(["secret", "--help"]);
    expect(group.code).toBe(0);
    expect(group.stdout).toContain("secret set");
    expect(group.stdout).toContain("secret rm");
  });

  it("--version", async () => {
    const r = await cli.run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^aicoop \d+\.\d+\.\d+/);
  });

  it("パイプでは色を付けない。端末では付ける", async () => {
    expect((await cli.run(["--help"])).stdout).not.toContain("\u001b[");
    expect((await cli.run(["--help"], { tty: true })).stdout).toContain("\u001b[");
    expect((await cli.run(["--help", "--no-color"], { tty: true })).stdout).not.toContain(
      "\u001b[",
    );
    expect((await cli.run(["--help"], { tty: true, env: { NO_COLOR: "1" } })).stdout).not.toContain(
      "\u001b[",
    );
  });
});

describe("11.7：知らないコマンド・オプションには「もしかして」（終了コード 2）", () => {
  it("打ち間違い", async () => {
    const r = await cli.run(["stauts"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("知らないコマンドです：stauts");
    expect(r.stderr).toContain("もしかして aicoop status");
    expect(r.stderr).toContain("aicoop --help");
  });

  it("よくある別の言い方は、正しいコマンドを案内する", async () => {
    expect((await cli.run(["ps"])).stderr).toContain("aicoop tasks");
    expect((await cli.run(["secret", "ls"])).stderr).toContain("aicoop secret list");
    expect((await cli.run(["restart"])).stderr).toContain("aicoop stop");
  });

  it("まとまりの中の打ち間違い・まとまりの名前の打ち間違い", async () => {
    const r = await cli.run(["secret", "lsit"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("aicoop secret list");
    const g = await cli.run(["scret", "list"]);
    expect(g.code).toBe(2);
    expect(g.stderr).toContain("もしかして aicoop secret list");
  });

  it("まとまりだけ（aicoop secret）なら、続けて書くものを出す", async () => {
    const r = await cli.run(["secret"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("aicoop secret set");
  });

  it("コマンドの前の知らないオプション", async () => {
    const r = await cli.run(["--hme", "x", "status"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("もしかして --home");
  });

  it("コマンドの知らないオプション", async () => {
    const r = await cli.run(["tasks", "--stauts", "done"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("もしかして --status");
    expect(r.stderr).toContain("aicoop tasks --help");
  });

  it("--home は、コマンドの前でも後でもよい", async () => {
    const before = await cli.run(["--home", "elsewhere", "check"]);
    const after = await cli.run(["check", "--home", "elsewhere"]);
    expect(before.stderr).toContain("elsewhere");
    expect(after.stderr).toContain("elsewhere");
  });

  it("思いがけない失敗は、短く知らせて 1。AICOOP_DEBUG=1 で詳しく", async () => {
    const broken = createTestCli({
      deps: {
        loadDaemonEntry: async () => {
          throw new Error("boom");
        },
      },
    });
    try {
      await broken.run(["init"]);
      const r = await broken.run(["daemon"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("思いがけないエラーが起きました：boom");
      expect(r.stderr).toContain("AICOOP_DEBUG=1");
      expect(r.stderr).not.toMatch(/\n\s+at /);
      const debug = await broken.run(["daemon"], { env: { AICOOP_DEBUG: "1" } });
      expect(debug.stderr).toMatch(/\n\s+at /);
    } finally {
      broken.cleanup();
    }
  });

  it("fetch そのものが失敗したら、接続できないとして 3", async () => {
    const broken = createTestCli({
      deps: {
        fetch: () => {
          throw new TypeError("fetch failed");
        },
      },
    });
    try {
      await broken.run(["init"]);
      const { startFakeDaemon } = await import("./testing/fake-daemon.ts");
      const d = await startFakeDaemon(broken.home);
      try {
        const r = await broken.run(["status"]);
        expect(r.code).toBe(3);
      } finally {
        await d.close();
      }
    } finally {
      broken.cleanup();
    }
  });
});
