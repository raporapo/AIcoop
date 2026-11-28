/**
 * 保留に結果が出たとき（5.2.6 の4、5.5.1、6.6）：トリガー `on_hold_resolved` がその社員に設定されていれば、
 * すぐにタスクを作る。
 *
 * - 結果は replayed・replay_failed・rejected・expired のどれも（却下・期限切れも、続きを考えるのに要る）
 * - 目的は 6.6 の固定の文。スレッドは保留を出したときのスレッド。`hold_id` を付ける
 * - 同じ社員にトリガーが2つあっても、タスクは1つ（設定の順で最初のもの）
 * - その社員が、この daemon で動かせないとき（箱のドライバーがないなど）は作らない
 */
import { type CompanyConfig, resolveMember, timeoutMinutesFor } from "@aicoop/shared";
import type { Hold } from "../db/holds.ts";
import { createTask, type Task } from "../db/tasks.ts";
import type { HoldDeps } from "./deps.ts";

/** 6.6 の on_hold_resolved のタスクの目的 */
export function onHoldResolvedPurpose(holdId: string): string {
  return `保留 ${holdId} の結果が出た。結果を確かめて作業を続ける`;
}

/** on_hold_resolved のタスクの完了の条件（6.6 は書けないので、制御サーバーが決める） */
export const ON_HOLD_RESOLVED_DONE_WHEN =
  "保留の結果を確かめ、続きの作業をして、report_result で報告した";

export function createOnHoldResolvedTask(
  deps: Pick<HoldDeps, "db" | "canRun" | "logger">,
  config: CompanyConfig,
  hold: Hold,
): Task | null {
  const trigger = config.triggers.find(
    (t) => t.type === "on_hold_resolved" && t.enabled && t.member === hold.memberId,
  );
  if (trigger === undefined) return null;
  const member = resolveMember(config, hold.memberId);
  if (member === undefined || !deps.canRun(config, hold.memberId)) {
    deps.logger?.warn(
      { hold: hold.id, trigger: trigger.id },
      "on_hold_resolved のトリガーの社員を、この制御サーバーでは動かせないので、タスクを作りません",
    );
    return null;
  }
  return createTask(deps.db, {
    memberId: member.id,
    groupId: member.group.id,
    triggerKind: "on_hold_resolved",
    triggerId: trigger.id,
    thread: hold.thread,
    purpose: onHoldResolvedPurpose(hold.id),
    doneWhen: ON_HOLD_RESOLVED_DONE_WHEN,
    context: "",
    contextUntrusted: false,
    holdId: hold.id,
    timeoutMinutes: timeoutMinutesFor(config, trigger),
  });
}
