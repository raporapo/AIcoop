/**
 * 読み込み・検証の済んだ会社の設定（CompanyConfig）と、daemon・CLI が使う問い合わせ。
 */
import type { BoxKind } from "../box.ts";
import { type EffectivePermission, effectivePermissions, type GrantInput } from "../permission.ts";
import type { ServiceCatalog, ServiceDefinition } from "../service.ts";
import type {
  AicoopFile,
  AiMemberConfig,
  GroupConfig,
  HostToolsConfig,
  McpServerConfig,
  MemberConfig,
  RoleConfig,
  TriggerConfig,
} from "./schema.ts";

/** `aicoop.yaml`（6.2）。書いていないキーは既定値で埋めてある */
export type AicoopConfig = Omit<AicoopFile, "daemon" | "humans"> & {
  readonly daemon: Omit<AicoopFile["daemon"], "home"> & {
    /** 設定の置き場所（絶対パス）。`~` は展開してある */
    readonly home: string;
  };
  readonly humans: Omit<AicoopFile["humans"], "intake_member"> & {
    readonly intake_member: string;
  };
};

export interface CompanyConfig {
  /** 設定の置き場所（絶対パス）。`aicoop.daemon.home` と同じ */
  readonly home: string;
  readonly aicoop: AicoopConfig;
  readonly groups: Readonly<Record<string, GroupConfig>>;
  readonly roles: Readonly<Record<string, RoleConfig>>;
  readonly members: Readonly<Record<string, MemberConfig>>;
  readonly triggers: readonly TriggerConfig[];
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly hostTools: HostToolsConfig;
  /** 組み込みにオーナーの定義を重ねたもの（5.2.3 の1） */
  readonly services: readonly ServiceDefinition[];
  readonly catalog: ServiceCatalog;
  /** `prompts/` の下の md（`prompts/` からの相対パス、`/` 区切り → 中身） */
  readonly prompts: ReadonlyMap<string, string>;
  /**
   * 読んだファイルごとの SHA-256（16進）。監査ログの `config.load` に書く（5.10）。
   * キーは home からの相対パス（`/` 区切り）。組み込みのサービス定義は `builtin:services/<file>`
   */
  readonly fileHashes: Readonly<Record<string, string>>;
}

/** 社員と、その社員が動く部署・役職 */
export interface ResolvedMember {
  readonly id: string;
  readonly member: AiMemberConfig;
  /** 社員が動く箱の部署（部長は役員室。5.1.1） */
  readonly group: GroupConfig & { readonly id: string };
  readonly role: RoleConfig & { readonly id: string };
}

const EXECUTIVES = "executives";
const MANAGER = "manager";

/** AI の社員を、部署・役職と合わせて引く。設定にいない・人間の社員なら undefined */
export function resolveMember(config: CompanyConfig, memberId: string): ResolvedMember | undefined {
  const member = Object.hasOwn(config.members, memberId) ? config.members[memberId] : undefined;
  if (member === undefined || member.kind !== "ai") return undefined;
  const groupId = member.role === MANAGER ? EXECUTIVES : member.group;
  const group = Object.hasOwn(config.groups, groupId) ? config.groups[groupId] : undefined;
  const role = Object.hasOwn(config.roles, member.role) ? config.roles[member.role] : undefined;
  if (group === undefined || role === undefined) return undefined;
  return {
    id: memberId,
    member,
    group: { id: groupId, ...group },
    role: { id: member.role, ...role },
  };
}

/**
 * 社員の有効な許可 E(m)（5.2.4 の2）：役職の allow と、動く部署の ceiling、一時権限から求める。
 * 部長は、担当する部署ではなく役員室の ceiling を使う（5.1.1）。
 * 設定にいない社員・人間の社員は呼び出し側の間違いなので、許可を返さずに例外にする。
 */
export function effectivePermissionsFor(
  config: CompanyConfig,
  memberId: string,
  opts: { readonly grants?: readonly GrantInput[]; readonly now: Date },
): EffectivePermission[] {
  const resolved = resolveMember(config, memberId);
  if (resolved === undefined) {
    throw new Error(`社員「${memberId}」は、AI の社員として設定にいません`);
  }
  return effectivePermissions({
    allow: resolved.role.allow,
    ceiling: resolved.group.ceiling,
    ...(opts.grants !== undefined && { grants: opts.grants }),
    now: opts.now,
  });
}

/** 部署に所属する AI の社員（members.yaml の順） */
export function membersOfGroup(config: CompanyConfig, groupId: string): string[] {
  return Object.entries(config.members)
    .filter(([, m]) => m.kind === "ai" && m.group === groupId)
    .map(([id]) => id);
}

/** 部署を担当する部長（`manages`）。いなければ undefined */
export function managerOf(config: CompanyConfig, groupId: string): string | undefined {
  return Object.entries(config.members).find(
    ([, m]) => m.kind === "ai" && m.role === MANAGER && m.manages === groupId,
  )?.[0];
}

/** 部署の箱の種類（5.1.2）。部署がなければ undefined */
export function boxKindOf(config: CompanyConfig, groupId: string): BoxKind | undefined {
  return Object.hasOwn(config.groups, groupId) ? config.groups[groupId]?.box : undefined;
}

/** 1回の実行の時間制限（分）。トリガーの timeout_minutes、なければ task.timeout_minutes（5.5.5） */
export function timeoutMinutesFor(
  config: CompanyConfig,
  trigger?: { readonly timeout_minutes?: number | undefined },
): number {
  return trigger?.timeout_minutes ?? config.aicoop.task.timeout_minutes;
}

/** プロンプトに重ねるファイル（5.4.3 の1）。どれも `prompts/` からの相対パス */
export interface PromptFiles {
  /** 1. 会社の方針 */
  readonly company: string;
  /** 2. 部署の方針（ファイルがあるときだけ） */
  readonly group?: string;
  /** 3. 役職のやり方 */
  readonly role: string;
  /** 4. 個人への調整（ファイルがあるときだけ） */
  readonly member?: string;
}

/** 社員のプロンプトに重ねるファイル。設定にいない・人間の社員なら undefined */
export function promptFilesFor(config: CompanyConfig, memberId: string): PromptFiles | undefined {
  const resolved = resolveMember(config, memberId);
  if (resolved === undefined) return undefined;
  const group = `groups/${resolved.member.group}.md`;
  const member = resolved.member.prompt ?? `members/${memberId}.md`;
  return {
    company: "company.md",
    ...(config.prompts.has(group) && { group }),
    role: resolved.role.prompt ?? `roles/${resolved.role.id}.md`,
    ...(config.prompts.has(member) && { member }),
  };
}
