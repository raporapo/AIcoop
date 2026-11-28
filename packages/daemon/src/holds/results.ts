/**
 * 保留の結果をタスク本文に入れる（5.2.6 の4、5.4.3 の3 の「## 保留の結果」）。
 *
 * 入れるのは、その社員の保留のうち、前回の実行（その社員のこの実行より前の、いちばん新しい実行）が
 * 始まったあとに結果（replayed・replay_failed・rejected・expired）が出たもの。前回の実行がなければ、
 * 結果の出たものすべて（新しいものから）。on_hold_resolved のタスクなら、その保留は必ず入れる。
 *
 * 再送の応答の本文と部長のコメントは、外から来た文章として囲む（shared の prompt.ts が囲む。B-14）。
 * 応答の本文は、UTF-8 として読めるときだけ、先頭 4000 文字まで入れる。
 */
import type { HoldResultInput, HoldResultStatus } from "@aicoop/shared";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getHold, HOLD_RESULT_STATUSES, type Hold } from "../db/holds.ts";
import type { StateDb } from "../db/open.ts";
import { holds, runs } from "../db/schema.ts";
import type { AicoopPaths } from "../paths.ts";
import { headChars } from "./text.ts";
import { readResponseText } from "./views.ts";

/** タスク本文に入れる保留の結果の数の上限 */
export const MAX_HOLD_RESULTS = 20;
/** 応答の本文の先頭（文字） */
export const RESULT_BODY_CHARS = 4000;

export interface HoldResultsInput {
  readonly memberId: string;
  /** いまの実行（前回の実行を探すときに除く） */
  readonly runId: string;
  /** on_hold_resolved のタスクの保留 */
  readonly taskHoldId: string | null;
}

export function holdResultsForRun(
  deps: { readonly db: StateDb; readonly paths: AicoopPaths },
  input: HoldResultsInput,
): HoldResultInput[] {
  const { db } = deps;
  const previous = db.orm
    .select({ startedAt: runs.startedAt })
    .from(runs)
    .where(and(eq(runs.memberId, input.memberId), ne(runs.id, input.runId)))
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(1)
    .get();
  const since = previous?.startedAt ?? null;

  const rows = db.orm
    .select()
    .from(holds)
    .where(
      and(eq(holds.memberId, input.memberId), inArray(holds.status, [...HOLD_RESULT_STATUSES])),
    )
    .orderBy(desc(holds.resolvedAt), desc(holds.id))
    .limit(500)
    .all()
    .filter((h) => since === null || (h.resolvedAt !== null && h.resolvedAt > since))
    .slice(0, MAX_HOLD_RESULTS);

  if (input.taskHoldId !== null && !rows.some((h) => h.id === input.taskHoldId)) {
    const hold = getHold(db, input.taskHoldId);
    if (
      hold !== undefined &&
      hold.memberId === input.memberId &&
      HOLD_RESULT_STATUSES.includes(hold.status)
    ) {
      rows.unshift(hold);
    }
  }
  // 古いものから並べる（タスク本文で、起きた順に読めるように）
  return rows.reverse().map((h) => toResult(deps, h));
}

function toResult(deps: { readonly paths: AicoopPaths }, hold: Hold): HoldResultInput {
  const body =
    hold.status === "replayed" || hold.status === "replay_failed"
      ? readResponseText(hold, deps.paths, RESULT_BODY_CHARS * 4)
      : null;
  return {
    holdId: hold.id,
    operation: `${hold.service}.${hold.operation}`,
    status: hold.status as HoldResultStatus,
    responseStatus: hold.responseStatus,
    responseBody: body === null ? null : headChars(body, RESULT_BODY_CHARS).text,
    comment: hold.managerComment,
  };
}
