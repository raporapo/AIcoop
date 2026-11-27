/**
 * テスト用：設定の検証（6.10）に渡す入力を組み立てる。
 * 既定では、P1 でそのまま動く小さな会社（開発部・営業部）になる。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { builtinServicesDir } from "../config/paths.ts";
import type {
  aicoopFileSchema,
  groupSchema,
  hostToolsFileSchema,
  mcpServerSchema,
  memberSchema,
  roleSchema,
  triggerSchema,
} from "../config/schema.ts";
import type { ConfigInput, ServiceSource } from "../config/validate.ts";

export const USER_HOME = resolve("/aicoop-test/user");
export const HOME = join(USER_HOME, ".aicoop");
export const COMPANY = { id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YB", name: "テスト商会" };

export type AicoopInput = z.input<typeof aicoopFileSchema>;
export type GroupInput = z.input<typeof groupSchema>;
export type RoleInput = z.input<typeof roleSchema>;
export type MemberInput = z.input<typeof memberSchema>;
export type TriggerInput = z.input<typeof triggerSchema>;
export type McpServerInput = z.input<typeof mcpServerSchema>;
export type HostToolsInput = z.input<typeof hostToolsFileSchema>;

export const baseGroups: Record<string, GroupInput> = {
  dev: {
    name: "開発部",
    box: "vm",
    intake_member: "dev-implementer",
    ceiling: [
      { op: "github.repo.read", params: { repo: ["myorg/*"] } },
      { op: "github.git.push", params: { repo: ["myorg/*"] } },
      { op: "github.pr.create", params: { repo: ["myorg/*"] } },
    ],
  },
  sales: {
    name: "営業部",
    box: "vm",
    intake_member: "sales-researcher",
    ceiling: [{ op: "web.read" }],
  },
};

export const baseRoles: Record<string, RoleInput> = {
  implementer: {
    name: "実装担当",
    allow: [{ op: "github.repo.read" }, { op: "github.git.push" }, { op: "github.pr.create" }],
  },
  researcher: { name: "調査担当", allow: [{ op: "web.read" }] },
};

export const baseMembers: Record<string, MemberInput> = {
  "dev-implementer": { name: "実装AI", group: "dev", role: "implementer" },
  "sales-researcher": { name: "調査AI", group: "sales", role: "researcher" },
};

export interface CompanyParts {
  readonly aicoop?: Partial<AicoopInput>;
  readonly groups?: Record<string, GroupInput>;
  readonly roles?: Record<string, RoleInput>;
  readonly members?: Record<string, MemberInput>;
  readonly triggers?: TriggerInput[];
  readonly mcpServers?: Record<string, McpServerInput>;
  readonly hostTools?: HostToolsInput["tools"];
  /** home/services/*.yaml（パス → 中身） */
  readonly ownerServices?: Record<string, unknown>;
}

let builtinCache: ServiceSource[] | undefined;

/** リポジトリの services/*.yaml を、検証の入力の形で読む */
export function builtinServiceSources(): ServiceSource[] {
  builtinCache ??= readdirSync(builtinServicesDir())
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((file) => {
      const path = join(builtinServicesDir(), file);
      return { source: path, builtin: true, content: parseYaml(readFileSync(path, "utf8")) };
    });
  return builtinCache;
}

/** 使われている役職のやり方と会社の方針を、すべて置いた prompts/ */
export function promptsFor(roles: Record<string, RoleInput>): Map<string, string> {
  const prompts = new Map<string, string>([["company.md", "# 会社の方針\n"]]);
  for (const [id, role] of Object.entries(roles)) {
    prompts.set(role.prompt ?? `roles/${id}.md`, `# ${role.name}\n`);
  }
  return prompts;
}

/** 部品から検証の入力を作る。書いていない部品は、P1 の小さな会社のもの */
export function configInput(
  parts: CompanyParts = {},
  over: Partial<ConfigInput> = {},
): ConfigInput {
  const roles = parts.roles ?? baseRoles;
  const files: Record<string, unknown> = {
    "aicoop.yaml": { company: COMPANY, ...parts.aicoop },
    "groups.yaml": { groups: parts.groups ?? baseGroups },
    "roles.yaml": { roles },
    "members.yaml": { members: parts.members ?? baseMembers },
  };
  if (parts.triggers) files["triggers.yaml"] = { triggers: parts.triggers };
  if (parts.mcpServers) files["mcp_servers.yaml"] = { servers: parts.mcpServers };
  if (parts.hostTools) files["host_tools.yaml"] = { tools: parts.hostTools };
  const owner = Object.entries(parts.ownerServices ?? {}).map(([source, content]) => ({
    source,
    builtin: false,
    content,
  }));
  return {
    home: HOME,
    userHome: USER_HOME,
    files,
    services: [...builtinServiceSources(), ...owner],
    prompts: promptsFor(roles),
    skills: new Set(),
    now: new Date("2026-11-28T00:00:00.000Z"),
    ...over,
  };
}

