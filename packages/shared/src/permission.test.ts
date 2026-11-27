import { describe, expect, it } from "vitest";
import type { RequestTarget } from "./operation.ts";
import {
  effectivePermissions,
  evaluateRequest,
  type GrantInput,
  type PermissionItemInput,
} from "./permission.ts";
import { createServiceCatalog } from "./service.ts";
import { loadBuiltinServices } from "./testing/builtin-services.ts";

const catalog = createServiceCatalog(loadBuiltinServices());
const NOW = new Date("2026-11-28T00:00:00.000Z");

const push = (repo: string): RequestTarget => ({
  method: "POST",
  host: "github.com",
  path: `/${repo}.git/git-receive-pack`,
});
const merge = (repo: string): RequestTarget => ({
  method: "PUT",
  host: "api.github.com",
  path: `/repos/${repo}/pulls/1/merge`,
});
const send: RequestTarget = {
  method: "POST",
  host: "gmail.googleapis.com",
  path: "/gmail/v1/users/me/messages/send",
};

/** 役職の allow・部署の ceiling・一時権限から、判定までを一度に行う */
function judge(
  request: RequestTarget,
  opts: { allow: PermissionItemInput[]; ceiling: PermissionItemInput[]; grants?: GrantInput[] },
) {
  return evaluateRequest(catalog, effectivePermissions({ ...opts, now: NOW }), request);
}

function grant(over: Partial<GrantInput> & Pick<GrantInput, "op">): GrantInput {
  return {
    id: "g_01",
    mode: "allow",
    status: "active",
    startsAt: "2026-11-27T12:00:00.000Z",
    expiresAt: "2026-11-28T12:00:00.000Z",
    ...over,
  };
}

// 有効な許可 E(m)（5.2.4 の2）
describe("effectivePermissions", () => {
  it("役職の allow と部署の ceiling の両方にある操作だけが入る", () => {
    const e = effectivePermissions({
      allow: [{ op: "github.repo.read" }, { op: "web.read" }],
      ceiling: [{ op: "github.repo.read" }],
      now: NOW,
    });
    expect(e.map((p) => p.op)).toEqual(["github.repo.read"]);
  });

  it("パラメーターは両方の制限を持つ（共通部分）", () => {
    const [p] = effectivePermissions({
      allow: [{ op: "github.git.push", params: { repo: ["myorg/app"] } }],
      ceiling: [{ op: "github.git.push", params: { repo: ["myorg/*"] } }],
      now: NOW,
    });
    expect(p?.params).toEqual({ repo: [["myorg/app"], ["myorg/*"]] });
  });

  it.each([
    ["allow", "hold", "hold"],
    ["hold", "allow", "hold"],
    ["allow", "allow", "allow"],
  ] as const)("mode は厳しい方（役職 %s × 上限 %s → %s）", (role, ceil, expected) => {
    const [p] = effectivePermissions({
      allow: [{ op: "gmail.message.send", mode: role }],
      ceiling: [{ op: "gmail.message.send", mode: ceil }],
      now: NOW,
    });
    expect(p?.mode).toBe(expected);
  });

  it("mode を書かなければ allow", () => {
    const [p] = effectivePermissions({
      allow: [{ op: "web.read" }],
      ceiling: [{ op: "web.read" }],
      now: NOW,
    });
    expect(p?.mode).toBe("allow");
  });

  it("上限に同じ操作が2つあれば、それぞれと合わせた項目が入る", () => {
    const e = effectivePermissions({
      allow: [{ op: "github.repo.read" }],
      ceiling: [
        { op: "github.repo.read", params: { repo: ["myorg/*"] } },
        { op: "github.repo.read", params: { repo: ["partner/shared"] } },
      ],
      now: NOW,
    });
    expect(e).toHaveLength(2);
  });

  describe("一時権限", () => {
    it("承認済みで期限内なら、上限と合わせて入る", () => {
      const e = effectivePermissions({
        allow: [],
        ceiling: [{ op: "github.git.push", params: { repo: ["myorg/*"] } }],
        grants: [grant({ op: "github.git.push", params: { repo: ["myorg/new"] } })],
        now: NOW,
      });
      expect(e).toHaveLength(1);
      expect(e[0]?.source).toEqual({ kind: "grant", grantId: "g_01" });
      expect(e[0]?.params).toEqual({ repo: [["myorg/new"], ["myorg/*"]] });
    });

    it.each([
      ["期限が過ぎた", grant({ op: "web.read", expiresAt: "2026-11-27T23:59:59.999Z" })],
      ["期限ちょうど", grant({ op: "web.read", expiresAt: NOW.toISOString() })],
      ["まだ始まっていない", grant({ op: "web.read", startsAt: "2026-11-28T00:00:00.001Z" })],
      ["承認待ち", grant({ op: "web.read", status: "pending_owner" })],
      ["却下された", grant({ op: "web.read", status: "rejected" })],
      ["期限切れの状態", grant({ op: "web.read", status: "expired" })],
      ["期限が読めない", grant({ op: "web.read", expiresAt: "not-a-date" })],
      ["期限がない", grant({ op: "web.read", expiresAt: null })],
    ])("%s一時権限は入らない", (_label, g) => {
      const e = effectivePermissions({
        allow: [],
        ceiling: [{ op: "web.read" }],
        grants: [g],
        now: NOW,
      });
      expect(e).toEqual([]);
    });
  });
});

