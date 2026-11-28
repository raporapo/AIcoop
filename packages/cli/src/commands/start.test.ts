import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonInfo, StartRun } from "@aicoop/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDaemon, startFakeDaemon } from "../testing/fake-daemon.ts";
import { statusResponse } from "../testing/fixtures.ts";
import { createTestCli, type TestCli } from "../testing/harness.ts";
import type { DaemonEntry } from "./daemon-entry.ts";

const entry: DaemonEntry = {
  startRun: (() => {
    throw new Error("呼ばれない");
  }) as unknown as StartRun,
  startDaemon: async (opts) => {
    const info: DaemonInfo = { pid: 1, port: 1, started_at: "", home: opts.home, version: "" };
    return {
      port: 1,
      info,
      token: "t",
      stopped: new Promise(() => undefined),
      stop: async () => undefined,
    };
  },
};

describe("5.14 の1 aicoop start --autostart：Windows のログオン時の自動起動", () => {
  let cli: TestCli;
  let spawned: FakeDaemon | undefined;
  let spawnCalls: number;
  const log = () => join(cli.home, "logs", "autostart.log");
  beforeEach(() => {
    spawnCalls = 0;
    spawned = undefined;
    cli = createTestCli({
      deps: {
        loadDaemonEntry: async () => entry,
        spawnDaemon: (home) => {
          spawnCalls++;
          void startFakeDaemon(home, { pid: 9999 }).then((d) => {
            d.on("GET /status", { body: statusResponse() });
            spawned = d;
          });
          return { pid: 9999, exited: new Promise(() => undefined) };
        },
      },
    });
  });
  afterEach(async () => {
    await spawned?.close();
    cli.cleanup();
  });

  it("設定（aicoop.yaml）がなければ何もしない（0。フォルダもログも作らない）", async () => {
    const r = await cli.run(["start", "--autostart"]);
    expect(r.code).toBe(0);
    expect(spawnCalls).toBe(0);
    expect(existsSync(cli.home)).toBe(false);
  });

  it("動いていれば何もしない（0。ログにも書かない）", async () => {
    await cli.run(["init"]);
    const other = await startFakeDaemon(cli.home);
    other.on("GET /status", { body: statusResponse() });
    try {
      const r = await cli.run(["start", "--autostart"]);
      expect(r.code).toBe(0);
      expect(spawnCalls).toBe(0);
      expect(existsSync(log())).toBe(false);
    } finally {
      await other.close();
    }
  });

  it("動いていなければ起動し、時刻と結果を logs/autostart.log に足す", async () => {
    await cli.run(["init"]);
    const r = await cli.run(["start", "--autostart"]);
    expect(r.code, r.stderr).toBe(0);
    expect(spawnCalls).toBe(1);
    const text = readFileSync(log(), "utf8");
    expect(text).toMatch(/^== \d{4}-\d\d-\d\dT.* 自動起動$/m);
    expect(text).toContain("起動しました");
    expect(text).not.toContain("\u001b");
  });

  it("起動できなければ、理由を logs/autostart.log に書いて 1", async () => {
    await cli.run(["init"]);
    const path = join(cli.home, "aicoop.yaml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("max_concurrent_boxes: 3", "max_concurrent_boxes: 99"),
    );
    const r = await cli.run(["start", "--autostart"]);
    expect(r.code).toBe(1);
    expect(spawnCalls).toBe(0);
    expect(readFileSync(log(), "utf8")).toContain("daemon.max_concurrent_boxes");
  });
});
