/**
 * 実行の順番（5.5.4）と、同時に起動する箱の上限（5.1.3、5.1.5）。
 *
 * 状態を持たない純粋な関数にしておき、制御サーバーは「順番待ちが変わったとき」と
 * 「実行が終わったとき」に呼んで、返ってきたタスクを順に始める。
 */
import type { BoxKind } from "./box.ts";

/** トリガーの種類（5.5.1、7.2 の tasks.trigger_kind） */
export const TRIGGER_KINDS = [
  "manual",
  "ceo",
  "review",
  "ticket",
  "on_hold_resolved",
  "github",
  "cron",
] as const;

export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** 5.5.1：優先度（小さいほど先）。利用枠やホストの道具を待って戻ったタスクも、元の優先度のまま */
export const TRIGGER_PRIORITY: Readonly<Record<TriggerKind, number>> = {
  manual: 0,
  ceo: 1,
  review: 1,
  ticket: 2,
  on_hold_resolved: 2,
  github: 3,
  cron: 4,
};

/** 順番待ち（queued）のタスク */
export interface SchedulableTask {
  readonly id: string;
  readonly groupId: string;
  /** そのタスクの部署の箱の種類（groups.yaml の box） */
  readonly boxKind: BoxKind;
  readonly priority: number;
  readonly createdAt: string;
}

/** 動いている実行（starting・running のタスク）の箱 */
export interface ActiveBox {
  readonly groupId: string;
  readonly boxKind: BoxKind;
}

/** 利用枠の状態（7.2 の usage_state のうち、判定に使う部分） */
export interface UsageGate {
  readonly status: "allowed" | "allowed_warning" | "rejected";
  readonly resetsAt: string | null;
}

/** 5.4.6 の2：再開は「再開予定時刻 + 60秒」から */
export const USAGE_RETRY_DELAY_MS = 60_000;

/**
 * 利用枠で止まっているか（5.4.6 の3、5.5.4 の4）。
 * 止まっていて、再開予定時刻が分からない・読めないときは、止まっているとみなす（拒否側に倒す）。
 */
export function isUsageBlocked(usage: UsageGate | null | undefined, now: Date): boolean {
  if (usage?.status !== "rejected") return false;
  if (usage.resetsAt === null) return true;
  const resets = Date.parse(usage.resetsAt);
  if (Number.isNaN(resets)) return true;
  return now.getTime() < resets + USAGE_RETRY_DELAY_MS;
}

/**
 * 5.5.4：順番待ちから、いま始めるタスクを始める順に返す。
 *
 * 1. 優先度の小さい順、同じなら作られた順（同じ時刻なら ID の順）に並べる
 * 2. 先頭から順に見て、次の両方を満たすタスクを選ぶ。満たさなければ飛ばして次を見る
 *    - その部署の箱で、ほかの実行が動いていない（5.1.3。`none` の部署も1つずつ）
 *    - `none` 以外なら、起動中の箱の数が上限未満（5.1.5。`none` は数えない）
 * 3. 利用枠で止まっているあいだは、何も選ばない
 */
export function pickTasksToStart(input: {
  readonly queued: readonly SchedulableTask[];
  readonly active: readonly ActiveBox[];
  readonly maxConcurrentBoxes: number;
  readonly usage?: UsageGate | null;
  readonly now: Date;
}): SchedulableTask[] {
  const max = input.maxConcurrentBoxes;
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError(`daemon.max_concurrent_boxes は1以上の整数にしてください: ${max}`);
  }
  if (isUsageBlocked(input.usage, input.now)) return [];

  const busyGroups = new Set(input.active.map((b) => b.groupId));
  let boxes = input.active.filter((b) => b.boxKind !== "none").length;

  const picked: SchedulableTask[] = [];
  for (const task of [...input.queued].sort(compareTasks)) {
    if (busyGroups.has(task.groupId)) continue;
    const counts = task.boxKind !== "none";
    if (counts && boxes >= max) continue;
    picked.push(task);
    busyGroups.add(task.groupId);
    if (counts) boxes++;
  }
  return picked;
}

function compareTasks(a: SchedulableTask, b: SchedulableTask): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const ta = timeOf(a.createdAt);
  const tb = timeOf(b.createdAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 読めない時刻は最後に回す */
function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}
