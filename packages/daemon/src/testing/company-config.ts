/**
 * テスト用：一時ディレクトリに `~/.aicoop` の設定ファイルを書き、本物の読み込み（loadConfig）で読む。
 *
 * 既定は P1 の小さな会社：
 * - 開発部 dev（vm）：上限は myorg/* の github.repo.read・git.push・pr.create
 *   - dev-implementer（implementer：repo.read、git.push は myorg/app だけ、pr.create）
 *   - dev-reviewer（reviewer：repo.read）
 * - 営業部 sales（vm）：上限は web.read
 *   - sales-researcher（researcher：web.read）
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CompanyConfig, loadConfig } from "@aicoop/shared";
import { stringify } from "yaml";

export const TEST_COMPANY = { id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YB", name: "テスト商会" };

export type Yaml = Record<string, unknown>;

export interface CompanyFiles {
  readonly aicoop?: Yaml;
  readonly groups?: Record<string, Yaml>;
  readonly roles?: Record<string, Yaml>;
  readonly members?: Record<string, Yaml>;
  /** triggers.yaml の triggers（書かなければ triggers.yaml を置かない） */
  readonly triggers?: Yaml[];
  /** prompts/ からの相対パス → 中身（会社と役職のものは足りなければ足す） */
  readonly prompts?: Record<string, string>;
  /** スキル名 → （スキルのフォルダからの相対パス → 中身） */
  readonly skills?: Record<string, Record<string, string>>;
}

export const DEFAULT_GROUPS: Record<string, Yaml> = {
  dev: {
    name: "開発部",
    box: "vm",
    memory_mib: 3072,
    cpus: 2,
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

export const DEFAULT_ROLES: Record<string, Yaml> = {
  implementer: {
    name: "実装担当",
    model: "sonnet",
    max_turns: 150,
    allow: [
      { op: "github.repo.read" },
      { op: "github.git.push", params: { repo: ["myorg/app"] } },
      { op: "github.pr.create" },
    ],
  },
  reviewer: { name: "レビュー担当", allow: [{ op: "github.repo.read" }] },
  researcher: { name: "調査担当", allow: [{ op: "web.read" }] },
};

export const DEFAULT_MEMBERS: Record<string, Yaml> = {
  "dev-implementer": { name: "実装AI", group: "dev", role: "implementer" },
  "dev-reviewer": { name: "レビューAI", group: "dev", role: "reviewer" },
  "sales-researcher": { name: "調査AI", group: "sales", role: "researcher" },
};

/**
 * P2 の会社（S-1・S-4）：営業部・開発部と、それぞれの部長（役員室）。
 * - 営業部 sales：メール作成AI sales-mailer（gmail の送信は ceiling が hold）。部長は mgr-sales
 * - 開発部 dev：実装AI dev-implementer（push は myorg/app だけ。ceiling は myorg/*。pr.merge は hold）。部長は mgr-dev
 * - 部長のいない部署 solo：solo-mailer（gmail の送信は hold）
 */
export const P2_FILES: CompanyFiles = {
  groups: {
    dev: {
      name: "開発部",
      box: "vm",
      intake_member: "dev-implementer",
      ceiling: [
        { op: "github.repo.read", params: { repo: ["myorg/*"] } },
        { op: "github.git.push", params: { repo: ["myorg/*"] } },
        { op: "github.pr.create", params: { repo: ["myorg/*"] } },
        { op: "github.pr.merge", params: { repo: ["myorg/*"] }, mode: "hold" },
      ],
    },
    sales: {
      name: "営業部",
      box: "vm",
      intake_member: "sales-mailer",
      ceiling: [
        { op: "gmail.message.read" },
        { op: "gmail.draft.create" },
        { op: "gmail.draft.update" },
        { op: "gmail.message.send", mode: "hold" },
      ],
    },
    solo: {
      name: "部長のいない部署",
      box: "vm",
      ceiling: [{ op: "gmail.message.send", mode: "hold" }],
    },
    executives: { name: "役員室", box: "vm", ceiling: [] },
  },
  roles: {
    implementer: {
      name: "実装担当",
      allow: [
        { op: "github.repo.read" },
        { op: "github.git.push", params: { repo: ["myorg/app"] } },
        { op: "github.pr.create" },
        { op: "github.pr.merge" },
      ],
    },
    "mail-writer": {
      name: "メール作成担当",
      allow: [
        { op: "gmail.message.read" },
        { op: "gmail.draft.create" },
        { op: "gmail.draft.update" },
        { op: "gmail.message.send" },
      ],
    },
    manager: { name: "部長", allow: [] },
  },
  members: {
    "dev-implementer": { name: "実装AI", group: "dev", role: "implementer" },
    "sales-mailer": { name: "メール作成AI", group: "sales", role: "mail-writer" },
    "solo-mailer": { name: "ひとりのメール係", group: "solo", role: "mail-writer" },
    "mgr-dev": { name: "開発部長AI", group: "executives", role: "manager", manages: "dev" },
    "mgr-sales": { name: "営業部長AI", group: "executives", role: "manager", manages: "sales" },
  },
};

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** 設定ファイルを書く（すでにあれば上書きする） */
export function writeCompanyFiles(home: string, files: CompanyFiles = {}): void {
  const roles = files.roles ?? DEFAULT_ROLES;
  writeText(
    join(home, "aicoop.yaml"),
    stringify({ company: TEST_COMPANY, ...(files.aicoop ?? {}) }),
  );
  writeText(join(home, "groups.yaml"), stringify({ groups: files.groups ?? DEFAULT_GROUPS }));
  writeText(join(home, "roles.yaml"), stringify({ roles }));
  writeText(join(home, "members.yaml"), stringify({ members: files.members ?? DEFAULT_MEMBERS }));
  if (files.triggers !== undefined) {
    writeText(join(home, "triggers.yaml"), stringify({ triggers: files.triggers }));
  } else {
    rmSync(join(home, "triggers.yaml"), { force: true });
  }

  const prompts: Record<string, string> = {
    "company.md": "会社の方針：丁寧に。\n",
    ...Object.fromEntries(
      Object.entries(roles).map(([id, role]) => [
        (role.prompt as string | undefined) ?? `roles/${id}.md`,
        `役職 ${id} のやり方\n`,
      ]),
    ),
    ...(files.prompts ?? {}),
  };
  for (const [relative, content] of Object.entries(prompts)) {
    writeText(join(home, "prompts", ...relative.split("/")), content);
  }
  for (const [skill, skillFiles] of Object.entries(files.skills ?? {})) {
    mkdirSync(join(home, "skills", skill), { recursive: true });
    for (const [relative, content] of Object.entries(skillFiles)) {
      writeText(join(home, "skills", skill, ...relative.split("/")), content);
    }
  }
}

/** 設定ファイルを書いて、本物の読み込みで読む。誤りがあれば例外 */
export function loadTestCompany(home: string, files: CompanyFiles = {}): CompanyConfig {
  writeCompanyFiles(home, files);
  const result = loadConfig(home, {
    userHome: dirname(home),
    checkSecretsMode: false,
    now: new Date("2026-11-28T00:00:00.000Z"),
  });
  if (!result.ok) {
    throw new Error(`テストの設定が読めません: ${JSON.stringify(result.issues, null, 2)}`);
  }
  return result.config;
}
