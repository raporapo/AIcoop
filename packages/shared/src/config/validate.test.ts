import { describe, expect, it } from "vitest";
import type { ConfigIssue } from "../config-issue.ts";
import {
  baseGroups,
  baseMembers,
  baseRoles,
  type CompanyParts,
  configInput,
  designExample,
  type GroupInput,
  HOME,
  type MemberInput,
  promptsFor,
  type RoleInput,
  type TriggerInput,
  USER_HOME,
} from "../testing/config-fixtures.ts";
import { type ConfigInput, type ConfigResult, validateConfig } from "./validate.ts";

function check(parts: CompanyParts = {}, over: Partial<ConfigInput> = {}): ConfigResult {
  return validateConfig(configInput(parts, over));
}

function all(result: ConfigResult): readonly ConfigIssue[] {
  return result.ok ? result.warnings : result.issues;
}

function codes(result: ConfigResult): string[] {
  return all(result).map((i) => i.code);
}

function expectClean(result: ConfigResult) {
  expect(all(result)).toEqual([]);
  expect(result.ok).toBe(true);
}

/** そのコードのエラーが出て、起動しない（ok: false）こと */
function expectError(result: ConfigResult, code: string): ConfigIssue[] {
  expect(result.ok).toBe(false);
  const found = all(result).filter((i) => i.code === code);
  expect(found, `${code} が出ていない: ${JSON.stringify(all(result), null, 2)}`).not.toEqual([]);
  return found;
}

/** そのコードの警告が出るが、起動はする（ok: true）こと */
function expectWarning(result: ConfigResult, code: string): ConfigIssue[] {
  expect(result.ok, JSON.stringify(all(result), null, 2)).toBe(true);
  const found = all(result).filter((i) => i.code === code);
  expect(found, `${code} が出ていない`).not.toEqual([]);
  return found;
}

function without<T>(record: Record<string, T>, ...keys: string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k)));
}

const cronTask = { purpose: "目的", done_when: "完了の条件" };
const cron = (over: Partial<TriggerInput> = {}): TriggerInput =>
  ({
    id: "morning",
    type: "cron",
    schedule: "0 8 * * 1-5",
    member: "sales-researcher",
    task: cronTask,
    ...over,
  }) as TriggerInput;
const github = (over: Record<string, unknown> = {}): TriggerInput =>
  ({
    id: "dev-issue",
    type: "github",
    events: ["issues.labeled"],
    member: "dev-implementer",
    task: cronTask,
    ...over,
  }) as TriggerInput;

/** CEO（P4）を足した部品 */
const withCeo = (over: { group?: Partial<GroupInput>; member?: Partial<MemberInput> } = {}) => ({
  groups: { ...baseGroups, ceo: { name: "CEO", box: "none", ...over.group } as GroupInput },
  roles: { ...baseRoles, ceo: { name: "CEO", model: "opus" } },
  members: {
    ...baseMembers,
    ceo: { name: "CEO AI", group: "ceo", role: "ceo", ...over.member } as MemberInput,
  },
});

/** 役員室と部長（P4）を足した部品 */
const withManagers = (
  managers: Record<string, MemberInput>,
  executives: Partial<GroupInput> | null = {},
) => ({
  groups: {
    ...baseGroups,
    ...(executives && { executives: { name: "役員室", box: "vm", ...executives } as GroupInput }),
  },
  roles: { ...baseRoles, manager: { name: "部長" } },
  members: { ...baseMembers, ...managers },
});