/** 6.3〜6.6・6.9 の設計書の例（すべての部署・役職・社員・トリガー） */
export function designExample(): CompanyParts {
  return {
    groups: {
      dev: {
        name: "開発部",
        box: "vm",
        memory_mib: 3072,
        cpus: 2,
        packages: ["nodejs", "npm", "python3"],
        intake_member: "dev-implementer",
        can_request: ["marketing", "design"],
        ceiling: [
          { op: "github.repo.read", params: { repo: ["myorg/*"] } },
          { op: "github.git.push", params: { repo: ["myorg/*"] } },
          { op: "github.pr.create", params: { repo: ["myorg/*"] } },
          { op: "github.issue.comment", params: { repo: ["myorg/*"] } },
          { op: "github.pr.merge", params: { repo: ["myorg/*"] }, mode: "hold" },
          { op: "web.read" },
        ],
      },
      sales: {
        name: "営業部",
        box: "vm",
        memory_mib: 1536,
        intake_member: "sales-researcher",
        can_request: ["marketing"],
        ceiling: [
          { op: "web.read" },
          { op: "gmail.message.read" },
          { op: "gmail.draft.create" },
          { op: "gmail.draft.update" },
          { op: "gmail.message.send", mode: "hold" },
        ],
      },
      marketing: {
        name: "マーケ部",
        box: "vm",
        memory_mib: 1536,
        intake_member: "marketing-sns",
        can_request: ["design"],
        ceiling: [{ op: "web.read" }],
      },
      design: {
        name: "デザイン部",
        box: "srt",
        intake_member: "design-image",
        can_request: [],
        ceiling: [],
      },
      executives: { name: "役員室", box: "vm", memory_mib: 1024, can_request: [], ceiling: [] },
      ceo: { name: "CEO", box: "none", can_request: [], ceiling: [] },
    },
    roles: {
      implementer: {
        name: "実装担当",
        model: "sonnet",
        max_turns: 150,
        allow: [
          { op: "github.repo.read" },
          { op: "github.git.push", params: { repo: ["myorg/app"] } },
          { op: "github.pr.create" },
          { op: "github.issue.comment" },
          { op: "web.read" },
        ],
        tools: [],
        skills: ["git-workflow"],
      },
      reviewer: {
        name: "レビュー担当",
        allow: [{ op: "github.repo.read" }, { op: "github.issue.comment" }],
      },
      researcher: { name: "調査担当", allow: [{ op: "web.read" }] },
      "mail-writer": {
        name: "メール作成担当",
        allow: [
          { op: "gmail.message.read" },
          { op: "gmail.draft.create" },
          { op: "gmail.draft.update" },
          { op: "gmail.message.send" },
        ],
      },
      sns: { name: "SNS担当", allow: [{ op: "web.read" }] },
      analyst: { name: "分析担当", allow: [{ op: "web.read" }] },
      image: { name: "画像担当", allow: [], tools: ["generate_image"] },
      manager: { name: "部長", allow: [] },
      ceo: { name: "CEO", model: "opus", allow: [] },
    },
    members: {
      "dev-implementer": { name: "実装AI", group: "dev", role: "implementer" },
      "dev-reviewer": { name: "レビューAI", group: "dev", role: "reviewer" },
      "sales-researcher": { name: "調査AI", group: "sales", role: "researcher" },
      "sales-mailer": { name: "メール作成AI", group: "sales", role: "mail-writer" },
      "marketing-sns": { name: "SNS担当AI", group: "marketing", role: "sns" },
      "marketing-analyst": { name: "分析AI", group: "marketing", role: "analyst" },
      "design-image": { name: "画像AI", group: "design", role: "image" },
      "mgr-dev": { name: "開発部長AI", group: "executives", role: "manager", manages: "dev" },
      "mgr-sales": { name: "営業部長AI", group: "executives", role: "manager", manages: "sales" },
      "mgr-marketing": {
        name: "マーケ部長AI",
        group: "executives",
        role: "manager",
        manages: "marketing",
      },
      "mgr-design": {
        name: "デザイン部長AI",
        group: "executives",
        role: "manager",
        manages: "design",
      },
      ceo: { name: "CEO AI", group: "ceo", role: "ceo" },
    },
    triggers: [
      {
        id: "sales-morning",
        type: "cron",
        schedule: "0 8 * * 1-5",
        member: "sales-researcher",
        thread: "morning-prospecting",
        task: {
          purpose: "今日連絡すべき見込み客を5社選ぶ",
          context: "対象は国内のSaaS企業。既存顧客の一覧は /work/crm/customers.csv",
          done_when: "/work/prospects/ に今日の日付のmdがあり、5社と理由が書かれている",
        },
      },
      {
        id: "dev-issue",
        type: "github",
        events: ["issues.labeled"],
        filter: { repository: "myorg/app", label: "aicoop" },
        member: "dev-implementer",
        thread: "issue-{{issue.number}}",
        task: {
          purpose: "Issue #{{issue.number}} を実装してPRを出す",
          context: "{{issue.title}}\n{{issue.body}}",
          done_when: "PRが作成され、report_result でPRのURLを報告した",
        },
      },
      { id: "mailer-hold-result", type: "on_hold_resolved", member: "sales-mailer" },
    ],
    hostTools: {
      comfyui: {
        start: ["~/ComfyUI/.venv/bin/python", "main.py", "--listen", "127.0.0.1", "--port", "8188"],
        cwd: "~/ComfyUI",
        health: "http://127.0.0.1:8188/system_stats",
        stop: "SIGTERM",
        start_timeout_seconds: 120,
        custom_nodes_dir: "~/ComfyUI/custom_nodes",
        allowed_custom_nodes: [],
        presets_dir: "~/.aicoop/host_tools/comfyui/presets",
      },
    },
  };
}
