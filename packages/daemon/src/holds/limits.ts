/**
 * 保留・一時権限の申請の出しすぎを止める上限。
 *
 * 保留と申請は、1件ごとに部長のレビューのタスク（役員室の箱で Claude Code が動く）を作り、オーナーの承認を待つ。
 * 乗っ取られた AI社員（4.5 の Z3）に、保留・申請を大量に出させて、部長のレビューで利用枠を使い切らせたり、
 * オーナーの承認アプリを埋めさせたりしないように、数に上限を設ける。
 *
 * - 1つの実行あたりと、1人の社員の直近24時間あたり（実行をまたいで数える）の両方
 * - 数えるのは作ったもの（状態は問わない。却下・期限切れも数える）
 * - 超えたら：保留は資格プロキシが保留にせず `deny`（`reason: hold_limit`）、申請は `daily_limit`（9.3）
 * - 上限の確かめは、保留・申請を作るのと同じトランザクションの中で行う（同時に来ても上限を超えない）
 */
import { and, count, eq, gte } from "drizzle-orm";
import type { StateDb } from "../db/open.ts";
import { grants, holds } from "../db/schema.ts";

/** 1つの実行で作れる保留の数 */
export const MAX_HOLDS_PER_RUN = 10;
/** 1人の社員が直近24時間に作れる保留の数 */
export const MAX_HOLDS_PER_DAY = 30;
/** 1つの実行で出せる一時権限の申請の数 */
export const MAX_ACCESS_REQUESTS_PER_RUN = 3;
/** 1人の社員が直近24時間に出せる一時権限の申請の数 */
export const MAX_ACCESS_REQUESTS_PER_DAY = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 超えた上限（なければ null） */
export type LimitHit = "run" | "day" | null;

function since(now: Date): string {
  return new Date(now.getTime() - DAY_MS).toISOString();
}

/** この実行・この社員が、もう1件保留を作ると上限を超えるか */
export function holdLimitHit(
  db: StateDb,
  input: { readonly runId: string; readonly memberId: string; readonly now: Date },
): LimitHit {
  const inRun =
    db.orm.select({ n: count() }).from(holds).where(eq(holds.runId, input.runId)).get()?.n ?? 0;
  if (inRun >= MAX_HOLDS_PER_RUN) return "run";
  const inDay =
    db.orm
      .select({ n: count() })
      .from(holds)
      .where(and(eq(holds.memberId, input.memberId), gte(holds.createdAt, since(input.now))))
      .get()?.n ?? 0;
  return inDay >= MAX_HOLDS_PER_DAY ? "day" : null;
}

/**
 * この社員が、もう1件申請すると上限を超えるか。一時権限の記録には実行の ID がないので、
 * この実行の中で出した数（`inRun`）は呼ぶ側（道具ゲートの request_access）が数えて渡す
 */
export function accessRequestLimitHit(
  db: StateDb,
  input: { readonly memberId: string; readonly inRun: number; readonly now: Date },
): LimitHit {
  if (input.inRun >= MAX_ACCESS_REQUESTS_PER_RUN) return "run";
  const inDay =
    db.orm
      .select({ n: count() })
      .from(grants)
      .where(and(eq(grants.memberId, input.memberId), gte(grants.createdAt, since(input.now))))
      .get()?.n ?? 0;
  return inDay >= MAX_ACCESS_REQUESTS_PER_DAY ? "day" : null;
}
