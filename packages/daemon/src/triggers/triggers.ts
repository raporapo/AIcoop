/**
 * トリガー（5.5.1、5.5.2、6.6）。P1 で動かすのは `cron` だけ（`manual` は API の `POST /tasks`）。
 *
 * - `cron`：`aicoop.yaml` の `timezone` で、`schedule` の時刻に `onCron` を呼ぶ。`enabled: false` は動かさない
 * - `github`（P3）・`on_hold_resolved`（P2）は、設定にあっても動かさない。`/status` では `enabled: false` で見せる
 * - トリガーの社員が、この daemon で動かせない（`checkRunnableMember`）ものも動かさない
 *
 * 次の時刻は `nextCronRun`（設定の検証 E-007 と同じ読み方）で求め、タイマーで待つ。
 * 起きるのが遅れた（PCが眠っていたなど）ときは、遅れた回を1回だけ起こし、その次は今より後の回にする。
 */
import {
  type CompanyConfig,
  type CronTriggerConfig,
  nextCronRun,
  type ResolvedMember,
  timeoutMinutesFor,
} from "@aicoop/shared";
import type { Logger } from "pino";
import type { TriggerView } from "../api/contract.ts";
import type { StateDb } from "../db/open.ts";
import { createTask, type Task } from "../db/tasks.ts";
import { MAX_TIMER_DELAY_MS, type TimerHandle, type Timers } from "../timers.ts";
import type { RunnableCheck } from "./runnable.ts";

export interface TriggerSet {
  /** `/status` の triggers（設定の順） */
  views(): TriggerView[];
  /** タイマーをすべて止める。何度呼んでもよい */
  stop(): void;
}

export interface StartTriggersOptions {
  readonly config: CompanyConfig;
  readonly timers: Timers;
  readonly now: () => Date;
  readonly logger: Logger;
  readonly canRun: (memberId: string) => RunnableCheck;
  /** cron が起きたとき。`scheduledAt` は、その回の予定の時刻 */
  readonly onCron: (trigger: CronTriggerConfig, scheduledAt: Date) => void;
}

const PHASE: Readonly<Record<string, string>> = {
  github: "P3",
  on_hold_resolved: "P2",
};

export function startTriggers(opts: StartTriggersOptions): TriggerSet {
  const { config, timers, now, logger } = opts;
  const timezone = config.aicoop.timezone;
  let stopped = false;
  const handles = new Map<string, TimerHandle>();
  const nextRuns = new Map<string, Date | null>();
  const armed = new Set<string>();

  const arm = (trigger: CronTriggerConfig) => {
    if (stopped) return;
    const next = nextRuns.get(trigger.id) ?? null;
    if (next === null) {
      handles.delete(trigger.id);
      return;
    }
    const delay = Math.min(Math.max(0, next.getTime() - now().getTime()), MAX_TIMER_DELAY_MS);
    handles.set(
      trigger.id,
      timers.setTimeout(() => onTimer(trigger), delay),
    );
  };

  const onTimer = (trigger: CronTriggerConfig) => {
    handles.delete(trigger.id);
    if (stopped) return;
    const scheduled = nextRuns.get(trigger.id) ?? null;
    if (scheduled === null) return;
    const at = now();
    // 早く起きた・長い待ちを区切った途中なら、待ち直す
    if (at.getTime() < scheduled.getTime()) {
      arm(trigger);
      return;
    }
    nextRuns.set(
      trigger.id,
      nextCronRun(
        trigger.schedule,
        timezone,
        new Date(Math.max(at.getTime(), scheduled.getTime())),
      ),
    );
    try {
      logger.info(
        { trigger: trigger.id, scheduled_at: scheduled.toISOString() },
        "cron が起きました",
      );
      opts.onCron(trigger, scheduled);
    } catch (error) {
      logger.error({ trigger: trigger.id, err: error }, "cron のタスクを作れませんでした");
    }
    arm(trigger);
  };

  for (const trigger of config.triggers) {
    if (trigger.type !== "cron") {
      if (trigger.enabled) {
        logger.warn(
          { trigger: trigger.id, type: trigger.type },
          `${trigger.type} のトリガーは ${PHASE[trigger.type] ?? "後のフェーズ"} から動きます。いまは動かしません`,
        );
      }
      continue;
    }
    if (!trigger.enabled) continue;
    const check = opts.canRun(trigger.member);
    if (!check.ok) {
      logger.warn({ trigger: trigger.id }, `cron のトリガーを動かしません：${check.message}`);
      continue;
    }
    nextRuns.set(trigger.id, nextCronRun(trigger.schedule, timezone, now()));
    armed.add(trigger.id);
    arm(trigger);
  }

  return {
    views: () =>
      config.triggers.map((t) => {
        const enabled = armed.has(t.id) && !stopped;
        const next = enabled ? (nextRuns.get(t.id) ?? null) : null;
        return {
          id: t.id,
          type: t.type,
          member: t.member,
          enabled,
          next_run_at: next === null ? null : next.toISOString(),
        };
      }),
    stop() {
      stopped = true;
      for (const handle of handles.values()) timers.clearTimeout(handle);
      handles.clear();
    },
  };
}

/** 5.5.1・6.6：cron が起きたときのタスク（queued）を作る */
export function createCronTask(
  db: StateDb,
  config: CompanyConfig,
  trigger: CronTriggerConfig,
  member: ResolvedMember,
): Task {
  return createTask(db, {
    memberId: member.id,
    groupId: member.group.id,
    triggerKind: "cron",
    triggerId: trigger.id,
    thread: trigger.thread ?? null,
    purpose: trigger.task.purpose,
    context: trigger.task.context,
    // オーナーが triggers.yaml に書いた文章なので、外から来た文章としては囲まない
    contextUntrusted: false,
    doneWhen: trigger.task.done_when,
    replyAs: trigger.task.reply_as,
    timeoutMinutes: timeoutMinutesFor(config, trigger),
  });
}
