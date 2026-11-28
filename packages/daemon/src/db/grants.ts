/**
 * 一時権限（7.2 の grants、5.7.3）。
 *
 * 状態の変化（5.7.3）：
 *
 * ```text
 * pending_manager ─pass→ pending_owner ─approve→ active ─期限→ expired
 *        │                     │
 *        └─reject→ rejected ←──┘reject
 * pending_manager・pending_owner ─申請から holds.ttl_hours→ expired
 * ```
 *
 * - 判定（5.2.4 の2）は、リクエストのたびに active のものを読む（`activeGrantsFor`）。期限の確かめは
 *   判定（effectivePermissions）が `starts_at`・`expires_at` で行うので、expired にする前でも期限の外は効かない
 * - 変化はすべて条件つきで行い、同じトランザクションで監査ログ `grant.state` を書く
 */
import { type AuditActor, type GrantInput, isId, newId } from "@aicoop/shared";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { appendAudit } from "./audit.ts";
import type { Decider } from "./holds.ts";
import { type StateDb, writeTransaction } from "./open.ts";
import { grants } from "./schema.ts";
import { assertMemberId, isIsoTime } from "./validate.ts";

export type Grant = typeof grants.$inferSelect;
export type GrantStatus = Grant["status"];

export const GRANT_STATUSES: readonly GrantStatus[] = [
  "pending_manager",
  "pending_owner",
  "active",
  "rejected",
  "expired",
];
export const GRANT_PENDING_STATUSES: readonly GrantStatus[] = ["pending_manager", "pending_owner"];

export function isGrantStatus(value: unknown): value is GrantStatus {
  return typeof value === "string" && (GRANT_STATUSES as readonly string[]).includes(value);
}

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
    const params = grantParams(row);
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

/** grants.params（JSON）を読む。`{ <名前>: [glob, ...] }` の形でなければ null */
export function grantParams(row: Pick<Grant, "params">): Record<string, string[]> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.params);
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

export interface NewGrantInput {
  readonly memberId: string;
  readonly service: string;
  /** サービスの中の操作の名前（例：`git.push`） */
  readonly operation: string;
  readonly params: Readonly<Record<string, readonly string[]>>;
  /** 部署の ceiling から決まる（5.7.3 の4） */
  readonly mode: "allow" | "hold";
  readonly reason: string;
  readonly durationHours: number;
  /** 部長がいれば pending_manager、いなければ pending_owner */
  readonly status: "pending_manager" | "pending_owner";
}

export class GrantStateError extends Error {
  override name = "GrantStateError";
  readonly current: GrantStatus | null;
  constructor(message: string, current: GrantStatus | null) {
    super(message);
    this.current = current;
  }
}

/** 5.7.3 の2：一時権限の申請を作り、監査ログ `grant.state`（null → 状態）を書く */
export function createGrant(db: StateDb, input: NewGrantInput): Grant {
  assertMemberId(input.memberId);
  if (!Number.isInteger(input.durationHours) || input.durationHours < 1) {
    throw new RangeError("durationHours は1以上の整数にしてください");
  }
  if (input.mode !== "allow" && input.mode !== "hold") throw new TypeError("mode は allow か hold");
  return writeTransaction(db, () => {
    const id = newId("grant", db.now().getTime());
    const row: Grant = {
      id,
      memberId: input.memberId,
      service: input.service,
      operation: input.operation,
      params: JSON.stringify(input.params),
      mode: input.mode,
      reason: input.reason,
      durationHours: input.durationHours,
      status: input.status,
      createdAt: db.now().toISOString(),
      startsAt: null,
      expiresAt: null,
      decidedBy: null,
      managerComment: null,
    };
    db.orm.insert(grants).values(row).run();
    appendAudit(db, {
      actor: `member:${input.memberId}`,
      kind: "grant.state",
      subject: id,
      data: { from: null, to: input.status, by: "system" },
    });
    return row;
  });
}

export function getGrant(db: StateDb, id: string): Grant | undefined {
  if (!isId(id, "grant")) return undefined;
  return db.orm.select().from(grants).where(eq(grants.id, id)).get();
}

export interface TransitionGrantOptions {
  readonly from: readonly GrantStatus[];
  readonly to: GrantStatus;
  readonly by: Decider;
  readonly actor: AuditActor;
  readonly managerComment?: string;
  /** decided_by を書く（却下・承認・期限切れ） */
  readonly decide?: boolean;
  /** active にするとき（5.7.3 の3） */
  readonly startsAt?: string;
  readonly expiresAt?: string;
}

/** 5.7.3：一時権限の状態を変える。いまの状態が `from` になければ GrantStateError（何も変えない） */
export function transitionGrant(db: StateDb, id: string, opts: TransitionGrantOptions): Grant {
  if (opts.to === "active" && (!isIsoTime(opts.startsAt) || !isIsoTime(opts.expiresAt))) {
    throw new TypeError(
      "active にするときは startsAt・expiresAt（ISO 8601 の UTC）を渡してください",
    );
  }
  return writeTransaction(db, () => {
    const grant = getGrant(db, id);
    if (grant === undefined) throw new GrantStateError(`一時権限 ${id} はありません`, null);
    if (!opts.from.includes(grant.status)) {
      throw new GrantStateError(
        `一時権限 ${id} は ${grant.status} なので、${opts.to} にはできません`,
        grant.status,
      );
    }
    const patch: Partial<Grant> = { status: opts.to };
    if (opts.decide) patch.decidedBy = opts.by;
    if (opts.managerComment !== undefined) patch.managerComment = opts.managerComment;
    if (opts.startsAt !== undefined) patch.startsAt = opts.startsAt;
    if (opts.expiresAt !== undefined) patch.expiresAt = opts.expiresAt;
    const changed = db.orm
      .update(grants)
      .set(patch)
      .where(and(eq(grants.id, id), eq(grants.status, grant.status)))
      .run().changes;
    if (changed !== 1) {
      throw new GrantStateError(`一時権限 ${id} の状態が、変える前に変わりました`, grant.status);
    }
    appendAudit(db, {
      actor: opts.actor,
      kind: "grant.state",
      subject: id,
      data: { from: grant.status, to: opts.to, by: opts.by },
    });
    return getGrant(db, id) as Grant;
  });
}

export interface ListGrantsOptions {
  readonly statuses?: readonly GrantStatus[];
  readonly memberId?: string;
  /** 既定 100 */
  readonly limit?: number;
}

/** 一時権限の一覧（新しい順） */
export function listGrants(db: StateDb, opts: ListGrantsOptions = {}): Grant[] {
  if (opts.statuses !== undefined && opts.statuses.length === 0) return [];
  const conditions: SQL[] = [];
  if (opts.statuses !== undefined) conditions.push(inArray(grants.status, [...opts.statuses]));
  if (opts.memberId !== undefined) conditions.push(eq(grants.memberId, opts.memberId));
  return db.orm
    .select()
    .from(grants)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(grants.createdAt), desc(grants.id))
    .limit(opts.limit ?? 100)
    .all();
}
