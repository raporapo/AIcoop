/**
 * テスト用：承認される対象の偽物（保留のように振る舞う）と、承認のサービスを組み立てる補助。
 */
import { newId } from "@aicoop/shared";
import type { ApprovalDecision, ApprovalSubjectType } from "@aicoop/shared/api";
import { pino } from "pino";
import { type ApprovalService, createApprovalService } from "../approvals/service.ts";
import type { ApprovalSubject, ApprovalTarget, ApprovalTargets } from "../approvals/types.ts";
import { appendAudit } from "../db/audit.ts";
import type { StateDb } from "../db/open.ts";
import { type FakeClock, memoryDb } from "./state-db.ts";
import { type SoftAuthenticator, softAuthenticator } from "./webauthn.ts";

interface Item {
  status: string;
  summary: unknown;
}

export interface FakeTarget extends ApprovalTarget {
  readonly items: Map<string, Item>;
  /** オーナーの承認を待つ対象を足す（ID を返す） */
  add(summary?: unknown, status?: string): string;
  readonly applied: Array<{ id: string; decision: ApprovalDecision; by: string }>;
  readonly afterApplied: Array<{ id: string; decision: ApprovalDecision }>;
  /** apply の中で投げる（トランザクションが巻き戻ることを確かめる） */
  failApply: boolean;
}

/**
 * 保留のような偽の対象。apply で状態を変え、監査ログ `hold.state` を書く（db が null なら書かない。
 * daemon の state.db に別の接続から書くと、承認のトランザクションと取り合いになるため）
 */
export function fakeTarget(
  db: StateDb | null,
  type: ApprovalSubjectType = "hold",
  kind: "hold" | "grant" = "hold",
): FakeTarget {
  const items = new Map<string, Item>();
  const target: FakeTarget = {
    type,
    items,
    applied: [],
    afterApplied: [],
    failApply: false,
    add(summary = { kind: "gmail_message", to: ["a@example.com"], subject: "見積もり" }, status) {
      const id = newId(kind);
      items.set(id, { status: status ?? "pending_owner", summary });
      return id;
    },
    describe(id): ApprovalSubject | undefined {
      const item = items.get(id);
      if (item === undefined) return undefined;
      return {
        type,
        id,
        status: item.status,
        awaitingOwner: item.status === "pending_owner",
        summary: item.summary,
      };
    },
    apply(id, decision, by) {
      const item = items.get(id);
      if (item === undefined || item.status !== "pending_owner") {
        throw new Error("もう承認を待っていません");
      }
      const to = decision === "approve" ? (kind === "hold" ? "approved" : "active") : "rejected";
      if (db !== null) {
        appendAudit(db, {
          actor: by,
          kind: kind === "hold" ? "hold.state" : "grant.state",
          subject: id,
          data: { from: item.status, to, by },
        });
      }
      if (target.failApply) throw new Error("apply の中で失敗しました");
      item.status = to;
      target.applied.push({ id, decision, by });
      return { status: to };
    },
    async afterApply(id, decision) {
      target.afterApplied.push({ id, decision });
    },
  };
  return target;
}

export const TEST_PORT = 7070;
export const TEST_ORIGIN = `http://localhost:${TEST_PORT}`;
export const TEST_COMPANY = { id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YB", name: "テスト商会" };

export interface ApprovalHarness {
  readonly db: StateDb;
  readonly clock: FakeClock;
  readonly service: ApprovalService;
  readonly hold: FakeTarget;
  readonly targets: ApprovalTargets;
  /** aicoop pair --local の流れで端末を登録する（y まで） */
  pairDevice(
    name?: string,
    auth?: SoftAuthenticator,
  ): Promise<{ readonly auth: SoftAuthenticator; readonly deviceId: string }>;
  /** パスキーでログインし、セッションのトークンを返す */
  login(auth: SoftAuthenticator): Promise<string>;
}

export function approvalHarness(): ApprovalHarness {
  const { db, clock } = memoryDb();
  const hold = fakeTarget(db);
  const targets: ApprovalTargets = { hold };
  const service = createApprovalService({
    db,
    logger: pino({ level: "silent" }),
    now: clock.now,
    port: () => TEST_PORT,
    company: () => TEST_COMPANY,
    targets: () => targets,
  });
  return {
    db,
    clock,
    service,
    hold,
    targets,
    async pairDevice(name = "仕事のPC", auth = softAuthenticator({ initialCounter: 0 })) {
      const { code } = service.pairing.start();
      const { options } = await service.pairing.options({ code, device_name: name });
      const response = auth.createCredential(options as never);
      await service.pairing.register({ code, response });
      const device = service.pairing.activate(code);
      return { auth, deviceId: device.id };
    },
    async login(auth) {
      const { options } = await service.login.options();
      const response = auth.getAssertion(options as never);
      const result = await service.login.verify({ response });
      return result.token;
    },
  };
}
