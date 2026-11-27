/**
 * テスト用：偽の `StartRun`（1件の実行の代わり）。箱は起こさず、タスクの状態だけを本物と同じように変える。
 *
 * - 呼ばれたら、タスクを queued → starting → running にする（本物の実行と同じく、呼ばれた側が変える）
 * - `finish` で終わらせる（既定は report_result を書いて done）。`auto` なら、呼ばれたらすぐに終わる
 * - `cancel("cancelled")` は cancelled、`cancel("daemon_stop")` は failed（error: daemon_stopped）
 */
import type { CompanyConfig, TaskStatus } from "@aicoop/shared";
import { boxKindOf } from "@aicoop/shared";
import { getTask, recordTaskResult, transitionTask } from "../db/tasks.ts";
import type {
  CancelReason,
  RunEnvironment,
  RunHandle,
  RunOutcome,
  RunRequest,
  StartRun,
} from "../run/types.ts";

export interface FakeRun {
  readonly taskId: string;
  readonly config: CompanyConfig;
  readonly env: RunEnvironment;
  readonly handle: RunHandle;
  /** 取り消されたときの理由 */
  cancelledWith: CancelReason | null;
  finished: boolean;
}

export interface FakeStartRun {
  readonly startRun: StartRun;
  /** 呼ばれた順 */
  readonly runs: FakeRun[];
  /** いま動いている（終わっていない）実行のタスク */
  running(): string[];
  /** 実行を終わらせる。既定は report_result を書いて done */
  finish(
    taskId: string,
    status?: Extract<
      TaskStatus,
      "done" | "done_without_report" | "failed" | "timeout" | "waiting_limit"
    >,
    opts?: { readonly retryAt?: string },
  ): Promise<void>;
}

export function fakeStartRun(
  opts: { readonly auto?: boolean; readonly summary?: string } = {},
): FakeStartRun {
  const runs: FakeRun[] = [];
  const resolvers = new Map<string, (outcome: RunOutcome) => void>();

  const end = (
    run: FakeRun,
    status: TaskStatus,
    extra: { retryAt?: string; error?: string } = {},
  ) => {
    if (run.finished) return;
    run.finished = true;
    const db = run.env.db;
    if (status === "done") {
      recordTaskResult(db, run.taskId, { summary: opts.summary ?? "できました", files: [] });
    }
    const current = getTask(db, run.taskId);
    if (current !== undefined && current.status !== status) {
      transitionTask(db, run.taskId, status, {
        ...(extra.retryAt !== undefined && { retryAt: extra.retryAt }),
        ...(extra.error !== undefined && { error: extra.error }),
      });
    }
    resolvers.get(run.taskId)?.({ taskId: run.taskId, status, runId: null });
  };

  const startRun: StartRun = (env: RunEnvironment, request: RunRequest): RunHandle => {
    const task = getTask(env.db, request.taskId);
    if (task === undefined || task.status !== "queued") {
      throw new Error(`queued ではないタスクを渡されました: ${request.taskId}`);
    }
    transitionTask(env.db, task.id, "starting");
    transitionTask(env.db, task.id, "running");
    const done = new Promise<RunOutcome>((resolve) => resolvers.set(task.id, resolve));
    const run: FakeRun = {
      taskId: task.id,
      config: request.config,
      env,
      cancelledWith: null,
      finished: false,
      handle: {
        taskId: task.id,
        groupId: task.groupId,
        memberId: task.memberId,
        boxKind: boxKindOf(request.config, task.groupId) ?? "vm",
        startedAt: (env.now ?? env.db.now)().toISOString(),
        runId: () => null,
        done,
        async cancel(reason) {
          run.cancelledWith = reason;
          if (reason === "cancelled") end(run, "cancelled");
          else end(run, "failed", { error: "daemon_stopped" });
          await done;
        },
      },
    };
    runs.push(run);
    if (opts.auto) queueMicrotask(() => end(run, "done"));
    return run.handle;
  };

  return {
    startRun,
    runs,
    running: () => runs.filter((r) => !r.finished).map((r) => r.taskId),
    async finish(taskId, status = "done", finishOpts = {}) {
      const run = runs.find((r) => r.taskId === taskId && !r.finished);
      if (run === undefined) throw new Error(`動いていないタスクです: ${taskId}`);
      end(run, status, {
        ...(finishOpts.retryAt !== undefined && { retryAt: finishOpts.retryAt }),
        ...(status === "failed" && { error: "test" }),
      });
      await run.handle.done;
      // 終わったあとの見直し（queueMicrotask）が済むまで待つ
      await flushMicrotasks();
    },
  };
}

/** 積まれたマイクロタスク（Promise の続き）を流す */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
