import { newId } from "@aicoop/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryDb } from "../testing/state-db.ts";
import { listAuditLog, verifyAuditLog } from "./audit.ts";
import { activeGrantsFor } from "./grants.ts";
import { createHold, getHold } from "./holds.ts";
import type { StateDb } from "./open.ts";
import { grants } from "./schema.ts";

let db: StateDb;
beforeEach(() => {
  db = memoryDb().db;
});

function insertGrant(over: Partial<typeof grants.$inferInsert> = {}): string {
  const id = newId("grant");
  db.orm
    .insert(grants)
    .values({
      id,
      memberId: "dev-implementer",
      service: "github",
      operation: "issue.comment",
      params: JSON.stringify({ repo: ["myorg/app"] }),
      mode: "allow",
      reason: "Issue に返事をする",
      durationHours: 24,
      status: "active",
      createdAt: "2026-11-27T00:00:00.000Z",
      startsAt: "2026-11-27T00:00:00.000Z",
      expiresAt: "2026-11-29T00:00:00.000Z",
      decidedBy: "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
      ...over,
    })
    .run();
  return id;
}

describe("5.2.4 の2：一時権限は grants 表の active を読む", () => {
  it("その社員の active の一時権限を、判定に使う形で返す", () => {
    const id = insertGrant();
    expect(activeGrantsFor(db, "dev-implementer")).toEqual([
      {
        id,
        op: "github.issue.comment",
        params: { repo: ["myorg/app"] },
        mode: "allow",
        status: "active",
        startsAt: "2026-11-27T00:00:00.000Z",
        expiresAt: "2026-11-29T00:00:00.000Z",
      },
    ]);
  });

  it("ほかの社員のもの・active でないもの（申請中・却下・期限切れ）は返さない", () => {
    insertGrant({ memberId: "dev-reviewer" });
    insertGrant({ status: "pending_owner" });
    insertGrant({ status: "rejected" });
    insertGrant({ status: "expired" });
    expect(activeGrantsFor(db, "dev-implementer")).toEqual([]);
  });

  it("params が読めない一時権限は使わない（拒否側に倒す）", () => {
    insertGrant({ params: "not json" });
    insertGrant({ params: JSON.stringify({ repo: "myorg/app" }) });
    insertGrant({ params: JSON.stringify([1]) });
    insertGrant({ mode: "weird" as "allow" });
    expect(activeGrantsFor(db, "dev-implementer")).toEqual([]);
  });
});

describe("5.2.6 の1：保留の記録", () => {
  it("保留を作り、同じトランザクションで監査ログ hold.state を書く", () => {
    const id = newId("hold");
    const hold = createHold(db, {
      id,
      runId: newId("run"),
      taskId: newId("task"),
      memberId: "sales-mailer",
      groupId: "sales",
      thread: "task-1",
      service: "gmail",
      operation: "message.send",
      params: {},
      requestPath: "/tmp/h.bin",
      requestBytes: 123,
      summary: { kind: "gmail_message" },
      status: "pending_manager",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    expect(hold.status).toBe("pending_manager");
    expect(getHold(db, id)).toEqual(hold);
    expect(hold.createdAt).toBe("2026-11-28T00:00:00.000Z");
    const rows = listAuditLog(db).filter((r) => r.kind === "hold.state");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor).toBe("member:sales-mailer");
    expect(JSON.parse(rows[0]?.data ?? "null")).toEqual({
      from: null,
      to: "pending_manager",
      by: "system",
    });
    expect(verifyAuditLog(db).ok).toBe(true);
  });

  it("保留の ID でない値は受け付けない", () => {
    expect(() =>
      createHold(db, {
        id: "h_bad",
        runId: newId("run"),
        taskId: newId("task"),
        memberId: "m",
        groupId: "g",
        thread: "t",
        service: "gmail",
        operation: "message.send",
        params: {},
        requestPath: "/x",
        requestBytes: 0,
        summary: {},
        status: "pending_owner",
        expiresAt: "2026-12-01T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
