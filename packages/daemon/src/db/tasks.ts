/**
 * タスク（7.2 の tasks、5.5.3）。
 *
 * 状態の変化は `@aicoop/shared` の task-state.ts の表にあるものだけを許し、
 * 同じトランザクションで監査ログ `task.state`（変化前と変化後）を書く。
 */
import {
  type AuditActor,
  canTransitionTask,
  isId,
  isTaskStatus,
  isTerminalTaskStatus,
  newId,
  type TaskStatus,
  TRIGGER_KINDS,
  TRIGGER_PRIORITY,
  type TriggerKind,
} from "@aicoop/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { appendAudit } from "./audit.ts";
import { type StateDb, writeTransaction } from "./open.ts";
import { tasks } from "./schema.ts";
import { assertGroupId, assertMemberId, assertThread, isIsoTime } from "./validate.ts";

export type Task = typeof tasks.$inferSelect;

export interface NewTaskInput {
  readonly memberId: string;
  readonly groupId: string;
  readonly triggerKind: TriggerKind;
  /** `triggers.yaml` の ID（あれば） */
  readonly triggerId?: string | null;
  /** スレッド名（5.4.5）。なければ `task-<task_id>` */
  readonly thread?: string | null;
  readonly purpose: string;
  readonly context?: string;
  /** true なら context を外から来た文章として囲む（5.4.3 の4） */
  readonly contextUntrusted?: boolean;
  readonly doneWhen: string;
  readonly replyAs?: "file" | "task";
  readonly ticketId?: string | null;
  /** review タスクの対象（h_・g_・k_） */
  readonly reviewSubject?: string | null;
  /** on_hold_resolved タスクの保留 */
  readonly holdId?: string | null;
  /** このタスクの時間制限（5.5.5。1〜55） */
  readonly timeoutMinutes: number;
}

export class TaskNotFoundError extends Error {
  override name = "TaskNotFoundError";
  constructor(id: string) {
    super(`タスク ${id} がありません`);
  }
}

export class InvalidTaskTransitionError extends Error {
  override name = "InvalidTaskTransitionError";
  readonly from: TaskStatus;
  readonly to: string;
  constructor(id: string, from: TaskStatus, to: string) {
    super(`タスク ${id} は ${from} から ${to} へは変われません（5.5.3）`);
    this.from = from;
    this.to = to;
  }
}

/** その状態ではできない操作（例：動いていないタスクに結果を書く） */
export class TaskStateError extends Error {
  override name = "TaskStateError";
}

