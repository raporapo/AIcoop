import { isId, TASK_STATUSES, type TaskStatus, TRIGGER_PRIORITY } from "@aicoop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeClock, memoryDb } from "../testing/state-db.ts";
import { listAuditLog, verifyAuditLog } from "./audit.ts";
import { type StateDb, writeTransaction } from "./open.ts";
import {
  cancelTask,
  createTask,
  getTask,
  InvalidTaskTransitionError,
  listTasks,
  type NewTaskInput,
  recordTaskResult,
  TaskNotFoundError,
  TaskStateError,
  taskResultFiles,
  transitionTask,
} from "./tasks.ts";

const base: NewTaskInput = {
  memberId: "sales-researcher",
  groupId: "sales",
  triggerKind: "cron",
  triggerId: "sales-morning",
  thread: "morning-prospecting",
  purpose: "今日連絡すべき見込み客を5社選ぶ",
  context: "対象は国内のSaaS企業",
  doneWhen: "/work/prospects/ に今日の日付のmdがある",
  timeoutMinutes: 45,
};

function auditOf(db: StateDb, taskId: string) {
  return listAuditLog(db)
    .filter((r) => r.kind === "task.state" && r.subject === taskId)
    .map((r) => ({ actor: r.actor, ...JSON.parse(r.data) }));
}

/** queued から、決まった道筋で status まで進める */
function advanceTo(db: StateDb, id: string, status: TaskStatus): void {
  const paths: Partial<Record<TaskStatus, TaskStatus[]>> = {
    queued: [],
    starting: ["starting"],
    running: ["starting", "running"],
    done: ["starting", "running", "done"],
    done_without_report: ["starting", "running", "done_without_report"],
    failed: ["starting", "running", "failed"],
    timeout: ["starting", "running", "timeout"],
    waiting_limit: ["starting", "running", "waiting_limit"],
    blocked_host_tool: ["starting", "running", "blocked_host_tool"],
    cancelled: ["cancelled"],
  };
  for (const s of paths[status] ?? []) {
    transitionTask(db, id, s, s === "waiting_limit" ? { retryAt: "2026-11-28T05:01:00.000Z" } : {});
  }
}

