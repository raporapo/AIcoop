/**
 * P2 の受け入れ条件 S-5（1.2、5.4.6、5.5.4 の4、8.5）と 5.4.5 の受け入れ条件を、本物の daemon（startDaemon）・
 * 本物の実行（startRun）・偽の箱・手で進める時計で、端から端まで通す。
 *
 * - S-5：偽の Claude Code が init（session_id）→ rate_limit_event（rejected、resetsAt）を出して終わる →
 *   タスクは waiting_limit、retry_at = 再開予定時刻 + 60秒 → そのあいだ、ほかの部署のタスクも始まらない →
 *   時計を進めると queued → 同じセッションに --resume を付けて再開し、報告して done。
 *   GET /usage・GET /status に、状態・再開予定時刻が出る
 * - 5.4.5：手動の --thread（API の thread）で同じスレッドを2回頼むと、2回目は1回目のセッションの続きから始まる
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aicoopPaths } from "../paths.ts";
import { createStartRun } from "../run/execute.ts";
import { setSecret } from "../secrets/store.ts";
import { writeCompanyFiles } from "../testing/company-config.ts";
import { FakeBoxDriver, type FakeClaude, fakeEvents } from "../testing/fake-box.ts";
import { apiRequest, type TestRequest } from "../testing/http.ts";
import { type ManualClock, manualClock } from "../testing/manual-clock.ts";
import { waitUntil } from "../testing/p1-e2e.ts";
import { TEST_ANTHROPIC_TOKEN } from "../testing/run-env.ts";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import { type DaemonHandle, startDaemon } from "./start.ts";

const START = "2026-11-28T00:00:00.000Z";
/** Claude の利用枠が戻る時刻（rate_limit_event の resetsAt。UNIX 秒で来る） */
const RESETS_AT = "2026-11-28T02:00:00.000Z";
/** 5.4.6 の2：再開予定時刻 + 60秒 */
const RETRY_AT = "2026-11-28T02:01:00.000Z";
const MINUTE = 60_000;

interface Exec {
  readonly member: string;
  readonly cmd: readonly string[];
}

let dir: TempDir;
let clock: ManualClock;
let daemon: DaemonHandle;
let driver: FakeBoxDriver;
const execs: Exec[] = [];
/** 開発部の実装AI が、利用枠で止まる回か */
let limitNext = true;

const resumeOf = (cmd: readonly string[]) => {
  const i = cmd.indexOf("--resume");
  return i === -1 ? null : (cmd[i + 1] ?? null);
};

/** 社員ごとの偽の Claude Code */
const claude: FakeClaude = async (c) => {
  execs.push({ member: c.spec.memberId, cmd: c.cmd });
  const resume = resumeOf(c.cmd);
  switch (c.spec.memberId) {
    case "dev-implementer": {
      // --resume なら同じセッションの続き（本物の Claude Code は、続きでも同じ session_id を init に出す）
      c.emit(fakeEvents.init(resume ?? "sess-s5"));
      if (limitNext) {
        limitNext = false;
        // S-5：利用枠に達して止まる（8.5）
        c.emit(
          fakeEvents.rateLimit({
            status: "rejected",
            resetsAt: Date.parse(RESETS_AT) / 1000,
            rateLimitType: "five_hour",
            utilization: 1,
          }),
        );
        c.emit(
          fakeEvents.result({
            is_error: true,
            subtype: "error_during_execution",
            result: `Claude AI usage limit reached|${Date.parse(RESETS_AT) / 1000}`,
          }),
        );
        return 1;
      }
      // 枠が戻ったあと：本物の Claude Code は、最初に今の利用枠の状態（allowed）を出す
      c.emit(
        fakeEvents.rateLimit({
          status: "allowed",
          resetsAt: Date.parse("2026-11-28T07:00:00.000Z") / 1000,
          rateLimitType: "five_hour",
          utilization: 0.05,
        }),
      );
      await c.reportResult(resume === null ? "最初から実装しました" : "続きから実装しました");
      c.emit(fakeEvents.result());
      return 0;
    }
    case "sales-researcher": {
      const n = execs.filter((e) => e.member === "sales-researcher").length;
      c.emit(fakeEvents.init(resume ?? `sess-sales-${n}`));
      await c.reportResult(`調べました（${n}回目）`);
      c.emit(fakeEvents.result());
      return 0;
    }
    default:
      c.emit(fakeEvents.result());
      return 0;
  }
};

const api = (req: TestRequest) => apiRequest(daemon.port, { token: daemon.token, ...req });

async function newTask(member: string, purpose: string, thread?: string): Promise<string> {
  const res = await api({
    method: "POST",
    path: "/tasks",
    body: { member, purpose, done_when: "report_result で報告した", ...(thread && { thread }) },
  });
  expect(res.status, res.text).toBe(201);
  return res.json.task.id as string;
}

async function taskIn(id: string, statuses: readonly string[]) {
  return waitUntil(
    `タスク ${id} が ${statuses.join("・")} になること`,
    async () => {
      const res = await api({ path: `/tasks/${id}` });
      return statuses.includes(res.json.task.status) ? res.json : undefined;
    },
    20_000,
    20,
  );
}

/** 時計を進めたあと、裏で動く実行（非同期）に少し時間を渡す */
const settle = () => new Promise((r) => setTimeout(r, 100));

beforeAll(async () => {
  dir = tempDir();
  const home = join(dir.path, ".aicoop");
  // 既定の会社：開発部 dev（dev-implementer）・営業部 sales（sales-researcher）
  writeCompanyFiles(home);
  setSecret(aicoopPaths(home).secrets, "anthropic", "anthropic_oauth", {
    token: TEST_ANTHROPIC_TOKEN,
  });
  clock = manualClock(START);
  driver = new FakeBoxDriver(claude);
  daemon = await startDaemon({
    home,
    startRun: createStartRun({ stopWaitMs: 2000 }),
    drivers: { vm: driver },
    port: 0,
    now: clock.now,
    timers: clock,
  });
}, 30_000);

