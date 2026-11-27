import { describe, expect, it } from "vitest";
import type { GrantInput } from "../permission.ts";
import {
  baseGroups,
  baseMembers,
  baseRoles,
  type CompanyParts,
  configInput,
  type MemberInput,
  promptsFor,
  type RoleInput,
} from "../testing/config-fixtures.ts";
import {
  boxKindOf,
  type CompanyConfig,
  effectivePermissionsFor,
  managerOf,
  membersOfGroup,
  promptFilesFor,
  resolveMember,
  timeoutMinutesFor,
} from "./company.ts";
import { type ConfigInput, validateConfig } from "./validate.ts";

const NOW = new Date("2026-11-28T00:00:00.000Z");

function load(parts: CompanyParts = {}, over: Partial<ConfigInput> = {}): CompanyConfig {
  const result = validateConfig(configInput(parts, over));
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.config;
}

const withManager = (): CompanyParts => ({
  groups: { ...baseGroups, executives: { name: "役員室", box: "vm" } },
  roles: { ...baseRoles, manager: { name: "部長" } },
  members: {
    ...baseMembers,
    "mgr-dev": { name: "開発部長AI", group: "executives", role: "manager", manages: "dev" },
  } as Record<string, MemberInput>,
});

describe("effectivePermissionsFor（5.2.4 の2）", () => {
  it("役職の allow と所属部署の ceiling の両方にあるものだけ。params は両方の制限を持つ", () => {
    const e = effectivePermissionsFor(load(), "dev-implementer", { now: NOW });
    expect(e.map((p) => p.op)).toEqual(["github.repo.read", "github.git.push", "github.pr.create"]);
    expect(e[0]?.params).toEqual({ repo: [["myorg/*"]] });
  });

  it("部長は、担当する部署ではなく役員室の ceiling を使う（5.1.1）", () => {
    const parts = withManager();
    const roles = {
      ...parts.roles,
      manager: { name: "部長", allow: [{ op: "github.repo.read" }] },
    };
    // 開発部の ceiling には github.repo.read があるが、役員室の ceiling は空なので効かない
    const config = validateConfig(configInput({ ...parts, roles }));
    expect(config.ok).toBe(true);
    if (config.ok)
      expect(effectivePermissionsFor(config.config, "mgr-dev", { now: NOW })).toEqual([]);
  });

  it("有効期限内の一時権限も、部署の ceiling と合わせて入る", () => {
    const grant: GrantInput = {
      id: "g_01",
      op: "github.repo.read",
      params: { repo: ["myorg/app"] },
      mode: "allow",
      status: "active",
      startsAt: "2026-11-27T00:00:00.000Z",
      expiresAt: "2026-11-29T00:00:00.000Z",
    };
    const e = effectivePermissionsFor(load(), "sales-researcher", { grants: [grant], now: NOW });
    // 営業部の ceiling に github.repo.read はないので、一時権限でも入らない（5.2.4 の受け入れ条件）
    expect(e.map((p) => p.op)).toEqual(["web.read"]);
    const dev = effectivePermissionsFor(load(), "dev-implementer", { grants: [grant], now: NOW });
    expect(dev.filter((p) => p.source.kind === "grant").map((p) => p.op)).toEqual([
      "github.repo.read",
    ]);
  });

  it("設定にいない社員・人間の社員は、間違いなので例外にする（許可を返さない）", () => {
    const members = {
      ...baseMembers,
      "a-san": {
        kind: "human",
        name: "Aさん",
        company_id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YC",
        public_key: "k",
      },
    } as Record<string, MemberInput>;
    const config = load({ members, aicoop: { humans: { intake_member: "dev-implementer" } } });
    expect(() => effectivePermissionsFor(config, "nobody", { now: NOW })).toThrow(/nobody/);
    expect(() => effectivePermissionsFor(config, "a-san", { now: NOW })).toThrow(/a-san/);
  });
});

describe("社員・部署の問い合わせ", () => {
  it("resolveMember：社員の部署と役職をまとめて返す", () => {
    const r = resolveMember(load(), "dev-implementer");
    expect(r?.group.id).toBe("dev");
    expect(r?.group.box).toBe("vm");
    expect(r?.group.memory_mib).toBe(2048);
    expect(r?.role.id).toBe("implementer");
    expect(r?.role.model).toBe("sonnet");
    expect(resolveMember(load(), "nobody")).toBeUndefined();
  });

  it("membersOfGroup・managerOf・boxKindOf", () => {
    const config = load(withManager());
    expect(membersOfGroup(config, "dev")).toEqual(["dev-implementer"]);
    expect(membersOfGroup(config, "executives")).toEqual(["mgr-dev"]);
    expect(managerOf(config, "dev")).toBe("mgr-dev");
    expect(managerOf(config, "sales")).toBeUndefined();
    expect(boxKindOf(config, "sales")).toBe("vm");
    expect(boxKindOf(config, "nothing")).toBeUndefined();
  });

  it("timeoutMinutesFor：トリガーの timeout_minutes、なければ task.timeout_minutes（5.5.5）", () => {
    const config = load({ aicoop: { task: { timeout_minutes: 30 } } });
    expect(timeoutMinutesFor(config)).toBe(30);
    expect(timeoutMinutesFor(config, { timeout_minutes: 50 })).toBe(50);
    expect(timeoutMinutesFor(config, {})).toBe(30);
  });
});

describe("promptFilesFor（5.4.3 の1）", () => {
  it("会社・役職は必ず、部署・個人はファイルがあるときだけ", () => {
    const prompts = promptsFor(baseRoles);
    expect(promptFilesFor(load({}, { prompts }), "dev-implementer")).toEqual({
      company: "company.md",
      role: "roles/implementer.md",
    });

    prompts.set("groups/dev.md", "x");
    prompts.set("members/dev-implementer.md", "x");
    expect(promptFilesFor(load({}, { prompts }), "dev-implementer")).toEqual({
      company: "company.md",
      group: "groups/dev.md",
      role: "roles/implementer.md",
      member: "members/dev-implementer.md",
    });
  });

  it("役職・社員の prompt に書いたファイルを使う", () => {
    const roles = {
      ...baseRoles,
      implementer: { ...baseRoles.implementer, prompt: "shared/dev.md" } as RoleInput,
    };
    const members = {
      ...baseMembers,
      "dev-implementer": {
        name: "実装AI",
        group: "dev",
        role: "implementer",
        prompt: "people/x.md",
      },
    } as Record<string, MemberInput>;
    const prompts = promptsFor(roles);
    prompts.set("people/x.md", "x");
    expect(promptFilesFor(load({ roles, members }, { prompts }), "dev-implementer")).toEqual({
      company: "company.md",
      role: "shared/dev.md",
      member: "people/x.md",
    });
  });
});
