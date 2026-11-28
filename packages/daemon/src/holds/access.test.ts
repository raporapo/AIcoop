import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAuditLog } from "../db/audit.ts";
import { getGrant } from "../db/grants.ts";
import { listTasks } from "../db/tasks.ts";
import { createHoldTestEnv, type HoldTestEnv } from "../testing/holds.ts";
import { requestAccess, subsumes } from "./access.ts";
import { MAX_ACCESS_REQUESTS_PER_DAY, MAX_ACCESS_REQUESTS_PER_RUN } from "./limits.ts";

let t: HoldTestEnv;
beforeEach(() => {
  t = createHoldTestEnv();
});
afterEach(() => t.cleanup());

const push = (over: Record<string, unknown> = {}) => ({
  service: "github",
  operation: "git.push",
  params: { repo: ["myorg/new"] },
  reason: "新しいリポジトリ myorg/new に実装を push するため",
  duration_hours: 24,
  ...over,
});

describe("5.7.3 の1・2：request_access", () => {
  it("S-4：部署の上限にある操作なら、一時権限を pending_manager で作り、部長にレビューのタスクを作る", () => {
    const result = requestAccess(t.deps, "dev-implementer", push());
    if (!result.ok) throw new Error(result.message);
    expect(getGrant(t.db, result.grant.id)).toMatchObject({
      memberId: "dev-implementer",
      service: "github",
      operation: "git.push",
      params: JSON.stringify({ repo: ["myorg/new"] }),
      mode: "allow",
      durationHours: 24,
      status: "pending_manager",
      startsAt: null,
      expiresAt: null,
    });
    const reviews = listTasks(t.db).filter((x) => x.triggerKind === "review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      memberId: "mgr-dev",
      groupId: "executives",
      priority: 1,
      reviewSubject: result.grant.id,
      contextUntrusted: true,
    });
    expect(reviews[0]?.context).toContain("新しいリポジトリ myorg/new に実装を push するため");
    expect(reviews[0]?.context).toContain("24時間");
    expect(t.kicks).toBe(1);
    expect(listAuditLog(t.db).filter((r) => r.kind === "grant.state")).toHaveLength(1);
  });

  it("duration_hours の既定は24。params の値は文字列1つでもよい", () => {
    const result = requestAccess(t.deps, "dev-implementer", {
      service: "github",
      operation: "git.push",
      params: { repo: "myorg/new" },
      reason: "r",
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.grant).toMatchObject({ durationHours: 24 });
    expect(JSON.parse(result.grant.params)).toEqual({ repo: ["myorg/new"] });
  });

  it("5.7.3 の4：mode は申請では決められず、部署の ceiling の同じ操作の mode を使う", () => {
    const result = requestAccess(t.deps, "dev-implementer", {
      service: "github",
      operation: "pr.merge",
      params: { repo: ["myorg/app"] },
      reason: "マージ",
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.grant.mode).toBe("hold");
  });

  it("部署に部長がいなければ pending_owner で、レビューのタスクは作らない", () => {
    const result = requestAccess(t.deps, "solo-mailer", {
      service: "gmail",
      operation: "message.send",
      reason: "送る",
    });
    if (!result.ok) throw new Error(result.message);
    expect(result.grant.status).toBe("pending_owner");
    expect(listTasks(t.db)).toEqual([]);
  });

  describe("拒否", () => {
    it("outside_ceiling：部署の上限にない操作（サービス定義にないものも）", () => {
      for (const args of [
        push({ service: "gmail", operation: "message.send", params: {} }),
        push({ operation: "issue.comment" }),
        push({ service: "nope", operation: "x" }),
      ]) {
        expect(requestAccess(t.deps, "dev-implementer", args)).toMatchObject({
          ok: false,
          code: "outside_ceiling",
        });
      }
    });

    it("outside_ceiling：params が上限の範囲の外（ほかの owner・広すぎる glob）", () => {
      for (const repo of ["otherorg/app", "*", "*/app", "myorg*", "my*/x"]) {
        expect(
          requestAccess(t.deps, "dev-implementer", push({ params: { repo: [repo] } })),
          repo,
        ).toMatchObject({ ok: false, code: "outside_ceiling" });
      }
      // 範囲の中の glob はよい
      expect(
        requestAccess(t.deps, "dev-implementer", push({ params: { repo: ["myorg/web-*"] } })).ok,
      ).toBe(true);
    });

    it("too_long：grants.max_hours（既定168）を超える", () => {
      expect(requestAccess(t.deps, "dev-implementer", push({ duration_hours: 169 }))).toMatchObject(
        {
          ok: false,
          code: "too_long",
        },
      );
      expect(requestAccess(t.deps, "dev-implementer", push({ duration_hours: 168 })).ok).toBe(true);
    });

    it("invalid_input：型・上限に合わない入力", () => {
      for (const args of [
        null,
        [],
        push({ reason: "" }),
        push({ reason: "  " }),
        push({ reason: "あ".repeat(1001) }),
        push({ reason: `済${String.fromCodePoint(0x1b)}[2K` }),
        push({ duration_hours: 0 }),
        push({ duration_hours: 1.5 }),
        push({ duration_hours: "24" }),
        push({ mode: "allow" }),
        push({ params: { repos: ["myorg/new"] } }),
        push({ params: { repo: [] } }),
        push({ params: { repo: [1] } }),
        push({ params: { repo: ["myorg/a b"] } }),
        push({ params: ["myorg/new"] }),
        push({ service: "GitHub" }),
        push({ operation: "" }),
      ]) {
        expect(requestAccess(t.deps, "dev-implementer", args), JSON.stringify(args)).toMatchObject({
          ok: false,
          code: "invalid_input",
        });
      }
      expect(listAuditLog(t.db).filter((r) => r.kind === "grant.state")).toEqual([]);
    });

    it("部長（役員室の ceiling は空）の申請は、どれも outside_ceiling", () => {
      expect(requestAccess(t.deps, "mgr-dev", push())).toMatchObject({
        ok: false,
        code: "outside_ceiling",
      });
    });
  });

  describe("申請の出しすぎ（9.3 の daily_limit）：1つの実行・1人の社員の直近24時間に、申請できる数の上限", () => {
    const reviews = () => listTasks(t.db).filter((x) => x.triggerKind === "review").length;
    const grants = () => listAuditLog(t.db).filter((r) => r.kind === "grant.state").length;

    it("1つの実行で申請できるのは MAX_ACCESS_REQUESTS_PER_RUN（3）件まで。超えたら daily_limit で、一時権限もレビューのタスクも作らない", () => {
      expect(MAX_ACCESS_REQUESTS_PER_RUN).toBe(3);
      expect(requestAccess(t.deps, "dev-implementer", push(), { inRun: 2 }).ok).toBe(true);
      const before = { reviews: reviews(), grants: grants() };
      const denied = requestAccess(t.deps, "dev-implementer", push(), { inRun: 3 });
      expect(denied).toMatchObject({ ok: false, code: "daily_limit" });
      expect({ reviews: reviews(), grants: grants() }).toEqual(before);
    });

    it("1人の社員が直近24時間に申請できるのは MAX_ACCESS_REQUESTS_PER_DAY（10）件まで（実行をまたいで数える。却下されたものも数える）。24時間を過ぎれば、また申請できる", () => {
      expect(MAX_ACCESS_REQUESTS_PER_DAY).toBe(10);
      for (let i = 0; i < MAX_ACCESS_REQUESTS_PER_DAY; i++) {
        expect(requestAccess(t.deps, "dev-implementer", push()).ok).toBe(true);
        t.clock.advance(60_000);
      }
      expect(requestAccess(t.deps, "dev-implementer", push())).toMatchObject({
        ok: false,
        code: "daily_limit",
      });
      expect(grants()).toBe(MAX_ACCESS_REQUESTS_PER_DAY);
      // いちばん古い申請から24時間を過ぎると、また申請できる
      t.clock.advance(24 * 3600_000 - MAX_ACCESS_REQUESTS_PER_DAY * 60_000 + 1);
      expect(requestAccess(t.deps, "dev-implementer", push()).ok).toBe(true);
    });

    it("拒否される側の確かめ：入力の誤り・上限の外の申請は、作らないので数えない。上限は社員ごと", () => {
      for (let i = 0; i < 20; i++) {
        requestAccess(t.deps, "dev-implementer", push({ duration_hours: 999 }));
      }
      expect(requestAccess(t.deps, "dev-implementer", push()).ok).toBe(true);
      for (let i = 0; i < MAX_ACCESS_REQUESTS_PER_DAY - 1; i++) {
        requestAccess(t.deps, "dev-implementer", push());
      }
      expect(requestAccess(t.deps, "dev-implementer", push())).toMatchObject({
        code: "daily_limit",
      });
      // ほかの社員（営業部のメール作成AI）は、自分の分だけを数える
      expect(
        requestAccess(t.deps, "sales-mailer", {
          service: "gmail",
          operation: "message.read",
          reason: "返信を読むため",
        }).ok,
      ).toBe(true);
    });
  });
});

describe("申請の値が上限の glob の中か（subsumes）", () => {
  it("* のない値は glob に当てはまるか、glob の値は同じか、前方一致の * の中だけ", () => {
    expect(subsumes("myorg/*", "myorg/app")).toBe(true);
    expect(subsumes("myorg/*", "myorg/*")).toBe(true);
    expect(subsumes("myorg/*", "myorg/web-*")).toBe(true);
    expect(subsumes("*", "anything/*")).toBe(true);
    expect(subsumes("myorg/*", "otherorg/app")).toBe(false);
    expect(subsumes("myorg/*", "*")).toBe(false);
    expect(subsumes("myorg/*", "*/app")).toBe(false);
    expect(subsumes("myorg/a*", "myorg/*")).toBe(false);
    expect(subsumes("*/app", "myorg/*")).toBe(false);
    expect(subsumes("myorg/app", "myorg/*")).toBe(false);
  });
});