afterAll(async () => {
  await daemon?.stop();
  dir?.cleanup();
});

describe("P2 の完了条件：S-5（利用枠で止まったタスクが、再開予定時刻のあとに、同じセッションの続きから再開する）", () => {
  let devTask: string;
  let salesTask: string;

  it("5.4.6 の2・8.5：rate_limit_event（rejected）で止まったら waiting_limit、retry_at は再開予定時刻 + 60秒。セッションは記録してある", async () => {
    devTask = await newTask("dev-implementer", "Issue #42 を実装する", "issue-42");
    const view = await taskIn(devTask, ["waiting_limit", "done", "failed", "done_without_report"]);
    expect(view.task).toMatchObject({ status: "waiting_limit", retry_at: RETRY_AT, error: null });
    expect(view.runs).toHaveLength(1);
    expect(view.runs[0]).toMatchObject({ session_id: "sess-s5", exit_code: 1 });
    expect(resumeOf(execs[0]?.cmd ?? [])).toBeNull();
  });

  it("5.4.6 の1・4：GET /usage と GET /status に、止まっていること・再開予定時刻・枠の種類・使用率が出る", async () => {
    const usage = await api({ path: "/usage" });
    expect(usage.status).toBe(200);
    expect(usage.json.usage).toMatchObject({
      status: "rejected",
      resets_at: RESETS_AT,
      rate_limit_type: "five_hour",
      utilization: 1,
    });
    const status = await api({ path: "/status" });
    expect(status.json.usage).toEqual(usage.json.usage);
    expect(status.json.tasks.waiting_limit).toBe(1);
  });

  it("5.4.6 の3・5.5.4 の4：retry_at までは、ほかの部署のタスクも始まらない（順番待ちのまま。箱を起こさない）", async () => {
    const boxes = driver.boxes.length;
    salesTask = await newTask("sales-researcher", "見込み客を調べる");
    await settle();
    expect((await api({ path: `/tasks/${salesTask}` })).json.task.status).toBe("queued");

    // 再開予定時刻（resetsAt）を過ぎても、60秒のあいだはまだ始めない
    clock.advanceTo("2026-11-28T02:00:30.000Z");
    await settle();
    expect((await api({ path: `/tasks/${devTask}` })).json.task.status).toBe("waiting_limit");
    expect((await api({ path: `/tasks/${salesTask}` })).json.task.status).toBe("queued");
    expect(driver.boxes).toHaveLength(boxes);
  });

  it("5.5.3・8.5：retry_at を過ぎると queued に戻り、同じスレッドを --resume <最初のセッション> で再開して、報告して done", async () => {
    clock.advance(MINUTE);
    const view = await taskIn(devTask, ["done", "failed", "done_without_report", "waiting_limit"]);
    expect(view.task).toMatchObject({
      status: "done",
      thread: "issue-42",
      result_summary: "続きから実装しました",
    });
    expect(view.runs).toHaveLength(2);
    expect(view.runs.map((r: { session_id: string }) => r.session_id)).toEqual([
      "sess-s5",
      "sess-s5",
    ]);
    const devExecs = execs.filter((e) => e.member === "dev-implementer");
    expect(devExecs).toHaveLength(2);
    expect(resumeOf(devExecs[1]?.cmd ?? [])).toBe("sess-s5");

    // 止まっていたほかの部署のタスクも、枠が戻ってから始まって終わる
    const sales = await taskIn(salesTask, ["done", "failed", "done_without_report"]);
    expect(sales.task.status).toBe("done");
    expect(Date.parse(sales.task.started_at)).toBeGreaterThanOrEqual(Date.parse(RETRY_AT));
  });

  it("5.4.6 の1：再開した実行の rate_limit_event（allowed）で、利用枠の状態が「使える」に戻る", async () => {
    const usage = (await api({ path: "/usage" })).json.usage;
    expect(usage).toMatchObject({
      status: "allowed",
      resets_at: "2026-11-28T07:00:00.000Z",
      utilization: 0.05,
    });
  });
});

describe("5.4.5 の受け入れ条件：同じスレッドの2回目は、1回目のセッションの続きから始まる（手動の --thread）", () => {
  it("同じ社員・同じスレッドの2回目は --resume <1回目の session_id>。ほかのスレッドは新しいセッション", async () => {
    const first = await newTask("sales-researcher", "週報の材料を集める", "weekly-report");
    const a = await taskIn(first, ["done", "failed", "done_without_report"]);
    expect(a.task.status).toBe("done");
    const firstSession = a.runs[0]?.session_id as string;
    expect(firstSession).toMatch(/^sess-sales-\d+$/);
    expect(resumeOf(execs.at(-1)?.cmd ?? [])).toBeNull();

    const second = await newTask("sales-researcher", "週報の続きを書く", "weekly-report");
    const b = await taskIn(second, ["done", "failed", "done_without_report"]);
    expect(b.task).toMatchObject({ status: "done", thread: "weekly-report" });
    expect(resumeOf(execs.at(-1)?.cmd ?? [])).toBe(firstSession);
    expect(b.runs[0]?.session_id).toBe(firstSession);

    const other = await newTask("sales-researcher", "別の調べもの", "another-thread");
    await taskIn(other, ["done", "failed", "done_without_report"]);
    expect(resumeOf(execs.at(-1)?.cmd ?? [])).toBeNull();
  });
});