const MAX_TIMEOUT_MINUTES = 55;
const MAX_SUMMARY_CHARS = 4000;
const MAX_FILES = 50;

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} を書いてください`);
  }
  return value;
}

/** 5.5.3・7.2：タスクを作る（状態 queued）。監査ログ task.state（null → queued）を書く */
export function createTask(
  db: StateDb,
  input: NewTaskInput,
  opts: { readonly actor?: AuditActor } = {},
): Task {
  assertMemberId(input.memberId);
  assertGroupId(input.groupId);
  if (!(TRIGGER_KINDS as readonly string[]).includes(input.triggerKind)) {
    throw new TypeError(`知らないトリガーの種類です: ${String(input.triggerKind)}`);
  }
  const timeout = input.timeoutMinutes;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MINUTES) {
    throw new RangeError(`時間制限は1〜${MAX_TIMEOUT_MINUTES}分の整数にしてください（5.5.5）`);
  }
  const purpose = requireText(input.purpose, "目的（purpose）");
  const doneWhen = requireText(input.doneWhen, "完了の条件（done_when）");
  const replyAs = input.replyAs ?? "file";
  if (replyAs !== "file" && replyAs !== "task") throw new TypeError("返し方は file か task です");
  if (input.thread !== undefined && input.thread !== null) assertThread(input.thread);
  if (input.ticketId != null && !isId(input.ticketId, "ticket")) {
    throw new TypeError("ticketId は依頼票の ID（k_...）にしてください");
  }
  if (input.holdId != null && !isId(input.holdId, "hold")) {
    throw new TypeError("holdId は保留の ID（h_...）にしてください");
  }
  const subject = input.reviewSubject;
  if (
    subject != null &&
    !isId(subject, "hold") &&
    !isId(subject, "grant") &&
    !isId(subject, "ticket")
  ) {
    throw new TypeError("reviewSubject は保留・一時権限・依頼票の ID にしてください");
  }

  return writeTransaction(db, () => {
    const id = newId("task", db.now().getTime());
    const row: Task = {
      id,
      memberId: input.memberId,
      groupId: input.groupId,
      triggerKind: input.triggerKind,
      triggerId: input.triggerId ?? null,
      priority: TRIGGER_PRIORITY[input.triggerKind],
      thread: input.thread ?? `task-${id}`,
      status: "queued",
      purpose,
      context: input.context ?? "",
      doneWhen,
      contextUntrusted: input.contextUntrusted ?? false,
      replyAs,
      ticketId: input.ticketId ?? null,
      reviewSubject: subject ?? null,
      holdId: input.holdId ?? null,
      timeoutMinutes: timeout,
      createdAt: db.now().toISOString(),
      startedAt: null,
      endedAt: null,
      retryAt: null,
      resultSummary: null,
      resultFiles: null,
      error: null,
    };
    db.orm.insert(tasks).values(row).run();
    appendAudit(db, {
      actor: opts.actor ?? "system",
      kind: "task.state",
      subject: id,
      data: { from: null, to: "queued" },
    });
    return row;
  });
}

export function getTask(db: StateDb, id: string): Task | undefined {
  return db.orm.select().from(tasks).where(eq(tasks.id, id)).get();
}

/** タスクの一覧（作られた順）。`status` を渡せば、その状態のものだけ */
export function listTasks(
  db: StateDb,
  opts: { readonly status?: TaskStatus | readonly TaskStatus[] } = {},
): Task[] {
  const statuses =
    opts.status === undefined
      ? undefined
      : Array.isArray(opts.status)
        ? opts.status
        : [opts.status];
  if (statuses !== undefined && statuses.length === 0) return [];
  const query = db.orm.select().from(tasks);
  const filtered =
    statuses === undefined ? query : query.where(inArray(tasks.status, [...statuses]));
  return filtered.orderBy(asc(tasks.createdAt), asc(tasks.id)).all();
}

export interface TransitionOptions {
  readonly actor?: AuditActor;
  /** 失敗の理由（tasks.error）。監査ログには書かない */
  readonly error?: string;
  /** waiting_limit にするときは必須（5.4.6 の2） */
  readonly retryAt?: string;
  /** 監査ログに残す、決まった理由の符号 */
  readonly reason?: "daemon_restart";
}

/**
 * 5.5.3：タスクの状態を変える。許されない変化なら例外（状態も監査ログも変えない）。
 * - running になったら started_at、終わった状態になったら ended_at を書く
 * - waiting_limit にするときは retry_at を書く
 */
export function transitionTask(
  db: StateDb,
  id: string,
  to: TaskStatus,
  opts: TransitionOptions = {},
): Task {
  return writeTransaction(db, () => {
    const task = getTask(db, id);
    if (task === undefined) throw new TaskNotFoundError(id);
    const from = task.status;
    if (!isTaskStatus(to) || !canTransitionTask(from, to)) {
      throw new InvalidTaskTransitionError(id, from, String(to));
    }
    if (to === "waiting_limit" && (opts.retryAt === undefined || !isIsoTime(opts.retryAt))) {
      throw new TypeError("waiting_limit にするときは retry_at（ISO 8601 の UTC）を渡してください");
    }

    const now = db.now().toISOString();
    const patch: Partial<Task> = { status: to };
    if (to === "running") patch.startedAt = now;
    if (isTerminalTaskStatus(to)) patch.endedAt = now;
    if (to === "waiting_limit") patch.retryAt = opts.retryAt as string;
    if (opts.error !== undefined) patch.error = opts.error;

    const changed = db.orm
      .update(tasks)
      .set(patch)
      .where(and(eq(tasks.id, id), eq(tasks.status, from)))
      .run().changes;
    if (changed !== 1) throw new InvalidTaskTransitionError(id, from, to);

    appendAudit(db, {
      actor: opts.actor ?? "system",
      kind: "task.state",
      subject: id,
      data: opts.reason ? { from, to, reason: opts.reason } : { from, to },
    });
    return getTask(db, id) as Task;
  });
}

/**
 * 9.1 の `aicoop cancel`：タスクを取り消す。終わっていなければどの状態からでも cancelled にする。
 * `wasActive` が true なら、箱で動いているので、呼んだ側が止める。
 */
export function cancelTask(
  db: StateDb,
  id: string,
  opts: { readonly actor?: AuditActor } = {},
): { task: Task; wasActive: boolean } {
  return writeTransaction(db, () => {
    const before = getTask(db, id);
    if (before === undefined) throw new TaskNotFoundError(id);
    const task = transitionTask(db, id, "cancelled", { actor: opts.actor ?? "system" });
    return { task, wasActive: before.status === "starting" || before.status === "running" };
  });
}

/**
 * 5.5.6 の1：report_result の summary と files を書く。動いているタスクにだけ書ける。
 * 2回呼ばれたら、あとのものを残す。上限（5.3.3）を超えるものは書かない。
 */
export function recordTaskResult(
  db: StateDb,
  id: string,
  result: { readonly summary: string; readonly files: readonly string[] },
): Task {
  const summary = requireText(result.summary, "summary");
  if ([...summary].length > MAX_SUMMARY_CHARS) {
    throw new RangeError(`summary は${MAX_SUMMARY_CHARS}文字までです`);
  }
  if (!Array.isArray(result.files)) throw new TypeError("files は文字列の配列にしてください");
  if (result.files.length > MAX_FILES) throw new RangeError(`files は${MAX_FILES}個までです`);
  for (const f of result.files) {
    if (typeof f !== "string" || f === "" || f.includes("\u0000")) {
      throw new TypeError("files には空でないパスの文字列を入れてください");
    }
  }

  return writeTransaction(db, () => {
    const task = getTask(db, id);
    if (task === undefined) throw new TaskNotFoundError(id);
    if (task.status !== "running") {
      throw new TaskStateError(
        `タスク ${id} は動いていないので（${task.status}）、結果を書けません`,
      );
    }
    db.orm
      .update(tasks)
      .set({ resultSummary: summary, resultFiles: JSON.stringify(result.files) })
      .where(eq(tasks.id, id))
      .run();
    return getTask(db, id) as Task;
  });
}

/** tasks.result_files（JSON の配列）を読む。結果がなければ null */
export function taskResultFiles(task: Pick<Task, "resultFiles">): string[] | null {
  if (task.resultFiles === null) return null;
  const parsed: unknown = JSON.parse(task.resultFiles);
  if (!Array.isArray(parsed) || !parsed.every((f) => typeof f === "string")) {
    throw new TypeError("result_files が文字列の配列ではありません");
  }
  return parsed;
}
