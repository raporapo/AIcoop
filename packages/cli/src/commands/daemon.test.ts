import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildImageOptions } from "@aicoop/box-gondolin";
import type { DaemonInfo, StartRun } from "@aicoop/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDaemon, startFakeDaemon } from "../testing/fake-daemon.ts";
import { createTestCli, type TestCli } from "../testing/harness.ts";
import type { DaemonEntry, StartDaemonOptions } from "./daemon-entry.ts";

const fakeStartRun = (() => {
  throw new Error("呼ばれない");
}) as unknown as StartRun;

interface FakeEntry {
  readonly entry: DaemonEntry;
  readonly calls: StartDaemonOptions[];
  stopCalls: number;
  /** POST /shutdown で止まったことにする */
  shutdown(): void;
}

function fakeEntry(
  options: { readonly fail?: unknown; readonly slowStop?: boolean } = {},
): FakeEntry {
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((r) => {
    resolveStopped = r;
  });
  const result: FakeEntry = {
    calls: [],
    stopCalls: 0,
    shutdown: () => resolveStopped(),
    entry: {
      startRun: fakeStartRun,
      startDaemon: async (opts) => {
        result.calls.push(opts);
        if (options.fail !== undefined) throw options.fail;
        const info: DaemonInfo = {
          pid: 4242,
          port: 7070,
          started_at: "",
          home: opts.home,
          version: "0.0.0",
        };
        return {
          port: 7070,
          info,
          stopped,
          stop: async () => {
            result.stopCalls++;
            if (options.slowStop) await new Promise(() => undefined);
            resolveStopped();
          },
        };
      },
    },
  };
  return result;
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("待ちきれませんでした");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("9.1 aicoop daemon：前面で動かし、Ctrl+C で止める", () => {
  let cli: TestCli;
  let fake: FakeEntry;
  beforeEach(async () => {
    fake = fakeEntry();
    cli = createTestCli({ deps: { loadDaemonEntry: async () => fake.entry } });
    await cli.run(["init"]);
  });
  afterEach(() => cli.cleanup());

  it("startDaemon に home・startRun・ドライバーを渡し、ログは標準出力（logToStdout）", async () => {
    const running = cli.start(["daemon"]);
    await waitFor(() => running.stderr.text.includes("起動しました"));
    expect(fake.calls[0]).toMatchObject({
      home: cli.home,
      startRun: fakeStartRun,
      logToStdout: true,
    });
    expect(running.stderr.text).toContain("Ctrl+C");
    cli.interrupts.fire();
    const r = await running.done;
    expect(r.code).toBe(0);
    expect(fake.stopCalls).toBe(1);
    expect(r.stderr).toContain("止めました");
  });

  it("--background ならログを logs/ に（logToStdout: false）", async () => {
    const running = cli.start(["daemon", "--background"]);
    await waitFor(() => fake.calls.length > 0);
    expect(fake.calls[0]?.logToStdout).toBe(false);
    cli.interrupts.fire();
    await running.done;
  });

  it("POST /shutdown で止まったら、そのまま終わる（終了コード 0）", async () => {
    const running = cli.start(["daemon"]);
    await waitFor(() => fake.calls.length > 0);
    fake.shutdown();
    expect((await running.done).code).toBe(0);
    expect(fake.stopCalls).toBe(0);
  });

  it("止めている途中で、もう一度 Ctrl+C なら待たずに終わる（130）", async () => {
    fake = fakeEntry({ slowStop: true });
    const running = cli.start(["daemon"]);
    await waitFor(() => running.stderr.text.includes("起動しました"));
    cli.interrupts.fire();
    await waitFor(() => running.stderr.text.includes("止めています"));
    cli.interrupts.fire();
    expect((await running.done).code).toBe(130);
  });

  it("設定にエラーがあれば（issues を持つエラー）、check と同じ形で出して 1", async () => {
    fake = fakeEntry({
      fail: Object.assign(new Error("設定にエラーがあります"), {
        issues: [
          {
            code: "E-007",
            message: "triggers.yaml の triggers.0.schedule：cron式が読めません",
            source: "triggers.yaml",
            path: "triggers.0.schedule",
          },
        ],
      }),
    });
    const r = await cli.run(["daemon"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("E-007");
    expect(r.stderr).toContain("triggers.0.schedule");
  });

  it("すでに動いていれば 1", async () => {
    const other = await startFakeDaemon(cli.home);
    other.on("GET /status", { body: {} });
    try {
      const r = await cli.run(["daemon"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("すでに動いています");
      expect(fake.calls).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it("制御サーバーの本体がまだ入っていない版なら、そう言って 1", async () => {
    const empty = createTestCli();
    try {
      await empty.run(["init"]);
      const r = await empty.run(["daemon"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("まだ制御サーバーの本体が入っていません");
    } finally {
      empty.cleanup();
    }
  });

  it("vm の箱が動かない OS では、そう知らせてから起動する", async () => {
    const win = createTestCli({
      platform: "win32",
      deps: { loadDaemonEntry: async () => fake.entry },
    });
    try {
      await win.run(["init"]);
      const running = win.start(["daemon"]);
      await waitFor(() => running.stderr.text.includes("起動しました"));
      expect(running.stderr.text).toContain("WSL2");
      win.interrupts.fire();
      await running.done;
    } finally {
      win.cleanup();
    }
  });
});

describe("9.1 aicoop start：裏で起動し、API が応答するまで待つ", () => {
  let cli: TestCli;
  let spawned: FakeDaemon | undefined;
  let spawnCalls: { home: string; logFile: string }[];
  beforeEach(async () => {
    spawnCalls = [];
    spawned = undefined;
    cli = createTestCli({
      deps: {
        loadDaemonEntry: async () => fakeEntry().entry,
        spawnDaemon: (home, logFile) => {
          spawnCalls.push({ home, logFile });
          void startFakeDaemon(home, { pid: 9999 }).then((d) => {
            d.on("GET /status", { body: {} });
            spawned = d;
          });
          return { pid: 9999, exited: new Promise(() => undefined) };
        },
      },
    });
    await cli.run(["init"]);
  });
  afterEach(async () => {
    await spawned?.close();
    cli.cleanup();
  });

  it("起こして、応答したら「起動しました（ポート…）」", async () => {
    const r = await cli.run(["start"]);
    expect(r.code, r.stderr).toBe(0);
    expect(spawnCalls).toEqual([
      { home: cli.home, logFile: join(cli.home, "logs", "daemon-console.log") },
    ]);
    expect(r.stdout).toContain("起動しました");
    expect(r.stdout).toContain(`127.0.0.1:${spawned?.port}`);
  });

  it("すでに動いていれば、何もしない（0）", async () => {
    const other = await startFakeDaemon(cli.home);
    other.on("GET /status", { body: {} });
    try {
      const r = await cli.run(["start"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("すでに動いています");
      expect(spawnCalls).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it("制御サーバーの本体がまだ入っていない版なら、起こさずにそう言う（1）", async () => {
    const missing = createTestCli({
      deps: {
        spawnDaemon: (home, logFile) => {
          spawnCalls.push({ home, logFile });
          return { pid: 1, exited: Promise.resolve(1) };
        },
      },
    });
    try {
      await missing.run(["init"]);
      const r = await missing.run(["start"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("まだ制御サーバーの本体が入っていません");
      expect(spawnCalls).toHaveLength(0);
    } finally {
      missing.cleanup();
    }
  });

  it("設定にエラーがあれば、起こさずに issues を出す（1）", async () => {
    const path = join(cli.home, "aicoop.yaml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("max_concurrent_boxes: 3", "max_concurrent_boxes: 99"),
    );
    const r = await cli.run(["start"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("daemon.max_concurrent_boxes");
    expect(spawnCalls).toHaveLength(0);
  });

  it("起こした daemon がすぐ終わったら、ログの最後を見せる（1）", async () => {
    const crashing = createTestCli({
      deps: {
        loadDaemonEntry: async () => fakeEntry().entry,
        spawnDaemon: (_home, logFile) => {
          writeFileSync(logFile, "起動の準備\nError: listen EADDRINUSE 127.0.0.1:7070\n");
          return { pid: 9998, exited: Promise.resolve(1) };
        },
      },
    });
    try {
      await crashing.run(["init"]);
      const r = await crashing.run(["start"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("すぐに終わりました");
      expect(r.stderr).toContain("EADDRINUSE");
    } finally {
      crashing.cleanup();
    }
  });

  it("待っても応答しなければ 1", async () => {
    const silent = createTestCli({
      deps: {
        loadDaemonEntry: async () => fakeEntry().entry,
        spawnDaemon: () => ({ pid: 9997, exited: new Promise(() => undefined) }),
        sleep: async () => undefined,
      },
    });
    try {
      await silent.run(["init"]);
      const r = await silent.run(["start"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("応答しません");
    } finally {
      silent.cleanup();
    }
  });
});

describe("9.1 aicoop stop：POST /shutdown で止め、止まるまで待つ", () => {
  let cli: TestCli;
  let alive: boolean;
  beforeEach(async () => {
    alive = true;
    cli = createTestCli({ deps: { isProcessAlive: () => alive } });
    await cli.run(["init"]);
  });
  afterEach(() => cli.cleanup());

  it("止まったら「止めました」（0）", async () => {
    const d = await startFakeDaemon(cli.home, { pid: 5555 });
    d.on("GET /status", { body: {} });
    d.on("POST /shutdown", () => {
      setTimeout(() => {
        void d.close();
        alive = false;
      }, 20);
      return { body: { ok: true } };
    });
    const r = await cli.run(["stop"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("止めました");
    expect(d.requests.some((x) => x.method === "POST" && x.path === "/shutdown")).toBe(true);
  });

  it("動いていなければ、何もしない（0）", async () => {
    const r = await cli.run(["stop"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("動いていません");
  });

  it("API が止まってもプロセスが残れば 1", async () => {
    const d = await startFakeDaemon(cli.home, { pid: 5556 });
    d.on("GET /status", { body: {} });
    d.on("POST /shutdown", () => {
      setTimeout(() => void d.close(), 10);
      return { body: { ok: true } };
    });
    const r = await cli.run(["stop"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("5556");
  });
});

describe("9.1 aicoop image build：buildImage でイメージを作る（5.1.8）", () => {
  let cli: TestCli;
  let builds: BuildImageOptions[];
  let failWith: Error | undefined;
  beforeEach(async () => {
    builds = [];
    failWith = undefined;
    cli = createTestCli({
      deps: {
        buildImage: async (options) => {
          builds.push(options);
          if (failWith) throw failWith;
          return {
            outputDir: options.outputDir,
            claudeCodeVersion: options.claudeCodeVersion ?? "2.3.4",
            packages: ["git", ...(options.packages ?? [])],
          };
        },
      },
    });
    await cli.run(["init"]);
  });
  afterEach(() => cli.cleanup());

  it("ベースと、packages のある vm の部署（雛形では dev）のイメージを作り、進み具合を出す", async () => {
    const r = await cli.run(["image", "build"]);
    expect(r.code, r.stderr).toBe(0);
    expect(builds.map((b) => b.outputDir)).toEqual([
      join(cli.home, "images", "base"),
      join(cli.home, "images", "groups", "dev"),
    ]);
    expect(builds[1]?.packages).toEqual(["nodejs", "npm"]);
    expect(builds.every((b) => b.verbose === true)).toBe(true);
    expect(r.stderr).toContain("[1/2]");
    expect(r.stderr).toContain("[2/2]");
    expect(r.stdout).toContain("Claude Code 2.3.4");
  });

  it("--group dev はその部署だけ。--claude-version を渡す", async () => {
    const r = await cli.run(["image", "build", "--group", "dev", "--claude-version", "2.1.3"]);
    expect(r.code).toBe(0);
    expect(builds).toHaveLength(1);
    expect(builds[0]).toMatchObject({ packages: ["nodejs", "npm"], claudeCodeVersion: "2.1.3" });
  });

  it("packages のない部署は、ベースを使うと言って作らない（0）", async () => {
    const r = await cli.run(["image", "build", "--group", "sales"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ベースイメージ");
    expect(builds).toHaveLength(0);
  });

  it("ない部署には「もしかして」（2）。版の形が違えば 2", async () => {
    const r = await cli.run(["image", "build", "--group", "deev"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("もしかして dev");
    expect((await cli.run(["image", "build", "--claude-version", "v2"])).code).toBe(2);
    expect(builds).toHaveLength(0);
  });

  it("作れなければ、理由と直し方を出す（1）", async () => {
    failWith = new Error("Claude Code を取ってこられません（HTTP 503）");
    const r = await cli.run(["image", "build"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("HTTP 503");
    expect(r.stderr).toContain("aicoop check");
  });

  it("Windows では作れない（WSL2 を案内。1）", async () => {
    const win = createTestCli({ platform: "win32" });
    try {
      await win.run(["init"]);
      const r = await win.run(["image", "build"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("WSL2");
    } finally {
      win.cleanup();
    }
  });
});
