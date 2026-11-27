/**
 * 制御サーバーの再起動（8.6 の1〜3と5）。`aicoop daemon` を起動したら、箱を動かす前に1回呼ぶ。
 *
 * 1. running と starting のタスクを探す
 * 2. running のタスクは failed（error: daemon_restart）にする。セッションは残す
 * 3. starting のタスクは queued に戻す
 * 5. queued・waiting_limit・blocked_host_tool のタスク、保留、一時権限、依頼票は、そのまま引き継ぐ
 *
 * 終わっていない実行（ended_at が null）は、どれも end_reason を daemon_restart にして閉じる
 * （その実行の Claude Code は、もう動いていない）。
 * 8.6 の4（残っている箱を止めて壊す）は、箱を扱う側が行う。
 */

import { type StateDb, writeTransaction } from "./open.ts";
import { finishRun, listOpenRuns } from "./runs.ts";
import { listTasks, transitionTask } from "./tasks.ts";

export interface RestartRecovery {
  /** failed にしたタスク */
  readonly failed: string[];
  /** queued に戻したタスク */
  readonly requeued: string[];
  /** daemon_restart で閉じた実行 */
  readonly endedRuns: string[];
}

export function recoverAfterRestart(db: StateDb): RestartRecovery {
  return writeTransaction(db, () => {
    const failed: string[] = [];
    const requeued: string[] = [];
    for (const task of listTasks(db, { status: ["running", "starting"] })) {
      if (task.status === "running") {
        transitionTask(db, task.id, "failed", {
          error: "daemon_restart",
          reason: "daemon_restart",
          actor: "system",
        });
        failed.push(task.id);
      } else {
        transitionTask(db, task.id, "queued", { reason: "daemon_restart", actor: "system" });
        requeued.push(task.id);
      }
    }

    const endedRuns: string[] = [];
    for (const run of listOpenRuns(db)) {
      finishRun(db, run.id, { exitCode: null, endReason: "daemon_restart" });
      endedRuns.push(run.id);
    }
    return { failed, requeued, endedRuns };
  });
}
