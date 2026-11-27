/**
 * 利用枠（7.2 の usage_state、5.4.6）：オーナーの Claude のアカウントの、最新の状態だけを持つ。
 */
import type { UsageGate } from "@aicoop/shared";
import { eq } from "drizzle-orm";
import { type StateDb, writeTransaction } from "./open.ts";
import { type UsageStatus, usageState } from "./schema.ts";
import { isIsoTime } from "./validate.ts";

export type UsageState = typeof usageState.$inferSelect;

/** 1つの会社で使うアカウントは、オーナー本人のもの1つだけ（5.4.1 の3） */
const ACCOUNT_ID = "owner";
const STATUSES: readonly UsageStatus[] = ["allowed", "allowed_warning", "rejected"];

export function getUsageState(db: StateDb): UsageState | undefined {
  return db.orm.select().from(usageState).where(eq(usageState.accountId, ACCOUNT_ID)).get();
}

/** 5.4.6 の1：rate_limit_event から読んだ最新の状態を書く */
export function setUsageState(
  db: StateDb,
  input: {
    readonly status: UsageStatus;
    readonly resetsAt?: string | null;
    readonly rateLimitType?: string | null;
    readonly utilization?: number | null;
  },
): UsageState {
  if (!STATUSES.includes(input.status)) {
    throw new TypeError(`知らない利用枠の状態です: ${String(input.status)}`);
  }
  const resetsAt = input.resetsAt ?? null;
  if (resetsAt !== null && !isIsoTime(resetsAt)) {
    throw new TypeError("再開予定時刻は ISO 8601 の UTC で書いてください");
  }
  const utilization = input.utilization ?? null;
  if (
    utilization !== null &&
    (typeof utilization !== "number" ||
      !Number.isFinite(utilization) ||
      utilization < 0 ||
      utilization > 1)
  ) {
    throw new TypeError("使用率は0〜1の数にしてください");
  }

  const row: UsageState = {
    accountId: ACCOUNT_ID,
    status: input.status,
    resetsAt,
    rateLimitType: input.rateLimitType ?? null,
    utilization,
    updatedAt: db.now().toISOString(),
  };
  return writeTransaction(db, () => {
    db.orm
      .insert(usageState)
      .values(row)
      .onConflictDoUpdate({ target: usageState.accountId, set: row })
      .run();
    return getUsageState(db) as UsageState;
  });
}

/** 順番待ち（5.5.4 の4）に渡す形にする。記録がなければ null（止まっていない） */
export function usageGate(state: UsageState | undefined): UsageGate | null {
  if (state === undefined) return null;
  return { status: state.status, resetsAt: state.resetsAt };
}
