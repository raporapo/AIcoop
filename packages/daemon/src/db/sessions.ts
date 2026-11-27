/**
 * セッション（7.2 の sessions、5.4.5）：（社員, スレッド）ごとに1つの Claude Code のセッション。
 */
import { and, eq } from "drizzle-orm";
import { type StateDb, writeTransaction } from "./open.ts";
import { sessions } from "./schema.ts";
import { assertMemberId, assertSessionId, assertThread } from "./validate.ts";

export type Session = typeof sessions.$inferSelect;

export function getSession(db: StateDb, memberId: string, thread: string): Session | undefined {
  return db.orm
    .select()
    .from(sessions)
    .where(and(eq(sessions.memberId, memberId), eq(sessions.thread, thread)))
    .get();
}

/**
 * セッションを書く。
 * - 同じセッションIDなら、最後に使った時刻だけを進める
 * - 違うセッションID（新しいセッションに替えた。5.4.5 の5）なら、作った時刻も新しくする
 */
export function saveSession(
  db: StateDb,
  input: { readonly memberId: string; readonly thread: string; readonly sessionId: string },
): Session {
  assertMemberId(input.memberId);
  assertThread(input.thread);
  assertSessionId(input.sessionId);
  return writeTransaction(db, () => {
    const now = db.now().toISOString();
    const existing = getSession(db, input.memberId, input.thread);
    if (existing === undefined) {
      db.orm
        .insert(sessions)
        .values({ ...input, createdAt: now, lastUsedAt: now })
        .run();
    } else {
      const patch =
        existing.sessionId === input.sessionId
          ? { lastUsedAt: now }
          : { sessionId: input.sessionId, createdAt: now, lastUsedAt: now };
      db.orm
        .update(sessions)
        .set(patch)
        .where(and(eq(sessions.memberId, input.memberId), eq(sessions.thread, input.thread)))
        .run();
    }
    return getSession(db, input.memberId, input.thread) as Session;
  });
}

/** 最後に使った時刻を進める。セッションがなければ false */
export function touchSession(db: StateDb, memberId: string, thread: string): boolean {
  const changed = db.orm
    .update(sessions)
    .set({ lastUsedAt: db.now().toISOString() })
    .where(and(eq(sessions.memberId, memberId), eq(sessions.thread, thread)))
    .run().changes;
  return changed === 1;
}
