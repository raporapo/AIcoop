/**
 * 保留（7.2 の holds、5.2.6、5.7.1）の記録と、状態の変化。
 *
 * 状態の変化（5.7.1）：
 *
 * ```text
 * pending_manager ─pass→ pending_owner ─approve→ approved ─再送→ replayed / replay_failed
 *        │                     │
 *        └─reject→ rejected ←──┘reject
 * pending_manager・pending_owner ─期限（holds.ttl_hours）→ expired
 * ```
 *
 * - 変化はすべて「いまの状態が from のどれかのときだけ」行い（条件つきの UPDATE）、同じトランザクションで
 *   監査ログ `hold.state`（変化前・変化後・決めた者）を書く。同じ保留を2人が同時に決めても、片方だけが通る
 * - 結果（replayed・replay_failed・rejected・expired）になった時刻を `resolved_at` に書く（5.2.6 の4）
 * - 再送は `approved` から1回だけ：送る前に `claimHoldReplay` で `response_path` を書いて「送り始めた」ことを
 *   残す。これが書けた者だけが送る（daemon が途中で落ちても、二度は送らない。`holds/replay.ts`）
 */
import { type AuditActor, isId } from "@aicoop/shared";
import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import { appendAudit } from "./audit.ts";
import { type StateDb, writeTransaction } from "./open.ts";
import { holds } from "./schema.ts";
import { isIsoTime } from "./validate.ts";

export type Hold = typeof holds.$inferSelect;
export type HoldStatus = Hold["status"];

export const HOLD_STATUSES: readonly HoldStatus[] = [
  "pending_manager",
  "pending_owner",
  "approved",
  "rejected",
  "expired",
  "replayed",
  "replay_failed",
];

/** まだ決まっていない（部長かオーナーを待っている） */
export const HOLD_PENDING_STATUSES: readonly HoldStatus[] = ["pending_manager", "pending_owner"];

/** 結果が出た（保留を出した社員に「保留の結果」として届ける。5.2.6 の4） */
export const HOLD_RESULT_STATUSES: readonly HoldStatus[] = [
  "replayed",
  "replay_failed",
  "rejected",
  "expired",
];

export function isHoldStatus(value: unknown): value is HoldStatus {
  return typeof value === "string" && (HOLD_STATUSES as readonly string[]).includes(value);
}

/** 決めた者（7.2 の decided_by、監査ログの by） */
export type Decider = "system" | `manager:${string}` | `owner:${string}`;

export interface NewHoldInput {
  /** 保留の ID（h_...）。保存するファイルの名前に使うので、呼ぶ側が先に作る */
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly memberId: string;
  readonly groupId: string;
  readonly thread: string;
  readonly service: string;
  /** サービスの中の操作の名前（例：`message.send`） */
  readonly operation: string;
  /** パラメーターの値（例：`{ repo: "myorg/app" }`） */
  readonly params: Readonly<Record<string, string>>;
  /** 保存したリクエスト（`~/.aicoop/state/holds/<id>.bin`） */
  readonly requestPath: string;
  /** 本文のバイト数 */
  readonly requestBytes: number;
  /** 要約（5.7.1 の2） */
  readonly summary: unknown;
  /** 部長がいれば pending_manager、いなければ pending_owner（5.7.1 の1） */
  readonly status: "pending_manager" | "pending_owner";
  readonly expiresAt: string;
}

/** その状態ではできない（もう決まった・期限切れなど）。状態も監査ログも変えていない */
export class HoldStateError extends Error {
  override name = "HoldStateError";
  /** いまの状態（保留がなければ null） */
  readonly current: HoldStatus | null;
  constructor(message: string, current: HoldStatus | null) {
    super(message);
    this.current = current;
  }
}

/** 保留を作り、同じトランザクションで監査ログ `hold.state`（null → 状態）を書く */
export function createHold(db: StateDb, input: NewHoldInput): Hold {
  if (!isId(input.id, "hold")) throw new TypeError("保留の ID（h_...）を渡してください");
  if (!isIsoTime(input.expiresAt))
    throw new TypeError("expiresAt は ISO 8601 の UTC にしてください");
  if (!Number.isInteger(input.requestBytes) || input.requestBytes < 0) {
    throw new RangeError("requestBytes は0以上の整数にしてください");
  }
  return writeTransaction(db, () => {
    const row: Hold = {
      id: input.id,
      runId: input.runId,
      taskId: input.taskId,
      memberId: input.memberId,
      groupId: input.groupId,
      thread: input.thread,
      service: input.service,
      operation: input.operation,
      params: JSON.stringify(input.params),
      requestPath: input.requestPath,
      requestBytes: input.requestBytes,
      summary: JSON.stringify(input.summary),
      managerComment: null,
      status: input.status,
      createdAt: db.now().toISOString(),
      expiresAt: input.expiresAt,
      decidedAt: null,
      decidedBy: null,
      responseStatus: null,
      responsePath: null,
      resolvedAt: null,
    };
    db.orm.insert(holds).values(row).run();
    appendAudit(db, {
      actor: `member:${input.memberId}`,
      kind: "hold.state",
      subject: input.id,
      data: { from: null, to: input.status, by: "system" },
    });
    return row;
  });
}

