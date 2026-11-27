/**
 * 一時権限（7.2 の grants、5.7.3）のうち、ルールの判定（5.2.4 の2）に使う部分。
 *
 * 申請・承認の流れ（P2）はここにはない。判定は、リクエストのたびに active のものを読む。
 */
import type { GrantInput } from "@aicoop/shared";
import { and, eq } from "drizzle-orm";
import type { StateDb } from "./open.ts";
import { grants } from "./schema.ts";

/**
 * 社員の active の一時権限を、判定に渡す形で返す。期限の確かめは判定（effectivePermissions）が行う。
 * `params`・`mode` が読めないものは使わない（拒否側に倒す）。
 */
export function activeGrantsFor(db: StateDb, memberId: string): GrantInput[] {
  const rows = db.orm
    .select()
    .from(grants)
    .where(and(eq(grants.memberId, memberId), eq(grants.status, "active")))
    .all();
  const result: GrantInput[] = [];
  for (const row of rows) {
    const params = parseParams(row.params);
    if (params === null) continue;
    if (row.mode !== "allow" && row.mode !== "hold") continue;
    result.push({
      id: row.id,
      op: `${row.service}.${row.operation}`,
      params,
      mode: row.mode,
      status: "active",
      startsAt: row.startsAt,
      expiresAt: row.expiresAt,
    });
  }
  return result;
}

function parseParams(text: string): Record<string, string[]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const out: Record<string, string[]> = {};
  for (const [name, globs] of Object.entries(parsed)) {
    if (!Array.isArray(globs) || !globs.every((g) => typeof g === "string")) return null;
    out[name] = globs;
  }
  return out;
}
