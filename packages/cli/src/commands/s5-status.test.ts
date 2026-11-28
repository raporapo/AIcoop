/**
 * S-5（5.4.6 の4）：利用枠で止まったことと再開予定時刻が、aicoop status・aicoop tasks に出る。
 * 本物の daemon（startDaemon）・本物の実行（createStartRun）と、利用枠で止まる偽の Claude Code の箱で確かめる。
 */
import {
  aicoopPaths,
  createStartRun,
  type DaemonHandle,
  setSecret,
  startDaemon,
} from "@aicoop/daemon";
import type { Box, BoxDriver, ExecHandle, ExecLine } from "@aicoop/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestCli, type TestCli } from "../testing/harness.ts";
import { formatTime } from "../ui/time.ts";

const TZ = "Asia/Tokyo";
let cli: TestCli;
let daemon: DaemonHandle;
/** 利用枠が戻る時刻（rate_limit_event の resetsAt。UNIX 秒） */
const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;

/** 箱の中の偽の Claude Code：init → rate_limit_event（rejected）→ エラーの result を出して、終了コード 1 */
const limitedDriver: BoxDriver = {
  kind: "vm",
  async create(): Promise<Box> {
    return {
      exec(): ExecHandle {
        const lines: ExecLine[] = [
          { type: "system", subtype: "init", session_id: "sess-cli-s5" },
          {
            type: "rate_limit_event",
            rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
          },
          { type: "result", subtype: "error_during_execution", is_error: true, result: "limit" },
        ].map((l) => ({ stream: "stdout", line: JSON.stringify(l) }));
        return {
          exitCode: Promise.resolve(1),
          async *[Symbol.asyncIterator]() {
            yield* lines;
          },
        };
      },
      kill: async () => {},
      destroy: async () => {},
    };
  },
};

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - started > 15_000) throw new Error(`待ちきれませんでした：${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  cli = createTestCli();
  expect((await cli.run(["init"])).code).toBe(0);
  setSecret(aicoopPaths(cli.home).secrets, "anthropic", "anthropic_oauth", {
    token: "s5-cli-test-anthropic-token",
  });
  daemon = await startDaemon({
    home: cli.home,
    startRun: createStartRun({ stopWaitMs: 1000 }),
    drivers: { vm: limitedDriver },
    port: 0,
  });
}, 30_000);

afterAll(async () => {
  await daemon?.stop();
  cli?.cleanup();
});

describe("S-5・5.4.6 の4：利用枠で止まったことと再開予定時刻が、aicoop status・aicoop tasks に出る", () => {
  it("利用枠で止まったタスクは「利用枠待ち」。status には「止まっている」と再開予定時刻、ほかの部署のタスクは順番待ちのまま", async () => {
    const created = await cli.run([
      "run",
      "sales-researcher",
      "--purpose",
      "競合を調べる",
      "--done-when",
      "report_result で報告した",
      "--thread",
      "s5",
      "--json",
    ]);
    expect(created.code, created.stderr).toBe(0);
    const id = JSON.parse(created.stdout).id as string;

    await waitFor("利用枠待ち", async () => {
      const r = await cli.run(["tasks", "--status", "waiting_limit", "--json"]);
      return (JSON.parse(r.stdout) as Array<{ id: string }>).some((t) => t.id === id)
        ? true
        : undefined;
    });

    // ほかの部署（開発部）のタスクも、利用枠が戻るまで始まらない（5.5.4 の4）
    const other = await cli.run([
      "run",
      "dev-implementer",
      "--purpose",
      "README を直す",
      "--done-when",
      "PR を出した",
      "--json",
    ]);
    expect(other.code, other.stderr).toBe(0);

    const status = await cli.run(["status"]);
    expect(status.code, status.stderr).toBe(0);
    const resets = formatTime(new Date(resetsAt * 1000).toISOString(), TZ);
    const usageLine = status.stdout.split("\n").find((l) => l.startsWith("利用枠"));
    expect(usageLine).toContain("止まっている（枠に達した）");
    expect(usageLine).toContain(`${resets} に戻る`);
    expect(usageLine).toContain("five_hour");
    expect(status.stdout).toContain("利用枠待ち 1");
    expect(status.stdout).toContain("順番待ち 1");

    const tasks = await cli.run(["tasks"]);
    expect(tasks.stdout).toContain("利用枠待ち");
    // 1件の詳細には、再開する予定の時刻（再開予定時刻 + 60秒）が出る
    const logs = await cli.run(["logs", id]);
    const retry = formatTime(new Date(resetsAt * 1000 + 60_000).toISOString(), TZ);
    expect(logs.stdout).toContain(`再開予定`);
    expect(logs.stdout).toContain(retry);
  });
});
