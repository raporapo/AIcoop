import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunView, TaskView } from "@aicoop/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDaemon, startFakeDaemon } from "../testing/fake-daemon.ts";
import { RUN_ID, runView, TASK_ID, taskView } from "../testing/fixtures.ts";
import { createTestCli, type TestCli } from "../testing/harness.ts";

let cli: TestCli;
let daemon: FakeDaemon;
let logPath: string;
let state: { task: TaskView; runs: RunView[] };

const lines = [
  { type: "system", subtype: "init", session_id: "sess-1234abcd", model: "sonnet" },
  { type: "assistant", message: { content: [{ type: "text", text: "README を直します" }] } },
  {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "git status" } }],
    },
  },
  { type: "result", subtype: "success", is_error: false, num_turns: 3, duration_ms: 5000 },
].map((e) => JSON.stringify(e));

beforeEach(async () => {
  cli = createTestCli();
  await cli.run(["init"]);
  daemon = await startFakeDaemon(cli.home);
  logPath = join(cli.home, "logs", "runs", `${RUN_ID}.jsonl`);
  mkdirSync(join(cli.home, "logs", "runs"), { recursive: true });
  state = {
    task: taskView({ status: "done", result_summary: "PR を出しました" }),
    runs: [
      runView({
        log_path: logPath,
        ended_at: "2026-11-27T23:40:00.000Z",
        end_reason: "exited",
        exit_code: 0,
      }),
    ],
  };
  daemon.on(`GET /tasks/${TASK_ID}`, () => ({ body: state }));
});
afterEach(async () => {
  await daemon.close();
  cli.cleanup();
});

describe("9.1 aicoop logs：実行ごとの log_path（stream-json）を読んで表示する", () => {
  it("人が読める形で、実行ごとに見出しを付け、最後にタスクの結果を出す", async () => {
    writeFileSync(logPath, `${lines.join("\n")}\n`);
    const r = await cli.run(["logs", TASK_ID]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(RUN_ID);
    expect(r.stdout).toContain("● 開始");
    expect(r.stdout).toContain("Claude：README を直します");
    expect(r.stdout).toContain("→ Bash：git status");
    expect(r.stdout).toContain("■ 終了");
    expect(r.stdout).toContain("PR を出しました");
    expect(r.stdout).not.toContain('"type"');
  });

  it("--raw は stream-json をそのまま出す（jq に渡せる）", async () => {
    writeFileSync(logPath, `${lines.join("\n")}\n`);
    const r = await cli.run(["logs", TASK_ID, "--raw"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual(lines);
  });

  it("まだ実行されていなければ、そう言う", async () => {
    state = { task: taskView({ status: "queued" }), runs: [] };
    const r = await cli.run(["logs", TASK_ID]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toContain("まだ実行されていません");
    expect(r.stdout + r.stderr).toContain("--follow");
  });

  it("記録のファイルがなければ、場所とともに知らせる", async () => {
    const r = await cli.run(["logs", TASK_ID]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toContain("記録のファイルがありません");
  });

  it("log_path が ~/.aicoop/logs/runs の外なら読まない（拒否側に倒す）", async () => {
    const outside = join(cli.userHome, "secret.txt");
    writeFileSync(outside, "TOPSECRET\n");
    state = { ...state, runs: [runView({ log_path: outside })] };
    const r = await cli.run(["logs", TASK_ID, "--raw"]);
    expect(r.stdout).not.toContain("TOPSECRET");
    expect(r.stderr).toContain("読みません");
  });

  it("--follow：終わるまで、増えた分を出し続ける", async () => {
    state = {
      task: taskView({ status: "running" }),
      runs: [runView({ log_path: logPath })],
    };
    writeFileSync(logPath, `${lines[0]}\n`);
    const running = cli.start(["logs", TASK_ID, "--follow"]);
    await waitFor(() => running.stdout.text.includes("● 開始"));
    appendFileSync(logPath, `${lines[1]}\n${(lines[2] ?? "").slice(0, 20)}`);
    await waitFor(() => running.stdout.text.includes("README を直します"));
    // 行の途中までしか書かれていないものは、書き終わるまで出さない
    expect(running.stdout.text).not.toContain("git status");
    appendFileSync(logPath, `${(lines[2] ?? "").slice(20)}\n${lines[3]}\n`);
    await waitFor(() => running.stdout.text.includes("■ 終了"));
    state = { task: taskView({ status: "done", result_summary: "できた" }), runs: state.runs };
    const r = await running.done;
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("git status");
    expect(r.stdout).toContain("できた");
  });

  it("--follow で、まだ始まっていなければ、始まるのを待つ。Ctrl+C で止める（130）", async () => {
    state = { task: taskView({ status: "queued" }), runs: [] };
    const running = cli.start(["logs", TASK_ID, "--follow"]);
    await waitFor(() => running.stderr.text.includes("待っています"));
    state = { task: taskView({ status: "running" }), runs: [runView({ log_path: logPath })] };
    writeFileSync(logPath, `${lines[0]}\n`);
    await waitFor(() => running.stdout.text.includes("● 開始"));
    cli.interrupts.fire();
    expect((await running.done).code).toBe(130);
  });

  it("タスクの ID の形でなければ 2、daemon がなければ 3", async () => {
    expect((await cli.run(["logs", "abc"])).code).toBe(2);
    await daemon.close();
    expect((await cli.run(["logs", TASK_ID])).code).toBe(3);
  });
});

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("待ちきれませんでした");
    await new Promise((r) => setTimeout(r, 5));
  }
}
