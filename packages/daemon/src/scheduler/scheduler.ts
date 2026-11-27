/**
 * 順番待ちのループ（5.5.4、5.1.3、5.1.5、5.4.6、5.5.3）。
 *
 * 順番の判定は `@aicoop/shared` の `pickTasksToStart`（純粋な関数）に任せ、ここでは
 * 「いつ見直すか」と「選ばれたタスクごとに `StartRun` を呼び、動いている実行を数えること」をする。
 *
 * - 見直すのは、タスクが作られたとき（`kick`）、実行が終わったとき、数秒ごと（`start` してから）
 * - 見直すたびに、`waiting_limit` で `retry_at` を過ぎたタスクを `queued` に戻す（5.5.3）
 * - 利用枠で止まっているあいだは始めない（判定は pickTasksToStart。5.5.4 の4）
 * - `startRun` には、そのときの設定を渡す。動き始めたタスクは、その設定のまま最後まで動く（6.1）
 * - `stop` のあとは何も始めない。動いている実行はすべて `daemon_stop` で取り消して、終わるまで待つ
 */
import {
  type ActiveBox,
  boxKindOf,
  type CompanyConfig,
  pickTasksToStart,
  type SchedulableTask,
} from "@aicoop/shared";
import type { Logger } from "pino";
import type { StateDb } from "../db/open.ts";
import { getTask, listTasks, transitionTask } from "../db/tasks.ts";
import { getUsageState, usageGate } from "../db/usage.ts";
import type { RunEnvironment, RunHandle, StartRun } from "../run/types.ts";
import type { TimerHandle, Timers } from "../timers.ts";

/** 数秒ごとの見直しの間隔 */
export const SCHEDULER_INTERVAL_MS = 5000;
/** 止めるときに、実行が終わるのを待つ長さの上限 */
export const STOP_TIMEOUT_MS = 60_000;

