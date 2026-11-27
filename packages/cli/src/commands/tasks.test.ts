import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDaemon, startFakeDaemon } from "../testing/fake-daemon.ts";
import { statusResponse, TASK_ID, taskView } from "../testing/fixtures.ts";
import { createTestCli, type TestCli } from "../testing/harness.ts";
import { displayWidth } from "../ui/text.ts";

let cli: TestCli;
let daemon: FakeDaemon;
beforeEach(async () => {
  cli = createTestCli();
  await cli.run(["init"]);
  daemon = await startFakeDaemon(cli.home);
});
afterEach(async () => {
  await daemon.close();
  cli.cleanup();
});

const tasks = [
  taskView({
    status: "running",
    purpose: "README の誤字を直す",
    started_at: "2026-11-27T23:31:00.000Z",
  }),
  taskView({
    id: "t_01JD6V8X3S0Q5W7KQ9M2T4R6YD",
    status: "done",
    member_id: "sales-researcher",
    group_id: "sales",
    purpose: "競合を調べる",
  }),
];

describe("9.1 aicoop tasks：GET /tasks", () => {
  it("列をそろえた表で出す。時刻は timezone（Asia/Tokyo）", async () => {
    daemon.on("GET /tasks", { body: { tasks } });
    const r = await cli.run(["tasks"]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.split("\n").filter((l) => l.includes("t_01"));
    expect(lines).toHaveLength(2);
    expect(r.stdout).toContain("実行中");
    expect(r.stdout).toContain("完了");
    expect(r.stdout).toContain("11-28 08:30");
    expect(r.stdout).toContain("Asia/Tokyo");
    // 色の符号はパイプでは付けない
    expect(r.stdout).not.toContain("\u001b[");
  });

  it("端末なら色を付け、幅に収める。NO_COLOR・--no-color では付けない", async () => {
    daemon.on("GET /tasks", {
      body: { tasks: [taskView({ purpose: "とても長い目的".repeat(20) })] },
    });
    const tty = await cli.run(["tasks"], { tty: true, columns: 80 });
    expect(tty.stdout).toContain("\u001b[");
    for (const line of tty.stdout.split("\n")) {
      expect(displayWidth(line)).toBeLessThanOrEqual(80);
    }
    expect((await cli.run(["tasks"], { tty: true, env: { NO_COLOR: "1" } })).stdout).not.toContain(
      "\u001b[",
    );
    expect((await cli.run(["tasks", "--no-color"], { tty: true })).stdout).not.toContain("\u001b[");
  });

  it("--status と --limit を送る", async () => {
    daemon.on("GET /tasks", { body: { tasks: [] } });
    await cli.run(["tasks", "--status", "running,queued", "--limit", "5"]);
    const q = daemon.requests.at(-1)?.query;
    expect(q?.get("status")).toBe("running,queued");
    expect(q?.get("limit")).toBe("5");
  });

  it("知らない状態は、送る前に止めて「もしかして」を出す（終了コード 2）", async () => {
    const r = await cli.run(["tasks", "--status", "runnig"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("もしかして running");
    expect(daemon.requests).toHaveLength(0);
    expect((await cli.run(["tasks", "--limit", "0"])).code).toBe(2);
    expect((await cli.run(["tasks", "--limit", "501"])).code).toBe(2);
  });

  it("--json", async () => {
    daemon.on("GET /tasks", { body: { tasks } });
    const r = await cli.run(["tasks", "--json"]);
    expect(JSON.parse(r.stdout).map((t: { id: string }) => t.id)).toEqual(tasks.map((t) => t.id));
  });

  it("1件もなければ、aicoop run を案内する", async () => {
    daemon.on("GET /tasks", { body: { tasks: [] } });
    const r = await cli.run(["tasks"]);
    expect(r.stdout).toContain("aicoop run");
  });

  it("目的に端末の制御符号があっても、そのままは出さない", async () => {
    daemon.on("GET /tasks", {
      body: { tasks: [taskView({ purpose: "a\u001b]0;pwned\u0007\u001b[2Jb" })] },
    });
    const r = await cli.run(["tasks"], { tty: true });
    expect(r.stdout).not.toContain("\u001b]0;");
    expect(r.stdout).not.toContain("\u001b[2J");
  });

  it("daemon が動いていなければ 3", async () => {
    await daemon.close();
    const r = await cli.run(["tasks"]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("aicoop start");
  });
});

describe("9.1 aicoop status：GET /status", () => {
  it("箱・タスクの件数・利用枠・トリガーの次の時刻・警告を出す", async () => {
    daemon.on("GET /status", {
      body: statusResponse({
        warnings: [
          {
            code: "W-002",
            message: "groups.yaml の groups.sales：持ち出しの危険",
            source: "groups.yaml",
            path: "groups.sales",
          },
        ],
      }),
    });
    const r = await cli.run(["status"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("テスト商会");
    expect(r.stdout).toContain("1 / 3");
    expect(r.stdout).toContain("dev-implementer");
    expect(r.stdout).toContain("実行中 1");
    expect(r.stdout).toContain("順番待ち 2");
    expect(r.stdout).toContain("使える");
    expect(r.stdout).toContain("42%");
    // 次の時刻は Asia/Tokyo
    expect(r.stdout).toContain("2026-11-29 00:00");
    expect(r.stdout).toContain("止めてある");
    expect(r.stdout).toContain("W-002");
  });

  it("--json は応答をそのまま出す", async () => {
    daemon.on("GET /status", { body: statusResponse() });
    const r = await cli.run(["status", "--json"]);
    expect(JSON.parse(r.stdout).company.name).toBe("テスト商会");
  });

  it("daemon が動いていなければ 3", async () => {
    await daemon.close();
    expect((await cli.run(["status"])).code).toBe(3);
  });
});

describe("9.1 aicoop cancel：POST /tasks/{id}/cancel", () => {
  it("取り消して、動いていたかを出す", async () => {
    daemon.on(`POST /tasks/${TASK_ID}/cancel`, {
      body: { task: taskView({ status: "cancelled" }), was_active: true },
    });
    const r = await cli.run(["cancel", TASK_ID]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("取り消しました");
    expect(r.stdout).toContain("止めました");
  });

  it("終わったタスクは取り消せない（invalid_state。終了コード 1）", async () => {
    daemon.on(`POST /tasks/${TASK_ID}/cancel`, {
      status: 409,
      body: { error: "invalid_state", message: "終わったタスクは取り消せません" },
    });
    const r = await cli.run(["cancel", TASK_ID]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("終わったタスクは取り消せません");
  });

  it("ない ID（not_found）は 1", async () => {
    const r = await cli.run(["cancel", TASK_ID]);
    expect(r.code).toBe(1);
  });

  it("タスクの ID の形でなければ、送らずに 2", async () => {
    const r = await cli.run(["cancel", "t_123"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("t_");
    expect(daemon.requests).toHaveLength(0);
  });
});

describe("9.1 aicoop reload：POST /reload", () => {
  it("読み直したら、警告とともに知らせる", async () => {
    daemon.on("POST /reload", {
      body: {
        ok: true,
        warnings: [{ code: "W-001", message: "効かない操作があります", source: "roles.yaml" }],
        files: { "aicoop.yaml": "ab" },
      },
    });
    const r = await cli.run(["reload"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("読み直しました");
    expect(r.stdout).toContain("W-001");
  });

  it("422 なら、aicoop check と同じ形で issues を出し、前の設定のままと伝える（終了コード 1）", async () => {
    daemon.on("POST /reload", {
      status: 422,
      body: {
        error: "config_invalid",
        message: "設定にエラーがあります",
        issues: [
          {
            code: "E-013",
            message: "aicoop.yaml の task.timeout_minutes：55以下にしてください",
            source: "aicoop.yaml",
            path: "task.timeout_minutes",
          },
        ],
      },
    });
    const r = await cli.run(["reload"]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("E-013");
    expect(r.stdout + r.stderr).toContain("task.timeout_minutes");
    expect(r.stdout + r.stderr).toContain("前の設定のまま");
  });

  it("daemon が動いていなければ 3", async () => {
    await daemon.close();
    expect((await cli.run(["reload"])).code).toBe(3);
  });
});