export function getHold(db: StateDb, id: string): Hold | undefined {
  return db.orm.select().from(holds).where(eq(holds.id, id)).get();
}

export interface TransitionHoldOptions {
  /** いまの状態がこのどれかのときだけ変える */
  readonly from: readonly HoldStatus[];
  readonly to: HoldStatus;
  /** 決めた者（監査ログの by） */
  readonly by: Decider;
  /** 監査ログの actor */
  readonly actor: AuditActor;
  /** 部長のコメント（部長の pass・reject のとき） */
  readonly managerComment?: string;
  /** decided_at・decided_by を書く（却下・承認・期限切れ） */
  readonly decide?: boolean;
  /** 再送の結果のステータス */
  readonly responseStatus?: number | null;
  /** 再送の結果の本文のファイル（送らなかったときは null に戻す） */
  readonly responsePath?: string | null;
}

/**
 * 5.7.1：保留の状態を変える。いまの状態が `from` になければ HoldStateError（何も変えない）。
 * 結果の状態になったら `resolved_at` を書く。
 */
export function transitionHold(db: StateDb, id: string, opts: TransitionHoldOptions): Hold {
  return writeTransaction(db, () => {
    const hold = getHold(db, id);
    if (hold === undefined) throw new HoldStateError(`保留 ${id} はありません`, null);
    if (!opts.from.includes(hold.status)) {
      throw new HoldStateError(
        `保留 ${id} は ${hold.status} なので、${opts.to} にはできません`,
        hold.status,
      );
    }
    const now = db.now().toISOString();
    const patch: Partial<Hold> = { status: opts.to };
    if (opts.decide) {
      patch.decidedAt = now;
      patch.decidedBy = opts.by;
    }
    if (HOLD_RESULT_STATUSES.includes(opts.to)) patch.resolvedAt = now;
    if (opts.managerComment !== undefined) patch.managerComment = opts.managerComment;
    if (opts.responseStatus !== undefined) patch.responseStatus = opts.responseStatus;
    if (opts.responsePath !== undefined) patch.responsePath = opts.responsePath;

    const changed = db.orm
      .update(holds)
      .set(patch)
      .where(and(eq(holds.id, id), eq(holds.status, hold.status)))
      .run().changes;
    if (changed !== 1) {
      throw new HoldStateError(`保留 ${id} の状態が、変える前に変わりました`, hold.status);
    }
    appendAudit(db, {
      actor: opts.actor,
      kind: "hold.state",
      subject: id,
      data: { from: hold.status, to: opts.to, by: opts.by },
    });
    return getHold(db, id) as Hold;
  });
}

/**
 * 5.2.6 の2：再送を始める印。`approved` で、まだだれも送り始めていない（response_path が null）ときだけ
 * `response_path` を書いて true を返す。true を受け取った者だけが送ってよい（1回だけ）
 */
export function claimHoldReplay(db: StateDb, id: string, responsePath: string): boolean {
  return writeTransaction(db, () => {
    const changed = db.orm
      .update(holds)
      .set({ responsePath })
      .where(and(eq(holds.id, id), eq(holds.status, "approved"), isNull(holds.responsePath)))
      .run().changes;
    return changed === 1;
  });
}

export interface ListHoldsOptions {
  readonly statuses?: readonly HoldStatus[];
  readonly memberId?: string;
  /** 既定 100 */
  readonly limit?: number;
}

/** 保留の一覧（新しい順） */
export function listHolds(db: StateDb, opts: ListHoldsOptions = {}): Hold[] {
  if (opts.statuses !== undefined && opts.statuses.length === 0) return [];
  const conditions: SQL[] = [];
  if (opts.statuses !== undefined) conditions.push(inArray(holds.status, [...opts.statuses]));
  if (opts.memberId !== undefined) conditions.push(eq(holds.memberId, opts.memberId));
  return db.orm
    .select()
    .from(holds)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(desc(holds.createdAt), desc(holds.id))
    .limit(opts.limit ?? 100)
    .all();
}

/** 保留の params（JSON）を読む。読めなければ null */
export function holdParams(hold: Pick<Hold, "params">): Record<string, string> | null {
  try {
    const parsed: unknown = JSON.parse(hold.params);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v !== "string") return null;
      out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/** 保留の summary（JSON）を読む。読めなければ null */
export function holdSummary(hold: Pick<Hold, "summary">): unknown {
  try {
    return JSON.parse(hold.summary);
  } catch {
    return null;
  }
}