describe("6.10 設定の検証", () => {
  it("P1 の小さな会社（開発部・営業部）は、エラーも警告もない", () => {
    expectClean(check());
  });

  it("6.3〜6.6・6.9 の設計書の例は、エラーにならず、警告は W-002 だけ", () => {
    const result = check(designExample(), { skills: new Set(["git-workflow"]) });
    expect(result.ok, JSON.stringify(all(result), null, 2)).toBe(true);
    // 開発部（実装担当・レビュー担当）と営業部（調査担当）で、持ち出しの危険がある
    expect(all(result).map((i) => `${i.code} ${i.path}`)).toEqual([
      "W-002 groups.dev",
      "W-002 groups.dev",
      "W-002 groups.sales",
    ]);
  });

  describe("6.1：必須のファイル", () => {
    it.each(["aicoop.yaml", "groups.yaml", "roles.yaml", "members.yaml"])(
      "%s がなければエラー",
      (name) => {
        const input = configInput();
        const files = without(input.files as Record<string, unknown>, name);
        const [issue] = expectError(validateConfig({ ...input, files }), "E-013");
        expect(issue?.source).toBe(name);
        expect(issue?.message).toContain(`${name} がありません`);
      },
    );

    it("triggers.yaml・mcp_servers.yaml・host_tools.yaml は、なくてもよい（空として扱う）", () => {
      const result = check();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.triggers).toEqual([]);
        expect(result.config.mcpServers).toEqual({});
        expect(result.config.hostTools).toEqual({});
      }
    });

    it("スキーマの誤りがあるときは、ファイルどうしの検証をしない（誤りが連鎖して出ない）", () => {
      const result = check({ groups: { dev: { name: "開発部", box: "docker" } as never } });
      expect(codes(result)).toEqual(["E-013"]);
    });
  });

  describe("E-001：存在しないものの参照", () => {
    it("社員の group が groups.yaml にない", () => {
      const [issue] = expectError(
        check({
          members: { ...baseMembers, x: { name: "x", group: "devv", role: "implementer" } },
        }),
        "E-001",
      );
      expect(issue?.source).toBe("members.yaml");
      expect(issue?.path).toBe("members.x.group");
      expect(issue?.message).toBe(
        "members.yaml の members.x.group：部署「devv」は groups.yaml にありません。groups.yaml に足すか、ある部署（dev、sales）に直してください",
      );
    });

    it("社員の role が roles.yaml にない", () => {
      const [issue] = expectError(
        check({ members: { ...baseMembers, x: { name: "x", group: "dev", role: "writer" } } }),
        "E-001",
      );
      expect(issue?.path).toBe("members.x.role");
    });

    it("部長の manages が groups.yaml にない", () => {
      const [issue] = expectError(
        check(
          withManagers({
            m: { name: "部長", group: "executives", role: "manager", manages: "devv" },
          }),
        ),
        "E-001",
      );
      expect(issue?.path).toBe("members.m.manages");
    });

    it("部署の intake_member が members.yaml にない", () => {
      const result = check({
        groups: {
          ...baseGroups,
          dev: { ...baseGroups.dev, intake_member: "nobody" } as GroupInput,
        },
      });
      const [issue] = expectError(result, "E-001");
      expect(issue?.path).toBe("groups.dev.intake_member");
      // 存在しない社員なので、E-009（その部署の社員ではない）は重ねて出さない
      expect(codes(result)).not.toContain("E-009");
    });

    it("部署の can_request が groups.yaml にない", () => {
      const [issue] = expectError(
        check({
          groups: {
            ...baseGroups,
            dev: { ...baseGroups.dev, can_request: ["marketing"] } as GroupInput,
          },
        }),
        "E-001",
      );
      expect(issue?.path).toBe("groups.dev.can_request.0");
    });

    it("ceiling の op のサービスがない", () => {
      const [issue] = expectError(
        check({
          groups: {
            ...baseGroups,
            sales: { name: "営業部", box: "vm", ceiling: [{ op: "slack.message.post" }] },
          },
        }),
        "E-001",
      );
      expect(issue?.path).toBe("groups.sales.ceiling.0.op");
      expect(issue?.message).toContain("サービス「slack」の定義がありません");
      expect(issue?.message).toContain("services/slack.yaml");
    });

    it("allow の op の操作が、そのサービスにない", () => {
      const roles = {
        ...baseRoles,
        researcher: { name: "調査担当", allow: [{ op: "web.write" }] },
      };
      const [issue] = expectError(check({ roles }), "E-001");
      expect(issue?.path).toBe("roles.researcher.allow.0.op");
      expect(issue?.message).toContain(
        "サービス web に操作「write」はありません（ある操作：web.read）",
      );
    });

    it("許可項目の params に、その操作のパスにないパラメーターを書いている（打ち間違いで許可が効かなくなる）", () => {
      const groups = {
        ...baseGroups,
        dev: {
          name: "開発部",
          box: "vm",
          ceiling: [{ op: "github.repo.read", params: { repos: ["myorg/*"] } }],
        },
      } as Record<string, GroupInput>;
      const [issue] = expectError(check({ groups }), "E-001");
      expect(issue?.path).toBe("groups.dev.ceiling.0.params.repos");
      expect(issue?.message).toContain("使えるのは repo");
    });

    it("パラメーターのない操作（web.read）に params を書いている", () => {
      const groups = {
        ...baseGroups,
        sales: {
          name: "営業部",
          box: "vm",
          ceiling: [{ op: "web.read", params: { host: ["example.com"] } }],
        },
      } as Record<string, GroupInput>;
      expectError(check({ groups }), "E-001");
    });

    it("トリガーの member が members.yaml にない", () => {
      const [issue] = expectError(check({ triggers: [cron({ member: "nobody" })] }), "E-001");
      expect(issue?.source).toBe("triggers.yaml");
      expect(issue?.path).toBe("triggers.0.member");
    });

    it("トリガーの member が人間の社員（AI の社員ではない）", () => {
      const members = {
        ...baseMembers,
        "a-san": {
          kind: "human",
          name: "Aさん",
          company_id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YC",
          public_key: "k",
        },
      } as Record<string, MemberInput>;
      const [issue] = expectError(
        check({ members, triggers: [cron({ member: "a-san" })] }),
        "E-001",
      );
      expect(issue?.message).toContain("AI の社員");
    });

    it("役職の tools の上流MCPが mcp_servers.yaml にない", () => {
      const roles = { ...baseRoles, researcher: { name: "調査担当", tools: ["notion.search"] } };
      const [issue] = expectError(check({ roles }), "E-001");
      expect(issue?.path).toBe("roles.researcher.tools.0");
      expect(issue?.message).toContain("mcp_servers.yaml");
    });

    it("役職の tools の上流MCPが mcp_servers.yaml にあれば通る", () => {
      const roles = {
        ...baseRoles,
        researcher: { name: "調査担当", tools: ["notion.search", "notion.*"] },
      };
      expectClean(
        check({
          roles,
          mcpServers: { notion: { url: "https://mcp.notion.com/mcp", secret: "notion" } },
        }),
      );
    });

    it("generate_image を使う役職があるのに、host_tools.yaml に comfyui がない", () => {
      const roles = {
        ...baseRoles,
        researcher: { name: "調査担当", allow: [{ op: "web.read" }], tools: ["generate_image"] },
      };
      const [issue] = expectError(check({ roles }), "E-001");
      expect(issue?.message).toContain("host_tools.yaml");
    });

    it("役職の skills のフォルダが skills/ にない", () => {
      const roles = {
        ...baseRoles,
        implementer: { ...baseRoles.implementer, skills: ["git-workflow"] } as RoleInput,
      };
      const [issue] = expectError(check({ roles }), "E-001");
      expect(issue?.path).toBe("roles.implementer.skills.0");
      expect(issue?.message).toContain("skills/git-workflow/");
      expectClean(check({ roles }, { skills: new Set(["git-workflow"]) }));
    });

    it("humans.intake_member を書いていて、その社員がいない", () => {
      const [issue] = expectError(check({ aicoop: { humans: { intake_member: "ceo" } } }), "E-001");
      expect(issue?.source).toBe("aicoop.yaml");
      expect(issue?.path).toBe("humans.intake_member");
    });

    it("humans.intake_member を書いていなければ、人間の社員がいないうちは確かめない（既定の ceo は P4）", () => {
      expectClean(check());
    });

    it("人間の社員がいるのに、既定の humans.intake_member（ceo）がいない", () => {
      const members = {
        ...baseMembers,
        "a-san": {
          kind: "human",
          name: "Aさん",
          company_id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YC",
          public_key: "k",
        },
      } as Record<string, MemberInput>;
      const [issue] = expectError(check({ members }), "E-001");
      expect(issue?.path).toBe("humans.intake_member");
    });
  });

  describe("E-001：JavaScript の組み込みの名前（constructor）を、あるものと取り違えない", () => {
    it("社員の group・role が constructor", () => {
      const members = {
        ...baseMembers,
        x: { name: "x", group: "constructor", role: "constructor" },
      } as Record<string, MemberInput>;
      const result = check({ members });
      expect(all(result).map((i) => `${i.code} ${i.path}`)).toEqual([
        "E-001 members.x.group",
        "E-001 members.x.role",
      ]);
    });

    it("操作の名前が constructor（例外で落ちずに E-001）", () => {
      const roles = {
        ...baseRoles,
        researcher: { name: "調査担当", allow: [{ op: "web.constructor" }] },
      };
      expect(() => check({ roles })).not.toThrow();
      expectError(check({ roles }), "E-001");
    });

    it("上流MCP・トリガーの社員・intake_member が constructor", () => {
      const roles = {
        ...baseRoles,
        researcher: {
          name: "調査担当",
          allow: [{ op: "web.read" }],
          tools: ["constructor.search"],
        },
      };
      const groups = {
        ...baseGroups,
        dev: { ...baseGroups.dev, intake_member: "constructor" },
      } as Record<string, GroupInput>;
      const result = check({ roles, groups, triggers: [cron({ member: "constructor" })] });
      expect(all(result).map((i) => `${i.code} ${i.path}`)).toEqual([
        "E-001 groups.dev.intake_member",
        "E-001 roles.researcher.tools.0",
        "E-001 triggers.0.member",
      ]);
    });

    it("読んだ結果の部署・役職・社員も、組み込みの名前を持たない", () => {
      const result = check();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.groups.constructor).toBeUndefined();
      expect(result.config.members.constructor).toBeUndefined();
    });
  });

  describe("E-001：プロンプトのファイル（5.4.3）", () => {
    it("prompts/company.md がない", () => {
      const prompts = promptsFor(baseRoles);
      prompts.delete("company.md");
      const [issue] = expectError(check({}, { prompts }), "E-001");
      expect(issue?.message).toContain("prompts/company.md");
    });

    it("使われている役職の prompts/roles/<role>.md がない", () => {
      const prompts = promptsFor(baseRoles);
      prompts.delete("roles/implementer.md");
      const [issue] = expectError(check({}, { prompts }), "E-001");
      expect(issue?.source).toBe("roles.yaml");
      expect(issue?.path).toBe("roles.implementer");
      expect(issue?.message).toContain("prompts/roles/implementer.md");
    });

    it("どの社員も使っていない役職は、md がなくてもよい", () => {
      const roles = { ...baseRoles, reviewer: { name: "レビュー担当" } };
      expectClean(check({ roles }, { prompts: promptsFor(baseRoles) }));
    });

    it("役職の prompt に書いたファイルがない", () => {
      const roles = {
        ...baseRoles,
        researcher: { name: "調査担当", allow: [{ op: "web.read" }], prompt: "shared/research.md" },
      };
      const prompts = promptsFor(baseRoles);
      const [issue] = expectError(check({ roles }, { prompts }), "E-001");
      expect(issue?.path).toBe("roles.researcher.prompt");
      // 書いたファイルがあれば、既定の roles/<role>.md はなくてよい
      prompts.set("shared/research.md", "x");
      prompts.delete("roles/researcher.md");
      expectClean(check({ roles }, { prompts }));
    });

    it("社員の prompt に書いたファイルがない（書いていなければ、members/<member>.md はなくてよい）", () => {
      const members = {
        ...baseMembers,
        "dev-implementer": {
          name: "実装AI",
          group: "dev",
          role: "implementer",
          prompt: "members/x.md",
        },
      } as Record<string, MemberInput>;
      const [issue] = expectError(check({ members }), "E-001");
      expect(issue?.path).toBe("members.dev-implementer.prompt");
    });
  });

  describe("E-002：box: none と CEO", () => {
    it("CEO が1人、部署 ceo（box: none）にいれば通る", () => {
      expectClean(check(withCeo()));
    });

    it("CEO は P4 なので、CEO がいない会社も通る", () => {
      expectClean(check());
    });

    it("box: none の部署に、ceo 役職以外の社員がいる", () => {
      const parts = withCeo();
      const members = {
        ...parts.members,
        x: { name: "x", group: "ceo", role: "implementer" },
      } as Record<string, MemberInput>;
      const [issue] = expectError(check({ ...parts, members }), "E-002");
      expect(issue?.path).toBe("members.x.group");
    });

    it("ceo 役職の社員が2人いる", () => {
      const parts = withCeo();
      const members = {
        ...parts.members,
        ceo2: { name: "CEO2", group: "ceo", role: "ceo" },
      } as Record<string, MemberInput>;
      expectError(check({ ...parts, members }), "E-002");
    });

    it("ceo 役職の社員が box: none 以外の部署にいる", () => {
      const parts = withCeo();
      const members = {
        ...without(parts.members, "ceo"),
        boss: { name: "CEO", group: "dev", role: "ceo" },
      } as Record<string, MemberInput>;
      const [issue] = expectError(check({ ...parts, members }), "E-002");
      expect(issue?.path).toBe("members.boss.group");
    });

    it("box: none を ceo 以外の部署に使っている", () => {
      const groups = { ...baseGroups, boss: { name: "社長室", box: "none" } } as Record<
        string,
        GroupInput
      >;
      const [issue] = expectError(check({ groups }), "E-002");
      expect(issue?.path).toBe("groups.boss.box");
    });

    it("部署 ceo が box: none ではない", () => {
      const [issue] = expectError(check(withCeo({ group: { box: "vm" } })), "E-002");
      expect(issue?.path).toBe("groups.ceo.box");
    });
  });

  describe("E-003：box: srt の部署", () => {
    const design = (role: RoleInput, ceiling: GroupInput["ceiling"] = []) => ({
      groups: { ...baseGroups, design: { name: "デザイン部", box: "srt", ceiling } as GroupInput },
      roles: { ...baseRoles, image: role },
      members: {
        ...baseMembers,
        "design-image": { name: "画像AI", group: "design", role: "image" },
      },
    });

    it("srt の部署の社員の役職が、サービスの操作を許可していなければ通る", () => {
      expectClean(check(design({ name: "画像担当", allow: [] })));
    });

    it("srt の部署の社員の役職が web.read を許可していたらエラー", () => {
      const [issue] = expectError(
        check(design({ name: "画像担当", allow: [{ op: "web.read" }] })),
        "E-003",
      );
      expect(issue?.path).toBe("members.design-image.role");
      expect(issue?.message).toContain("資格プロキシを通らない");
    });

    it("srt の部署の上限（ceiling）が空でなければエラー（一時権限で操作が足せてしまう）", () => {
      const [issue] = expectError(
        check(design({ name: "画像担当" }, [{ op: "web.read" }])),
        "E-003",
      );
      expect(issue?.path).toBe("groups.design.ceiling");
    });
  });

  describe("E-004：部長", () => {
    const manager = (over: Partial<MemberInput> = {}) =>
      ({
        name: "開発部長AI",
        group: "executives",
        role: "manager",
        manages: "dev",
        ...over,
      }) as MemberInput;

    it("役員室にいて、1つの部署を担当する部長は通る", () => {
      expectClean(
        check(withManagers({ "mgr-dev": manager(), "mgr-sales": manager({ manages: "sales" }) })),
      );
    });

    it("部長が executives 以外に所属している", () => {
      const [issue] = expectError(check(withManagers({ m: manager({ group: "dev" }) })), "E-004");
      expect(issue?.path).toBe("members.m.group");
    });

    it("部長に manages がない", () => {
      const [issue] = expectError(
        check(withManagers({ m: manager({ manages: undefined }) })),
        "E-004",
      );
      expect(issue?.path).toBe("members.m");
    });

    it("同じ部署を2人の部長が manages している", () => {
      const [issue] = expectError(check(withManagers({ a: manager(), b: manager() })), "E-004");
      expect(issue?.path).toBe("members.b.manages");
    });

    it.each(["executives", "ceo"])("manages に %s は書けない", (target) => {
      const parts = withManagers({ m: manager({ manages: target }) });
      const groups = { ...parts.groups, ceo: { name: "CEO", box: "none" } as GroupInput };
      expectError(check({ ...parts, groups }), "E-004");
    });

    it("部長以外の社員に manages を書いている（E-013）", () => {
      const members = {
        ...baseMembers,
        x: { name: "x", group: "dev", role: "implementer", manages: "sales" },
      } as Record<string, MemberInput>;
      const [issue] = expectError(check({ members }), "E-013");
      expect(issue?.path).toBe("members.x.manages");
    });
  });

  describe("E-005：github.git.push の hold", () => {
    it("部署の ceiling の github.git.push に mode: hold があればエラー", () => {
      const groups = {
        ...baseGroups,
        dev: { ...baseGroups.dev, ceiling: [{ op: "github.git.push", mode: "hold" }] },
      } as Record<string, GroupInput>;
      const roles = {
        ...baseRoles,
        implementer: { name: "実装担当", allow: [{ op: "github.git.push" }] },
      };
      const [issue] = expectError(check({ groups, roles }), "E-005");
      expect(issue?.path).toBe("groups.dev.ceiling.0.mode");
    });

    it("役職の allow の github.git.push に mode: hold があればエラー", () => {
      const roles = {
        ...baseRoles,
        implementer: { name: "実装担当", allow: [{ op: "github.git.push", mode: "hold" }] },
      } as Record<string, RoleInput>;
      const [issue] = expectError(check({ roles }), "E-005");
      expect(issue?.path).toBe("roles.implementer.allow.0.mode");
    });

    it("github.pr.merge の hold はよい", () => {
      const groups = {
        ...baseGroups,
        dev: {
          ...baseGroups.dev,
          ceiling: [...(baseGroups.dev?.ceiling ?? []), { op: "github.pr.merge", mode: "hold" }],
        },
      } as Record<string, GroupInput>;
      expectClean(check({ groups }));
    });
  });

  describe("E-006：時間制限", () => {
    it("task.timeout_minutes が55を超えたらエラー、55はよい", () => {
      const [issue] = expectError(check({ aicoop: { task: { timeout_minutes: 56 } } }), "E-006");
      expect(issue?.path).toBe("task.timeout_minutes");
      expectClean(check({ aicoop: { task: { timeout_minutes: 55 } } }));
    });

    it("トリガーの timeout_minutes が55を超えたらエラー、55はよい", () => {
      const [issue] = expectError(check({ triggers: [cron({ timeout_minutes: 56 })] }), "E-006");
      expect(issue?.path).toBe("triggers.0.timeout_minutes");
      expectClean(check({ triggers: [cron({ timeout_minutes: 55 })] }));
    });
  });

  describe("E-007：cron式", () => {
    it.each(["0 8 * * 1-5", "*/15 9-18 * * MON-FRI", "0 0 1 * *", "30 7 * * 0,6"])(
      "%s は読める",
      (schedule) => {
        expectClean(check({ triggers: [cron({ schedule })] }));
      },
    );

    it.each([
      ["範囲外の分", "61 8 * * *"],
      ["項目が足りない", "0 8 * *"],
      ["6項目（秒つき）", "0 0 8 * * 1-5"],
      ["ニックネーム", "@daily"],
      ["空", ""],
      ["一度も起きない（2月31日）", "0 8 31 2 *"],
    ])("%s（%s）はエラー", (_label, schedule) => {
      const [issue] = expectError(check({ triggers: [cron({ schedule })] }), "E-007");
      expect(issue?.path).toBe("triggers.0.schedule");
      expect(issue?.message).toContain("分 時 日 月 曜日");
    });

    it("enabled: false のトリガーも確かめる（有効にしたときに初めて壊れないように）", () => {
      expectError(check({ triggers: [cron({ schedule: "61 8 * * *", enabled: false })] }), "E-007");
    });
  });

  describe("E-008：secrets.json の権限", () => {
    it.each([0o644, 0o640, 0o400, 0o700])("0%o はエラー", (mode) => {
      const [issue] = expectError(check({}, { secretsMode: mode }), "E-008");
      expect(issue?.source).toBe("secrets.json");
      expect(issue?.message).toContain("chmod 600");
    });

    it("0600 はよい。ファイルがない（null）・確かめない（Windows）もよい", () => {
      expectClean(check({}, { secretsMode: 0o600 }));
      expectClean(check({}, { secretsMode: null }));
      expectClean(check({}, { secretsMode: undefined }));
    });
  });

  describe("E-009：intake_member", () => {
    it("intake_member がその部署の社員でなければエラー", () => {
      const groups = {
        ...baseGroups,
        dev: { ...baseGroups.dev, intake_member: "sales-researcher" },
      } as Record<string, GroupInput>;
      const [issue] = expectError(check({ groups }), "E-009");
      expect(issue?.path).toBe("groups.dev.intake_member");
      expect(issue?.message).toContain("dev-implementer");
    });
  });

  describe("E-010・E-011：オーナーのサービス定義", () => {
    const xService = (over: Record<string, unknown> = {}) => ({
      id: "x",
      hosts: ["api.x.com"],
      secret: { env: "X_TOKEN", kind: "static_token", header: "authorization" },
      operations: {
        "post.create": { match: [{ method: "POST", path: "/2/tweets" }], tags: ["sends_external"] },
      },
      ...over,
    });

    it("オーナーのサービスを足して、部署の上限で使える", () => {
      const groups = {
        ...baseGroups,
        sales: {
          name: "営業部",
          box: "vm",
          ceiling: [{ op: "web.read" }, { op: "x.post.create", mode: "hold" }],
        },
      } as Record<string, GroupInput>;
      const result = check({ groups, ownerServices: { "services/x.yaml": xService() } });
      expectClean(result);
      if (result.ok) expect(result.config.catalog.getOperation("x.post.create")).toBeDefined();
    });

    it("E-010：web 以外のサービスの hosts に * がある（どのファイルかを書く）", () => {
      const [issue] = expectError(
        check({ ownerServices: { "services/x.yaml": xService({ hosts: ["*"] }) } }),
        "E-010",
      );
      expect(issue?.source).toBe("services/x.yaml");
    });

    it("E-011：資格を使うサービスの hosts が、組み込みの github と重なる", () => {
      const [issue] = expectError(
        check({ ownerServices: { "services/x.yaml": xService({ hosts: ["api.github.com"] }) } }),
        "E-011",
      );
      expect(issue?.source).toBe("services/x.yaml");
    });

    it("同じ id で組み込みを丸ごと上書きできる（上書きした組み込みの hosts とは重ならない）", () => {
      const ownGithub = xService({ id: "github", hosts: ["api.github.com"] });
      const groups = {
        ...baseGroups,
        dev: { name: "開発部", box: "vm", ceiling: [{ op: "github.post.create" }] },
      } as Record<string, GroupInput>;
      const roles = {
        ...baseRoles,
        implementer: { name: "実装担当", allow: [{ op: "github.post.create" }] },
      };
      const result = check({ groups, roles, ownerServices: { "services/github.yaml": ownGithub } });
      expectClean(result);
      if (result.ok) expect(result.config.catalog.getOperation("github.repo.read")).toBeUndefined();
    });

    it("サービス定義の形の誤りは E-013（どのファイルかを書く）", () => {
      const [issue] = expectError(
        check({ ownerServices: { "services/x.yaml": xService({ hosts: [] }) } }),
        "E-013",
      );
      expect(issue?.source).toBe("services/x.yaml");
      expect(issue?.message).toContain("services/x.yaml の hosts");
    });

    it("オーナーの2つのファイルが同じ id（どちらが効くか決まらない）は E-013", () => {
      const [issue] = expectError(
        check({ ownerServices: { "services/a.yaml": xService(), "services/b.yaml": xService() } }),
        "E-013",
      );
      expect(issue?.source).toBe("services/b.yaml");
    });
  });

  describe("E-012：役員室", () => {
    it("部長がいるのに executives がない", () => {
      const result = check(
        withManagers(
          { m: { name: "部長", group: "executives", role: "manager", manages: "dev" } },
          null,
        ),
      );
      expectError(result, "E-012");
    });

    it("executives が box: vm ではない（部長がいなくてもエラー）", () => {
      const groups = { ...baseGroups, executives: { name: "役員室", box: "srt" } } as Record<
        string,
        GroupInput
      >;
      const [issue] = expectError(check({ groups }), "E-012");
      expect(issue?.path).toBe("groups.executives.box");
    });
  });

  describe("E-013：値の誤り（ファイルをまたぐもの）", () => {
    it("daemon.home が、実際に読んでいる置き場所と違う", () => {
      const [issue] = expectError(check({ aicoop: { daemon: { home: "~/other" } } }), "E-013");
      expect(issue?.path).toBe("daemon.home");
    });

    it("daemon.home は ~ を展開して比べる。書いていなければ実際の置き場所になる", () => {
      const result = check({ aicoop: { daemon: { home: "~/.aicoop" } } });
      expectClean(result);
      if (result.ok) expect(result.config.aicoop.daemon.home).toBe(HOME);
      const omitted = check();
      if (omitted.ok) expect(omitted.config.aicoop.daemon.home).toBe(HOME);
    });

    it("daemon.home が相対パス", () => {
      expectError(check({ aicoop: { daemon: { home: ".aicoop" } } }), "E-013");
    });

    it("トリガーの id が重なっている", () => {
      const [issue] = expectError(check({ triggers: [cron(), cron()] }), "E-013");
      expect(issue?.path).toBe("triggers.1.id");
    });

    it("anthropic_passthrough_hosts に、サービスのホストがある（素通しするとルールの判定を通らない）", () => {
      const [issue] = expectError(
        check({ aicoop: { anthropic_passthrough_hosts: ["api.anthropic.com", "api.github.com"] } }),
        "E-013",
      );
      expect(issue?.path).toBe("anthropic_passthrough_hosts.1");
    });

    describe("github トリガーのテンプレート変数（6.6）", () => {
      it("表にある変数は使える", () => {
        expectClean(
          check({
            triggers: [
              github({
                events: ["issues.opened", "issues.labeled"],
                thread: "issue-{{issue.number}}",
                task: {
                  purpose: "Issue #{{ issue.number }} を実装する",
                  context: "{{issue.title}}\n{{issue.body}}\n{{issue.html_url}}",
                  done_when: "{{repository.full_name}} にPRを出した",
                },
              }),
            ],
          }),
        );
      });

      it("表にない変数はエラー", () => {
        const [issue] = expectError(
          check({
            triggers: [
              github({ task: { purpose: "{{issue.user.login}} の Issue", done_when: "d" } }),
            ],
          }),
          "E-013",
        );
        expect(issue?.path).toBe("triggers.0.task.purpose");
        expect(issue?.message).toContain("issue.user.login");
      });

      it("events のどれかで使えない変数はエラー（label.name は issues.labeled だけ）", () => {
        const [issue] = expectError(
          check({
            triggers: [
              github({
                events: ["issues.opened", "issues.labeled"],
                task: { purpose: "{{label.name}}", done_when: "d" },
              }),
            ],
          }),
          "E-013",
        );
        expect(issue?.message).toContain("issues.opened");
      });

      it("外の人が書いた文章（*の変数）は thread に使えない", () => {
        const [issue] = expectError(
          check({ triggers: [github({ thread: "issue-{{issue.title}}" })] }),
          "E-013",
        );
        expect(issue?.path).toBe("triggers.0.thread");
      });

      it("閉じていない {{ はエラー", () => {
        expectError(check({ triggers: [github({ thread: "issue-{{issue.number" })] }), "E-013");
      });

      it("cron トリガーではテンプレート変数を使えない", () => {
        const [issue] = expectError(
          check({ triggers: [cron({ thread: "day-{{date}}" })] }),
          "E-013",
        );
        expect(issue?.path).toBe("triggers.0.thread");
      });
    });
  });

  describe("E-014：ceo・executives の ceiling", () => {
    it("部署 ceo の ceiling が空でない", () => {
      const [issue] = expectError(
        check(withCeo({ group: { ceiling: [{ op: "web.read" }] } })),
        "E-014",
      );
      expect(issue?.path).toBe("groups.ceo.ceiling");
    });

    it("部署 executives の ceiling が空でない", () => {
      const groups = {
        ...baseGroups,
        executives: { name: "役員室", box: "vm", ceiling: [{ op: "web.read" }] },
      } as Record<string, GroupInput>;
      const [issue] = expectError(check({ groups }), "E-014");
      expect(issue?.path).toBe("groups.executives.ceiling");
    });
  });

  describe("W-001：部署の上限にない許可", () => {
    it("役職の allow に、所属部署の ceiling にない操作がある", () => {
      const roles = {
        ...baseRoles,
        researcher: { name: "調査担当", allow: [{ op: "web.read" }, { op: "gmail.message.read" }] },
      };
      const [issue] = expectWarning(check({ roles }), "W-001");
      expect(issue?.path).toBe("roles.researcher.allow.1.op");
      expect(issue?.message).toContain("営業部");
    });

    it("部長の allow は、役員室の ceiling（空）と比べる", () => {
      const parts = withManagers({
        m: { name: "部長", group: "executives", role: "manager", manages: "dev" },
      });
      const roles = { ...parts.roles, manager: { name: "部長", allow: [{ op: "web.read" }] } };
      expectWarning(check({ ...parts, roles }), "W-001");
    });
  });

  describe("W-002：持ち出しの危険", () => {
    it("1人の社員が、sends_external を allow で持ち、reads_internal も持つ", () => {
      const groups = {
        ...baseGroups,
        dev: {
          ...baseGroups.dev,
          ceiling: [...(baseGroups.dev?.ceiling ?? []), { op: "web.read" }],
        },
      } as Record<string, GroupInput>;
      const roles = {
        ...baseRoles,
        implementer: { name: "実装担当", allow: [{ op: "github.repo.read" }, { op: "web.read" }] },
      };
      const [issue] = expectWarning(check({ groups, roles }), "W-002");
      expect(issue?.source).toBe("groups.yaml");
      expect(issue?.path).toBe("groups.dev");
      expect(issue?.message).toContain("web.read");
      expect(issue?.message).toContain("github.repo.read");
    });

    it("同じ部署の別の社員が reads_internal を持つ", () => {
      const groups = {
        ...baseGroups,
        sales: {
          name: "営業部",
          box: "vm",
          ceiling: [{ op: "web.read" }, { op: "gmail.message.read" }],
        },
      } as Record<string, GroupInput>;
      const roles = {
        ...baseRoles,
        mailer: { name: "メール作成担当", allow: [{ op: "gmail.message.read" }] },
      };
      const members = {
        ...baseMembers,
        "sales-mailer": { name: "メール作成AI", group: "sales", role: "mailer" },
      };
      expectWarning(check({ groups, roles, members }), "W-002");
    });

    it("送る操作が hold なら出ない", () => {
      const groups = {
        ...baseGroups,
        dev: {
          ...baseGroups.dev,
          ceiling: [
            ...(baseGroups.dev?.ceiling ?? []),
            { op: "github.issue.comment", mode: "hold" },
          ],
        },
      } as Record<string, GroupInput>;
      const roles = {
        ...baseRoles,
        implementer: {
          name: "実装担当",
          allow: [{ op: "github.repo.read" }, { op: "github.issue.comment" }],
        },
      };
      expectClean(check({ groups, roles }));
    });

    it("送る部署と読む部署が別なら出ない", () => {
      expectClean(check());
    });
  });

  describe("W-003：依頼の循環", () => {
    const requesting = (map: Record<string, string[]>) => ({
      groups: Object.fromEntries(
        Object.entries(baseGroups).map(([id, g]) => [id, { ...g, can_request: map[id] ?? [] }]),
      ) as Record<string, GroupInput>,
    });

    it("A→B→A はエラーではなく警告", () => {
      const [issue] = expectWarning(check(requesting({ dev: ["sales"], sales: ["dev"] })), "W-003");
      expect(issue?.message).toContain("dev → sales → dev");
    });

    it("自分自身への依頼も循環", () => {
      expectWarning(check(requesting({ dev: ["dev"] })), "W-003");
    });

    it("循環していなければ出ない", () => {
      expectClean(check(requesting({ dev: ["sales"] })));
    });

    it("1つの循環には、警告を1つだけ出す", () => {
      const groups = { ...baseGroups, design: { name: "デザイン部", box: "vm" } } as Record<
        string,
        GroupInput
      >;
      const parts = requesting({ dev: ["sales"], sales: ["design"] });
      const result = check({
        groups: {
          ...parts.groups,
          design: { ...groups.design, can_request: ["dev"] } as GroupInput,
        },
      });
      expect(codes(result)).toEqual(["W-003"]);
    });
  });

  describe("読んだ結果（CompanyConfig）", () => {
    it("既定値で埋め、サービスの一覧と、読んだファイルのハッシュを入れる", () => {
      const result = check({}, { fileHashes: { "aicoop.yaml": "ab" } });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { config } = result;
      expect(config.home).toBe(HOME);
      expect(config.aicoop.timezone).toBe("Asia/Tokyo");
      expect(config.aicoop.humans.intake_member).toBe("ceo");
      expect(config.groups.dev?.memory_mib).toBe(2048);
      expect(config.members["dev-implementer"]?.kind).toBe("ai");
      expect(config.services.map((s) => s.id)).toEqual(["github", "gmail", "web"]);
      expect(config.catalog.getOperation("github.git.push")).toBeDefined();
      expect(config.fileHashes).toEqual({ "aicoop.yaml": "ab" });
      expect(config.prompts.get("company.md")).toBeDefined();
    });

    it("userHome は ~ の展開にだけ使う", () => {
      const result = check({ aicoop: { daemon: { home: "~/.aicoop" } } }, { userHome: USER_HOME });
      expect(result.ok).toBe(true);
    });
  });
});