describe("7.2・5.5.3：タスク", () => {
  let db: StateDb;
  let clock: FakeClock;
  beforeEach(() => {
    ({ db, clock } = memoryDb());
  });
  afterEach(() => db.close());

  describe("作成", () => {
    it("ID（t_）・優先度（5.5.1）・状態 queued・作られた時刻を付けて作る", () => {
      const task = createTask(db, base);
      expect(isId(task.id, "task")).toBe(true);
      expect(task).toMatchObject({
        memberId: "sales-researcher",
        groupId: "sales",
        triggerKind: "cron",
        triggerId: "sales-morning",
        priority: TRIGGER_PRIORITY.cron,
        thread: "morning-prospecting",
        status: "queued",
        purpose: base.purpose,
        context: base.context,
        doneWhen: base.doneWhen,
        contextUntrusted: false,
        replyAs: "file",
        timeoutMinutes: 45,
        createdAt: "2026-11-28T00:00:00.000Z",
        startedAt: null,
        endedAt: null,
        resultSummary: null,
        error: null,
      });
      expect(getTask(db, task.id)).toEqual(task);
    });

    it.each(Object.entries(TRIGGER_PRIORITY))("トリガー %s の優先度は %s", (kind, priority) => {
      const task = createTask(db, { ...base, triggerKind: kind as NewTaskInput["triggerKind"] });
      expect(task.priority).toBe(priority);
    });

    it("5.4.5 の2：スレッドを指定しなければ task-<task_id>", () => {
      const task = createTask(db, { ...base, thread: undefined });
      expect(task.thread).toBe(`task-${task.id}`);
    });

    it("context を書かなければ空、外から来た文章かどうかを記録する", () => {
      const task = createTask(db, { ...base, context: undefined, contextUntrusted: true });
      expect(task.context).toBe("");
      expect(task.contextUntrusted).toBe(true);
    });

    it("作ったことを監査ログに書く（task.state、変化前は null）", () => {
      const task = createTask(db, base, { actor: "owner:cli" });
      expect(auditOf(db, task.id)).toEqual([{ actor: "owner:cli", from: null, to: "queued" }]);
    });

    describe("形の違う値では作らない", () => {
      it.each([
        ["知らないトリガー", { triggerKind: "webhook" }, TypeError],
        ["時間制限が0", { timeoutMinutes: 0 }, RangeError],
        ["時間制限が55を超える（5.5.5）", { timeoutMinutes: 56 }, RangeError],
        ["時間制限が整数でない", { timeoutMinutes: 1.5 }, RangeError],
        ["目的が空", { purpose: "  " }, TypeError],
        ["完了の条件が空", { doneWhen: "" }, TypeError],
        ["社員IDの形が違う（6.5）", { memberId: "Sales Researcher" }, TypeError],
        ["部署IDの形が違う（6.5）", { groupId: "../dev" }, TypeError],
        ["スレッドに改行", { thread: "a\nb" }, TypeError],
        ["スレッドが空", { thread: "" }, TypeError],
        ["依頼票の ID でない ticketId", { ticketId: "h_01JD6V8X3S0Q5W7KQ9M2T4R6YB" }, TypeError],
        ["保留の ID でない holdId", { holdId: "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB" }, TypeError],
        [
          "レビューの対象にならない ID",
          { reviewSubject: "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB" },
          TypeError,
        ],
        ["知らない返し方", { replyAs: "mail" }, TypeError],
      ] as const)("%s", (_label, patch, error) => {
        expect(() => createTask(db, { ...base, ...patch } as NewTaskInput)).toThrow(error);
        expect(listTasks(db)).toEqual([]);
        expect(listAuditLog(db)).toEqual([]);
      });
    });

    it("レビューの対象には保留・一時権限・依頼票の ID を使える", () => {
      for (const subject of [
        "h_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
        "g_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
        "k_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
      ]) {
        expect(
          createTask(db, { ...base, triggerKind: "review", reviewSubject: subject }).reviewSubject,
        ).toBe(subject);
      }
    });
  });

  describe("一覧", () => {
    it("状態ごとに、作られた順で返す", () => {
      const a = createTask(db, base);
      clock.advance(1);
      const b = createTask(db, base);
      clock.advance(1);
      const c = createTask(db, base);
      advanceTo(db, b.id, "running");

      expect(listTasks(db).map((t) => t.id)).toEqual([a.id, b.id, c.id]);
      expect(listTasks(db, { status: "queued" }).map((t) => t.id)).toEqual([a.id, c.id]);
      expect(listTasks(db, { status: ["running", "starting"] }).map((t) => t.id)).toEqual([b.id]);
      expect(listTasks(db, { status: [] })).toEqual([]);
    });

    it("ない ID は undefined", () => {
      expect(getTask(db, "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB")).toBeUndefined();
    });
  });

  describe("5.5.3：状態の変化", () => {
    it("図の道筋で進み、時刻を書き、変化ごとに監査ログ task.state（変化前と変化後）を同じトランザクションで書く", () => {
      const task = createTask(db, base);
      clock.advance(1000);
      transitionTask(db, task.id, "starting");
      clock.advance(1000);
      const running = transitionTask(db, task.id, "running");
      expect(running.startedAt).toBe("2026-11-28T00:00:02.000Z");
      clock.advance(1000);
      const done = transitionTask(db, task.id, "done", { actor: "system" });
      expect(done).toMatchObject({ status: "done", endedAt: "2026-11-28T00:00:03.000Z" });

      expect(auditOf(db, task.id)).toEqual([
        { actor: "system", from: null, to: "queued" },
        { actor: "system", from: "queued", to: "starting" },
        { actor: "system", from: "starting", to: "running" },
        { actor: "system", from: "running", to: "done" },
      ]);
      expect(verifyAuditLog(db)).toMatchObject({ ok: true });
    });

    it("エラーの理由を書ける", () => {
      const task = createTask(db, base);
      advanceTo(db, task.id, "running");
      expect(transitionTask(db, task.id, "failed", { error: "claude exited 1" })).toMatchObject({
        status: "failed",
        error: "claude exited 1",
      });
    });

    it("5.4.6 の2：利用枠で止めるときは retry_at を書く（なければ例外）", () => {
      const task = createTask(db, base);
      advanceTo(db, task.id, "running");
      expect(() => transitionTask(db, task.id, "waiting_limit")).toThrow(TypeError);
      expect(getTask(db, task.id)?.status).toBe("running");
      const waiting = transitionTask(db, task.id, "waiting_limit", {
        retryAt: "2026-11-28T05:01:00.000Z",
      });
      expect(waiting).toMatchObject({
        status: "waiting_limit",
        retryAt: "2026-11-28T05:01:00.000Z",
      });
      expect(transitionTask(db, task.id, "queued").status).toBe("queued");
    });

    it("retry_at の形が違えば例外", () => {
      const task = createTask(db, base);
      advanceTo(db, task.id, "running");
      expect(() => transitionTask(db, task.id, "waiting_limit", { retryAt: "あとで" })).toThrow(
        TypeError,
      );
    });

    describe("図にない変化は許さない（状態も監査ログも変えない）", () => {
      const forbidden: [TaskStatus, TaskStatus][] = [
        ["queued", "running"],
        ["queued", "done"],
        ["starting", "done"],
        ["running", "queued"],
        ["running", "starting"],
        ["done", "queued"],
        ["done", "running"],
        ["failed", "queued"],
        ["timeout", "queued"],
        ["cancelled", "queued"],
        ["done_without_report", "done"],
        ["waiting_limit", "running"],
        ["blocked_host_tool", "running"],
        ["queued", "queued"],
      ];
      it.each(forbidden)("%s → %s", (from, to) => {
        const task = createTask(db, base);
        advanceTo(db, task.id, from);
        const before = listAuditLog(db).length;
        expect(() => transitionTask(db, task.id, to)).toThrow(InvalidTaskTransitionError);
        expect(getTask(db, task.id)?.status).toBe(from);
        expect(listAuditLog(db).length).toBe(before);
      });
    });

    it("知らない状態へは変えない", () => {
      const task = createTask(db, base);
      expect(() => transitionTask(db, task.id, "paused" as TaskStatus)).toThrow(
        InvalidTaskTransitionError,
      );
    });

    it("ないタスクは変えられない", () => {
      expect(() => transitionTask(db, "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB", "starting")).toThrow(
        TaskNotFoundError,
      );
    });

    it("外のトランザクションが取り消されたら、状態も監査ログも元のまま", () => {
      const task = createTask(db, base);
      const before = listAuditLog(db).length;
      expect(() =>
        writeTransaction(db, () => {
          transitionTask(db, task.id, "starting");
          throw new Error("箱の起動に失敗");
        }),
      ).toThrow("箱の起動に失敗");
      expect(getTask(db, task.id)?.status).toBe("queued");
      expect(listAuditLog(db).length).toBe(before);
    });
  });

  describe("取り消し（9.1 の aicoop cancel：動いていれば止める）", () => {
    it.each([
      ["queued", false],
      ["starting", true],
      ["running", true],
      ["waiting_limit", false],
      ["blocked_host_tool", false],
    ] as const)("%s から cancelled にできる（動いていたか：%s）", (from, active) => {
      const task = createTask(db, base);
      advanceTo(db, task.id, from);
      const result = cancelTask(db, task.id, { actor: "owner:cli" });
      expect(result.wasActive).toBe(active);
      expect(result.task).toMatchObject({ status: "cancelled", endedAt: expect.any(String) });
      expect(auditOf(db, task.id).at(-1)).toEqual({ actor: "owner:cli", from, to: "cancelled" });
    });

    it.each(["done", "done_without_report", "failed", "timeout", "cancelled"] as const)(
      "終わったタスク（%s）は取り消せない",
      (from) => {
        const task = createTask(db, base);
        advanceTo(db, task.id, from);
        expect(() => cancelTask(db, task.id)).toThrow(InvalidTaskTransitionError);
      },
    );
  });

  describe("5.5.6：結果（report_result）", () => {
    it("動いているタスクに summary と files を書く", () => {
      const task = createTask(db, base);
      advanceTo(db, task.id, "running");
      const updated = recordTaskResult(db, task.id, {
        summary: "5社を選びました",
        files: ["prospects/2026-11-28.md"],
      });
      expect(updated.resultSummary).toBe("5社を選びました");
      expect(taskResultFiles(updated)).toEqual(["prospects/2026-11-28.md"]);
      expect(updated.status).toBe("running");
    });

    it("2回呼んだら、あとのものを残す", () => {
      const task = createTask(db, base);
      advanceTo(db, task.id, "running");
      recordTaskResult(db, task.id, { summary: "1回目", files: [] });
      expect(recordTaskResult(db, task.id, { summary: "2回目", files: [] }).resultSummary).toBe(
        "2回目",
      );
    });

    it("結果がなければ files は null", () => {
      expect(taskResultFiles(createTask(db, base))).toBeNull();
    });

    it.each(TASK_STATUSES.filter((s) => s !== "running"))(
      "動いていないタスク（%s）には書けない",
      (status) => {
        const task = createTask(db, base);
        advanceTo(db, task.id, status);
        expect(() => recordTaskResult(db, task.id, { summary: "x", files: [] })).toThrow(
          TaskStateError,
        );
      },
    );

    describe("5.3.3 の上限を超えるものは書かない", () => {
      it.each([
        ["summary が4000文字を超える", { summary: "あ".repeat(4001), files: [] }, RangeError],
        ["files が50個を超える", { summary: "x", files: Array(51).fill("a.md") }, RangeError],
        ["summary が空", { summary: " ", files: [] }, TypeError],
        ["files に文字列でないもの", { summary: "x", files: [1] }, TypeError],
        ["files に空のパス", { summary: "x", files: [""] }, TypeError],
      ] as const)("%s", (_label, result, error) => {
        const task = createTask(db, base);
        advanceTo(db, task.id, "running");
        expect(() =>
          recordTaskResult(db, task.id, result as { summary: string; files: string[] }),
        ).toThrow(error);
        expect(getTask(db, task.id)?.resultSummary).toBeNull();
      });

      it("summary は4000文字ちょうどまで書ける（絵文字も1文字と数える）", () => {
        const task = createTask(db, base);
        advanceTo(db, task.id, "running");
        expect(() =>
          recordTaskResult(db, task.id, { summary: "🍣".repeat(4000), files: [] }),
        ).not.toThrow();
      });
    });
  });
});