// ルールの判定（5.2.4 の3・4）
describe("evaluateRequest", () => {
  it("一致する操作がなければ deny（no_operation）", () => {
    const d = judge(
      { method: "DELETE", host: "api.github.com", path: "/repos/myorg/app" },
      { allow: [{ op: "github.repo.read" }], ceiling: [{ op: "github.repo.read" }] },
    );
    expect(d).toEqual({ decision: "deny", reason: "no_operation", operation: null });
  });

  it("許可した操作とパラメーターに一致すれば allow で、操作とパラメーターを返す", () => {
    const d = judge(push("myorg/app"), {
      allow: [{ op: "github.git.push", params: { repo: ["myorg/app"] } }],
      ceiling: [{ op: "github.git.push", params: { repo: ["myorg/*"] } }],
    });
    expect(d.decision).toBe("allow");
    if (d.decision === "allow") {
      expect(d.operation.id).toBe("github.git.push");
      expect(d.params).toEqual({ repo: "myorg/app" });
    }
  });

  describe("5.2.4 の受け入れ条件", () => {
    it("役職で許可していても部署の上限にない操作は deny になる", () => {
      const d = judge(push("myorg/app"), {
        allow: [{ op: "github.git.push" }],
        ceiling: [{ op: "github.repo.read" }],
      });
      expect(d).toMatchObject({ decision: "deny", reason: "not_allowed" });
    });

    it("一時権限で足した操作でも、部署の上限にないものは deny になる", () => {
      const d = judge(push("myorg/app"), {
        allow: [],
        ceiling: [{ op: "github.repo.read" }],
        grants: [grant({ op: "github.git.push" })],
      });
      expect(d).toMatchObject({ decision: "deny", reason: "not_allowed" });
    });

    it("役職が allow、部署の上限が hold の操作は hold になる", () => {
      const d = judge(send, {
        allow: [{ op: "gmail.message.send" }],
        ceiling: [{ op: "gmail.message.send", mode: "hold" }],
      });
      expect(d.decision).toBe("hold");
      if (d.decision === "hold") expect(d.operation.id).toBe("gmail.message.send");
    });
  });

  it("P1 完了条件2：許可していないリポジトリへの push は deny になる", () => {
    const d = judge(push("myorg/other"), {
      allow: [{ op: "github.git.push", params: { repo: ["myorg/app"] } }],
      ceiling: [{ op: "github.git.push", params: { repo: ["myorg/*"] } }],
    });
    expect(d).toMatchObject({
      decision: "deny",
      reason: "not_allowed",
      operation: { id: "github.git.push" },
    });
  });

  it("役職のパラメーターが上限より広くても、上限の外は deny（共通部分だけが効く）", () => {
    const d = judge(push("other/app"), {
      allow: [{ op: "github.git.push", params: { repo: ["*"] } }],
      ceiling: [{ op: "github.git.push", params: { repo: ["myorg/*"] } }],
    });
    expect(d).toMatchObject({ decision: "deny", reason: "not_allowed" });
  });

  it("複数の操作に一致したとき、allow が1つでもあれば allow（info/refs は read でも push でもある）", () => {
    const d = judge(
      { method: "GET", host: "github.com", path: "/myorg/app.git/info/refs" },
      { allow: [{ op: "github.repo.read" }], ceiling: [{ op: "github.repo.read" }] },
    );
    expect(d).toMatchObject({ decision: "allow", operation: { id: "github.repo.read" } });
  });

  it("allow がなく hold が1つでもあれば hold", () => {
    const d = judge(merge("myorg/app"), {
      allow: [{ op: "github.pr.merge" }],
      ceiling: [{ op: "github.pr.merge", mode: "hold" }],
    });
    expect(d.decision).toBe("hold");
  });

  it("項目がパラメーターを制限しているのに、リクエストにそのパラメーターがなければ一致しない", () => {
    const d = judge(send, {
      allow: [{ op: "gmail.message.send", params: { repo: ["myorg/*"] } }],
      ceiling: [{ op: "gmail.message.send" }],
    });
    expect(d).toMatchObject({ decision: "deny", reason: "not_allowed" });
  });

  it("S-4：一時権限が有効なあいだは push が通り、期限が過ぎると deny に戻る", () => {
    const ceiling: PermissionItemInput[] = [
      { op: "github.git.push", params: { repo: ["myorg/*"] } },
    ];
    const g = grant({ op: "github.git.push", params: { repo: ["myorg/new"] } });

    const during = evaluateRequest(
      catalog,
      effectivePermissions({ allow: [], ceiling, grants: [g], now: NOW }),
      push("myorg/new"),
    );
    expect(during.decision).toBe("allow");

    const after = evaluateRequest(
      catalog,
      effectivePermissions({
        allow: [],
        ceiling,
        grants: [g],
        now: new Date("2026-11-28T12:00:00.000Z"),
      }),
      push("myorg/new"),
    );
    expect(after).toMatchObject({ decision: "deny", reason: "not_allowed" });
  });

  it("web.read だけの社員が api.github.com を GET しても通らない（GitHub の制限を回り道させない）", () => {
    const d = judge(
      { method: "GET", host: "api.github.com", path: "/repos/myorg/secret/contents/a" },
      { allow: [{ op: "web.read" }], ceiling: [{ op: "web.read" }] },
    );
    expect(d).toMatchObject({ decision: "deny" });
  });

  it("解釈が分かれるパスは、許可があっても deny（no_operation）", () => {
    const d = judge(
      {
        method: "GET",
        host: "api.github.com",
        path: "/repos/myorg/app/../../other/secret/contents/x",
      },
      {
        allow: [{ op: "github.repo.read", params: { repo: ["myorg/app"] } }],
        ceiling: [{ op: "github.repo.read" }],
      },
    );
    expect(d).toEqual({ decision: "deny", reason: "no_operation", operation: null });
  });

  it("11.2：1回のルール判定は5ミリ秒以内", () => {
    const effective = effectivePermissions({
      allow: [
        { op: "github.repo.read" },
        { op: "github.git.push", params: { repo: ["myorg/app"] } },
        { op: "github.pr.create" },
        { op: "web.read" },
      ],
      ceiling: [
        { op: "github.repo.read", params: { repo: ["myorg/*"] } },
        { op: "github.git.push", params: { repo: ["myorg/*"] } },
        { op: "github.pr.create", params: { repo: ["myorg/*"] } },
        { op: "web.read" },
      ],
      now: NOW,
    });
    const n = 1000;
    const start = performance.now();
    for (let i = 0; i < n; i++) evaluateRequest(catalog, effective, push("myorg/app"));
    const perCall = (performance.now() - start) / n;
    expect(perCall).toBeLessThan(5);
  });
});
