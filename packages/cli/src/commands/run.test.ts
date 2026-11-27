import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDaemon, startFakeDaemon } from "../testing/fake-daemon.ts";
import { TASK_ID, taskView } from "../testing/fixtures.ts";
import { createTestCli, type TestCli } from "../testing/harness.ts";

let cli: TestCli;
let daemon: FakeDaemon;
beforeEach(async () => {
  cli = createTestCli();
  await cli.run(["init"]);
  daemon = await startFakeDaemon(cli.home);
  daemon.on("POST /tasks", (req) => ({
    status: 201,
    body: { task: taskView({ ...(req.body as object) }) },
  }));
});
afterEach(async () => {
  await daemon.close();
  cli.cleanup();
});

const base = [
  "run",
  "dev-implementer",
  "--purpose",
  "README の誤字を直す",
  "--done-when",
  "PR を出した",
];

describe("9.1 aicoop run：POST /tasks で手動のタスクを作る", () => {
  it("Bearer のトークンを付けて送り、作ったタスクの ID と次の案内を出す", async () => {
    const r = await cli.run(base);
    expect(r.code, r.stderr).toBe(0);
    const req = daemon.requests.find((x) => x.method === "POST" && x.path === "/tasks");
    expect(req?.authorization).toBe("Bearer test-api-token-0123456789");
    expect(req?.body).toEqual({
      member: "dev-implementer",
      purpose: "README の誤字を直す",
      done_when: "PR を出した",
    });
    expect(r.stdout).toContain(TASK_ID);
    expect(r.stdout).toContain(`aicoop logs ${TASK_ID}`);
    expect(r.stdout).toContain("aicoop tasks");
    expect(r.stdout).not.toContain("test-api-token");
  });

  it("--context・--thread・--timeout を送る", async () => {
    await cli.run([...base, "--context", "背景", "--thread", "readme", "--timeout", "30"]);
    expect(daemon.requests.at(-1)?.body).toMatchObject({
      context: "背景",
      thread: "readme",
      timeout_minutes: 30,
    });
  });

  it("--json はタスクをそのまま出す", async () => {
    const r = await cli.run([...base, "--json"]);
    expect(JSON.parse(r.stdout).id).toBe(TASK_ID);
  });
});

describe("aicoop run の拒否される側（API を呼ぶ前に止める。終了コード 2）", () => {
  for (const [name, args] of [
    ["--timeout が 55 を超える（5.5.5）", [...base, "--timeout", "56"]],
    ["--timeout が 0", [...base, "--timeout", "0"]],
    ["--timeout が数でない", [...base, "--timeout", "30分"]],
    ["--purpose がない", ["run", "dev-implementer", "--done-when", "x"]],
    ["--purpose が空", ["run", "dev-implementer", "--purpose", " ", "--done-when", "x"]],
    ["社員の ID の形でない", ["run", "Dev Impl", "--purpose", "p", "--done-when", "d"]],
  ] as const) {
    it(name, async () => {
      const r = await cli.run([...args]);
      expect(r.code).toBe(2);
      expect(daemon.requests.filter((x) => x.method === "POST")).toHaveLength(0);
    });
  }

  it("知らない社員なら、members.yaml から「もしかして」を出す（終了コード 1）", async () => {
    daemon.on("POST /tasks", {
      status: 422,
      body: { error: "unknown_member", message: "社員「dev-implementor」は設定にいません" },
    });
    const r = await cli.run(["run", "dev-implementor", "--purpose", "p", "--done-when", "d"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("設定にいません");
    expect(r.stderr).toContain("もしかして dev-implementer");
  });

  it("daemon が動いていなければ aicoop start を案内する（終了コード 3）", async () => {
    await daemon.close();
    const r = await cli.run(base);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("aicoop start");
  });

  it("daemon.json が残っているのに daemon がいない（落ちた）ときも 3", async () => {
    await daemon.closeServer();
    const r = await cli.run(base);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("接続できません");
  });
});

describe("aicoop run --wait：終わるまで待って結果を出す", () => {
  it("done なら要約とファイルを出して 0", async () => {
    const states = ["queued", "running", "running", "done"] as const;
    let i = 0;
    daemon.on(`GET /tasks/${TASK_ID}`, () => {
      const status = states[Math.min(i++, states.length - 1)] ?? "done";
      return {
        body: {
          task: taskView({
            status,
            ...(status === "done" && {
              result_summary: "PR #12 を出しました",
              result_files: ["notes/pr.md"],
            }),
          }),
          runs: [],
        },
      };
    });
    const r = await cli.run([...base, "--wait"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("PR #12 を出しました");
    expect(r.stdout).toContain("notes/pr.md");
    expect(r.stderr).toContain("実行中");
  });

  it("failed なら理由を出して 1", async () => {
    daemon.on(`GET /tasks/${TASK_ID}`, {
      body: { task: taskView({ status: "failed", error: "box_start_failed" }), runs: [] },
    });
    const r = await cli.run([...base, "--wait"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("box_start_failed");
  });

  it("Ctrl+C で待つのをやめる（タスクは続く。終了コード 130）", async () => {
    daemon.on(`GET /tasks/${TASK_ID}`, {
      body: { task: taskView({ status: "running" }), runs: [] },
    });
    const running = cli.start([...base, "--wait"]);
    while (cli.interrupts.count === 0) await new Promise((r) => setTimeout(r, 5));
    cli.interrupts.fire();
    const r = await running.done;
    expect(r.code).toBe(130);
    expect(r.stderr).toContain("動き続けます");
    expect(daemon.requests.some((x) => x.path.endsWith("/cancel"))).toBe(false);
  });
});