export interface SchedulerOptions {
  readonly db: StateDb;
  readonly env: RunEnvironment;
  readonly startRun: StartRun;
  /** いまの設定（読み直すと変わる） */
  readonly config: () => CompanyConfig;
  readonly timers: Timers;
  readonly now: () => Date;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export interface TaskScheduler {
  /** 数秒ごとの見直しを始める */
  start(): void;
  /** すぐに見直す（いくつ呼んでも、1回にまとめる） */
  kick(): void;
  /** 見直しを1回、その場で行う */
  runPass(): void;
  /** いま動いている実行（箱を数えるもの） */
  active(): readonly RunHandle[];
  handleFor(taskId: string): RunHandle | undefined;
  /** 新しいタスクを始めず、動いている実行をすべて取り消して待つ。何度呼んでもよい */
  stop(opts?: { readonly timeoutMs?: number }): Promise<void>;
}

export function createTaskScheduler(opts: SchedulerOptions): TaskScheduler {
  const { db, env, startRun, timers, now, logger } = opts;
  const intervalMs = opts.intervalMs ?? SCHEDULER_INTERVAL_MS;
  const active = new Map<string, RunHandle>();
  /** 実行ごとの「終わって、数えるのをやめた」 */
  const settled = new Map<string, Promise<void>>();
  let stopping = false;
  let kicked = false;
  let tick: TimerHandle | undefined;
  let stopPromise: Promise<void> | undefined;

  const requeueDue = (at: Date) => {
    for (const task of listTasks(db, { status: "waiting_limit" })) {
      const retry = task.retryAt === null ? Number.NaN : Date.parse(task.retryAt);
      // retry_at が読めないものは、過ぎたものとして戻す（始めるかは利用枠の判定が決める）
      if (Number.isNaN(retry) || retry <= at.getTime()) {
        try {
          transitionTask(db, task.id, "queued");
          logger.info({ task_id: task.id }, "利用枠を待っていたタスクを、順番待ちに戻しました");
        } catch (error) {
          logger.error(
            { task_id: task.id, err: error },
            "利用枠を待っていたタスクを戻せませんでした",
          );
        }
      }
    }
  };

  /** 始められなかったタスクを failed にする（同じタスクで毎回失敗し続けないように） */
  const failUnstarted = (taskId: string) => {
    try {
      const task = getTask(db, taskId);
      if (task?.status === "queued") transitionTask(db, taskId, "starting");
      if (getTask(db, taskId)?.status === "starting") {
        transitionTask(db, taskId, "failed", { error: "start_failed" });
      }
    } catch (error) {
      logger.error(
        { task_id: taskId, err: error },
        "始められなかったタスクを failed にできませんでした",
      );
    }
  };

  const launch = (taskId: string, config: CompanyConfig) => {
    let handle: RunHandle;
    try {
      handle = startRun(env, { taskId, config });
    } catch (error) {
      logger.error({ task_id: taskId, err: error }, "タスクを始められませんでした");
      failUnstarted(taskId);
      return;
    }
    active.set(taskId, handle);
    logger.info(
      { task_id: taskId, group: handle.groupId, member: handle.memberId },
      "タスクを始めました",
    );
    const finished = handle.done
      .then(
        (outcome) =>
          logger.info(
            { task_id: taskId, status: outcome.status, run_id: outcome.runId },
            "実行が終わりました",
          ),
        (error: unknown) =>
          logger.error({ task_id: taskId, err: error }, "実行が例外で終わりました"),
      )
      .finally(() => {
        active.delete(taskId);
        settled.delete(taskId);
        kick();
      });
    settled.set(taskId, finished);
  };

  const runPass = () => {
    if (stopping) return;
    const at = now();
    requeueDue(at);
    const config = opts.config();
    const boxOf = (groupId: string) => boxKindOf(config, groupId) ?? "vm";

    const queued: SchedulableTask[] = listTasks(db, { status: "queued" })
      .filter((t) => !active.has(t.id))
      .map((t) => ({
        id: t.id,
        groupId: t.groupId,
        // 設定から部署が消えていても、箱を数える側（vm）に倒す。実行の側が分かりやすく failed にする
        boxKind: boxOf(t.groupId),
        priority: t.priority,
        createdAt: t.createdAt,
      }));
    if (queued.length === 0) return;

    const busy: ActiveBox[] = [...active.values()].map((h) => ({
      groupId: h.groupId,
      boxKind: h.boxKind,
    }));
    // 実行の記録がないのに starting・running のタスク（起こらないはず）の部署も、動いているものとして数える
    for (const t of listTasks(db, { status: ["starting", "running"] })) {
      if (!active.has(t.id)) busy.push({ groupId: t.groupId, boxKind: boxOf(t.groupId) });
    }

    const picked = pickTasksToStart({
      queued,
      active: busy,
      maxConcurrentBoxes: config.aicoop.daemon.max_concurrent_boxes,
      usage: usageGate(getUsageState(db)),
      now: at,
    });
    for (const t of picked) {
      if (stopping) return;
      launch(t.id, config);
    }
  };

  const safePass = () => {
    try {
      runPass();
    } catch (error) {
      logger.error({ err: error }, "順番待ちの見直しに失敗しました");
    }
  };

  const kick = () => {
    if (stopping || kicked) return;
    kicked = true;
    queueMicrotask(() => {
      kicked = false;
      safePass();
    });
  };

  const scheduleTick = () => {
    if (stopping) return;
    tick = timers.setTimeout(() => {
      tick = undefined;
      safePass();
      scheduleTick();
    }, intervalMs);
  };

  return {
    start() {
      if (tick === undefined && !stopping) scheduleTick();
    },
    kick,
    runPass,
    active: () => [...active.values()],
    handleFor: (taskId) => active.get(taskId),
    stop(stopOpts = {}) {
      stopPromise ??= (async () => {
        stopping = true;
        if (tick !== undefined) timers.clearTimeout(tick);
        tick = undefined;
        const handles = [...active.values()];
        if (handles.length === 0) return;
        const waits = [...settled.values()];
        logger.info({ count: handles.length }, "動いている実行を止めます");
        const all = Promise.allSettled(
          handles.map(async (h) => {
            try {
              await h.cancel("daemon_stop");
            } catch (error) {
              logger.error({ task_id: h.taskId, err: error }, "実行を止められませんでした");
            }
          }),
        ).then(() => Promise.allSettled(waits));
        const timeoutMs = stopOpts.timeoutMs ?? STOP_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
          timer.unref();
        });
        const result = await Promise.race([all, timeout]);
        clearTimeout(timer);
        if (result === "timeout") {
          logger.error(
            { tasks: [...active.keys()] },
            "実行が時間内に止まりませんでした。止めるのを待たずに進みます",
          );
        }
      })();
      return stopPromise;
    },
  };
}
