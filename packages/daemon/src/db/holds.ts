/**
 * 保留（7.2 の holds、5.2.6）の記録。
 *
 * ここでは「資格プロキシが保留を作る」ところだけを扱う。部長のレビュー・承認・再送（5.7.1）は P2。
 */
import { isId } from "@aicoop/shared";
import { eq } from "drizzle-orm";
import { appendAudit } from "./audit.ts";
import { type StateDb, writeTransaction } from "./open.ts";
import { holds } from "./schema.ts";
import { isIsoTime } from "./validate.ts";

export type Hold = typeof holds.$inferSelect;

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
