/**
 * 実行（7.2 の runs）：1つのタスクのために箱を起こし、Claude Code を1回動かすこと。
 */
import { join } from "node:path";
import { type BoxKind, isId, newId } from "@aicoop/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import { type StateDb, writeTransaction } from "./open.ts";
import { type RunEndReason, runs } from "./schema.ts";
import { getTask, TaskNotFoundError } from "./tasks.ts";
import { assertGroupId, assertMemberId, assertSessionId } from "./validate.ts";

export type Run = typeof runs.$inferSelect;

const BOX_KINDS: readonly BoxKind[] = ["vm", "srt", "none"];
const END_REASONS: readonly RunEndReason[] = ["exited", "timeout", "killed", "daemon_restart"];

export class RunNotFoundError extends Error {
  override name = "RunNotFoundError";
  constructor(id: string) {
    super(`実行 ${id} がありません`);
  }
}

/** その状態ではできない操作（例：終わった実行をもう一度終える） */
export class RunStateError extends Error {
  override name = "RunStateError";
}

export interface NewRunInput {
  readonly taskId: string;
  readonly groupId: string;
  readonly memberId: string;
  readonly boxKind: BoxKind;
  /** 道具ゲートのポート（5.3.1） */
  readonly gatewayPort: number;
  /** 実行の記録を置くディレクトリ（`~/.aicoop/logs/runs/`）。記録は `<run_id>.jsonl` */
  readonly logDir: string;
  /** 続きから始めるときのセッションID（5.4.5 の4） */
  readonly sessionId?: string | null;
}

export function createRun(db: StateDb, input: NewRunInput): Run {
  if (!isId(input.taskId, "task"))
    throw new TypeError("taskId はタスクの ID（t_...）にしてください");
  assertGroupId(input.groupId);
  assertMemberId(input.memberId);
  if (!BOX_KINDS.includes(input.boxKind)) {
    throw new TypeError(`知らない箱の種類です: ${String(input.boxKind)}`);
  }
  const port = input.gatewayPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`道具ゲートのポートは1〜65535の整数にしてください: ${port}`);
  }
  if (input.sessionId !== undefined && input.sessionId !== null) assertSessionId(input.sessionId);

  return writeTransaction(db, () => {
    if (getTask(db, input.taskId) === undefined) throw new TaskNotFoundError(input.taskId);
    const id = newId("run", db.now().getTime());
    const row: Run = {
      id,
      taskId: input.taskId,
      groupId: input.groupId,
      memberId: input.memberId,
      boxKind: input.boxKind,
      sessionId: input.sessionId ?? null,
      gatewayPort: port,
      startedAt: db.now().toISOString(),
      endedAt: null,
      exitCode: null,
      endReason: null,
      logPath: join(input.logDir, `${id}.jsonl`),
    };
    db.orm.insert(runs).values(row).run();
    return row;
  });
}

export function getRun(db: StateDb, id: string): Run | undefined {
  return db.orm.select().from(runs).where(eq(runs.id, id)).get();
}

export function listRunsForTask(db: StateDb, taskId: string): Run[] {
  return db.orm
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(asc(runs.startedAt), asc(runs.id))
    .all();
}

/** 終わっていない実行（ended_at が null） */
export function listOpenRuns(db: StateDb): Run[] {
  return db.orm
    .select()
    .from(runs)
    .where(isNull(runs.endedAt))
    .orderBy(asc(runs.startedAt), asc(runs.id))
    .all();
}

/** 実行を終える：終わった時刻・終了コード・終わり方を書く。終わった実行は、もう一度終われない */
export function finishRun(
  db: StateDb,
  id: string,
  end: { readonly exitCode: number | null; readonly endReason: RunEndReason },
): Run {
  if (!END_REASONS.includes(end.endReason)) {
    throw new TypeError(`知らない終わり方です: ${String(end.endReason)}`);
  }
  if (end.exitCode !== null && !Number.isInteger(end.exitCode)) {
    throw new TypeError("終了コードは整数か null にしてください");
  }
  return writeTransaction(db, () => {
    const run = getRun(db, id);
    if (run === undefined) throw new RunNotFoundError(id);
    if (run.endedAt !== null) throw new RunStateError(`実行 ${id} は、もう終わっています`);
    db.orm
      .update(runs)
      .set({ endedAt: db.now().toISOString(), exitCode: end.exitCode, endReason: end.endReason })
      .where(and(eq(runs.id, id), isNull(runs.endedAt)))
      .run();
    return getRun(db, id) as Run;
  });
}

/** 5.4.5 の3：stream-json の最初の init イベントのセッションIDを書く */
export function setRunSessionId(db: StateDb, id: string, sessionId: string): Run {
  assertSessionId(sessionId);
  return writeTransaction(db, () => {
    if (getRun(db, id) === undefined) throw new RunNotFoundError(id);
    db.orm.update(runs).set({ sessionId }).where(eq(runs.id, id)).run();
    return getRun(db, id) as Run;
  });
}
