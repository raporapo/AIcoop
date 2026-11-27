/**
 * 設定の検証（6.10）。読んだ中身だけを見る純粋な部分（ファイルを読むのは load.ts）。
 *
 * 1. ファイルごとのスキーマ（型・範囲・知らないキー）と、必須のファイル → E-013
 * 2. 1 で誤りがあれば、そこで止める（読めていないファイルを参照して、誤りが連鎖して出るのを防ぐ）
 * 3. ファイルどうしの参照と、6.10 のエラー・警告
 */
import { isAbsolute } from "node:path";
import type { ConfigIssue } from "../config-issue.ts";
import { effectivePermissions, type PermissionItem } from "../permission.ts";
import {
  createServiceCatalog,
  overrideServices,
  parseServiceDefinition,
  type ServiceCatalog,
  type ServiceDefinition,
  validateServiceCatalog,
} from "../service.ts";
import type { AicoopConfig, CompanyConfig } from "./company.ts";
import { checkCronSchedule } from "./cron.ts";
import { makeIssue } from "./messages.ts";
import { expandHome, isSamePath } from "./paths.ts";
import {
  CONFIG_FILE_NAMES,
  type ConfigFileContents,
  type ConfigFileName,
  type GroupConfig,
  type MemberConfig,
  parseConfigFile,
  REQUIRED_CONFIG_FILES,
  type RoleConfig,
} from "./schema.ts";
import { GITHUB_TEMPLATE_VARIABLES, parseTemplate, templateVariablesFor } from "./template.ts";

/** サービス定義のファイル1つ（YAML を読んだもの） */
export interface ServiceSource {
  /** 問題を知らせるときのファイル名（オーナーのものは `services/<file>`、組み込みは絶対パス） */
  readonly source: string;
  readonly builtin: boolean;
  readonly content: unknown;
}

export interface ConfigInput {
  /** 設定の置き場所（絶対パス） */
  readonly home: string;
  /** `~` を展開するときのホームディレクトリ（絶対パス） */
  readonly userHome: string;
  /** home の下の YAML を読んだもの（ファイル名 → 中身）。無いファイルは入れない */
  readonly files: Readonly<Record<string, unknown>>;
  /** サービス定義（組み込みを先に、オーナーのものを後に） */
  readonly services: readonly ServiceSource[];
  /** `prompts/` の下の md（`prompts/` からの相対パス、`/` 区切り → 中身） */
  readonly prompts: ReadonlyMap<string, string>;
  /** `skills/` の下のフォルダ名 */
  readonly skills: ReadonlySet<string>;
  /** `secrets.json` の権限（下位9ビット）。ファイルが無ければ null。確かめないなら undefined（Windows） */
  readonly secretsMode?: number | null;
  /** 読んだファイルごとの SHA-256（CompanyConfig にそのまま入れる） */
  readonly fileHashes?: Readonly<Record<string, string>>;
  /** cron 式が一度でも起きるかを調べる基準の時刻（既定は今） */
  readonly now?: Date;
}

export type ConfigResult =
  | {
      readonly ok: true;
      readonly config: CompanyConfig;
      readonly warnings: readonly ConfigIssue[];
    }
  | {
      readonly ok: false;
      /** エラーと警告（エラーが1つ以上ある） */
      readonly issues: readonly ConfigIssue[];
    };

/** 特別な意味を持つ部署・役職の ID（5.1.1、5.11、6.10） */
const EXECUTIVES = "executives";
const CEO = "ceo";
const MANAGER = "manager";
/** 書いていないときの humans.intake_member（6.2） */
const DEFAULT_HUMANS_INTAKE = "ceo";

const list = (items: Iterable<string>) => {
  const all = [...items];
  return all.length === 0 ? "なし" : all.join("、");
};

export function validateConfig(input: ConfigInput): ConfigResult {
  const issues: ConfigIssue[] = [];

  // ---- 1. ファイルごとのスキーマ ----
  const parsed: Partial<{ [K in ConfigFileName]: ConfigFileContents[K] }> = {};
  for (const name of CONFIG_FILE_NAMES) {
    const present = Object.hasOwn(input.files, name);
    if (!present && REQUIRED_CONFIG_FILES.includes(name)) {
      issues.push(
        makeIssue(
          "E-013",
          name,
          "",
          `${name} がありません。aicoop init で雛形を作るか、${input.home} に置いてください`,
        ),
      );
      continue;
    }
    const result = parseConfigFile(name, present ? input.files[name] : {});
    if (result.ok) (parsed as Record<string, unknown>)[name] = result.value;
    else issues.push(...result.issues);
  }

  const services = readServices(input.services, issues);
  if (issues.length > 0 || services === undefined) return { ok: false, issues };

  const files = parsed as { [K in ConfigFileName]: ConfigFileContents[K] };

  // ---- 3. ファイルどうしの参照と、6.10 のエラー・警告 ----
  const checker = new Checker(input, files, services);
  checker.run();
  issues.push(...checker.issues);

  if (issues.some((i) => i.code.startsWith("E-"))) return { ok: false, issues };

  const aicoopFile = files["aicoop.yaml"];
  const aicoop: AicoopConfig = {
    ...aicoopFile,
    daemon: { ...aicoopFile.daemon, home: input.home },
    humans: {
      ...aicoopFile.humans,
      intake_member: aicoopFile.humans.intake_member ?? DEFAULT_HUMANS_INTAKE,
    },
  };

  return {
    ok: true,
    warnings: issues,
    config: {
      home: input.home,
      aicoop,
      groups: files["groups.yaml"].groups,
      roles: files["roles.yaml"].roles,
      members: files["members.yaml"].members,
      triggers: files["triggers.yaml"].triggers,
      mcpServers: files["mcp_servers.yaml"].servers,
      hostTools: files["host_tools.yaml"].tools,
      services: services.definitions,
      catalog: services.catalog,
      prompts: input.prompts,
      fileHashes: input.fileHashes ?? {},
    },
  };
}

interface Services {
  readonly definitions: readonly ServiceDefinition[];
  readonly byId: ReadonlyMap<string, ServiceDefinition>;
  readonly catalog: ServiceCatalog;
}

/** サービス定義を読み、組み込みにオーナーのものを重ねる（5.2.3 の1）。E-010・E-011 もここで見る */
function readServices(sources: readonly ServiceSource[], out: ConfigIssue[]): Services | undefined {
  const issues: ConfigIssue[] = [];
  const services = readServicesInto(sources, issues);
  out.push(...issues);
  return issues.length > 0 ? undefined : services;
}

function readServicesInto(
  sources: readonly ServiceSource[],
  issues: ConfigIssue[],
): Services | undefined {
  const builtins: ServiceDefinition[] = [];
  const owners: ServiceDefinition[] = [];
  const sourceOf = new Map<string, string>();
  const ownerSourceOf = new Map<string, string>();
  let failed = false;

  for (const s of sources) {
    const result = parseServiceDefinition(s.content ?? {}, s.source);
    if (!result.ok) {
      issues.push(...result.issues);
      failed = true;
      continue;
    }
    const def = result.value;
    const seen = s.builtin ? undefined : ownerSourceOf.get(def.id);
    if (seen !== undefined) {
      issues.push(
        makeIssue(
          "E-013",
          s.source,
          "id",
          `サービス「${def.id}」は ${seen} にもあります。どちらが効くか決まらないので、1つのファイルにまとめてください`,
        ),
      );
      failed = true;
      continue;
    }
    if (s.builtin) builtins.push(def);
    else {
      owners.push(def);
      ownerSourceOf.set(def.id, s.source);
    }
    if (!s.builtin || !sourceOf.has(def.id)) sourceOf.set(def.id, s.source);
  }
  if (failed) return undefined;

  const definitions = overrideServices(builtins, owners);
  for (const issue of validateServiceCatalog(definitions)) {
    const id = issue.path?.split(".")[0] ?? "";
    issues.push(makeIssue(issue.code, sourceOf.get(id), "hosts", issue.message));
  }
  if (issues.length > 0) return undefined;

  return {
    definitions,
    byId: new Map(definitions.map((d) => [d.id, d])),
    catalog: createServiceCatalog(definitions),
  };
}

type Files = { [K in ConfigFileName]: ConfigFileContents[K] };

/** ファイルどうしの検証。見つけた問題を issues にためる */
class Checker {
  readonly issues: ConfigIssue[] = [];
  private readonly groups: Readonly<Record<string, GroupConfig>>;
  private readonly roles: Readonly<Record<string, RoleConfig>>;
  private readonly members: Readonly<Record<string, MemberConfig>>;
  private readonly input: ConfigInput;
  private readonly files: Files;
  private readonly services: Services;

  constructor(input: ConfigInput, files: Files, services: Services) {
    this.input = input;
    this.files = files;
    this.services = services;
    this.groups = files["groups.yaml"].groups;
    this.roles = files["roles.yaml"].roles;
    this.members = files["members.yaml"].members;
  }

  run(): void {
    this.checkAicoop();
    this.checkSecrets();
    this.checkGroups();
    this.checkRoles();
    this.checkMembers();
    this.checkPrompts();
    this.checkTriggers();
    this.checkCeilingCoverage();
    this.checkExfiltration();
    this.checkRequestCycles();
  }

  private error(code: `E-${string}`, source: string | undefined, path: string, detail: string) {
    this.issues.push(makeIssue(code, source, path, detail));
  }

  private warn(code: `W-${string}`, source: string | undefined, path: string, detail: string) {
    this.issues.push(makeIssue(code, source, path, detail));
  }

  private groupLabel(id: string): string {
    const g = this.groups[id];
    return g ? `${id}（${g.name}）` : id;
  }

  private aiMembers(): [string, Extract<MemberConfig, { kind: "ai" }>][] {
    return Object.entries(this.members).filter(
      (e): e is [string, Extract<MemberConfig, { kind: "ai" }>] => e[1].kind === "ai",
    );
  }

  private membersOf(groupId: string): string[] {
    return this.aiMembers()
      .filter(([, m]) => m.group === groupId)
      .map(([id]) => id);
  }

  // ---- aicoop.yaml ----

  private checkAicoop(): void {
    const src = "aicoop.yaml";
    const a = this.files[src];

    if (a.daemon.home !== undefined) {
      const written = expandHome(a.daemon.home, this.input.userHome);
      if (!isAbsolute(written)) {
        this.error(
          "E-013",
          src,
          "daemon.home",
          `絶対パスか、~/ で始まるパスを書いてください（いまの値："${a.daemon.home}"）`,
        );
      } else if (!isSamePath(written, this.input.home)) {
        this.error(
          "E-013",
          src,
          "daemon.home",
          `"${a.daemon.home}" は、いま読んでいる設定の置き場所（${this.input.home}）と違います。置き場所に合わせて直すか、書かないでください`,
        );
      }
    }

    if (a.task.timeout_minutes > 55) {
      this.error("E-006", src, "task.timeout_minutes", timeoutMessage(a.task.timeout_minutes));
    }

    a.anthropic_passthrough_hosts.forEach((host, i) => {
      if (!this.services.catalog.explicitHosts.has(host)) return;
      const owner = this.services.definitions.find((d) => d.hosts.includes(host));
      this.error(
        "E-013",
        src,
        `anthropic_passthrough_hosts.${i}`,
        `${host} はサービス ${owner?.id ?? "?"} の宛先です。素通しにすると、ルールの判定を通らずに外へ出てしまいます。anthropic_passthrough_hosts から消してください`,
      );
    });

    // 人宛ての依頼（P6）の受け手。書いていなければ、人間の社員がいるときだけ確かめる
    const written = a.humans.intake_member;
    const hasHumans = Object.values(this.members).some((m) => m.kind === "human");
    if (written !== undefined || hasHumans) {
      const id = written ?? DEFAULT_HUMANS_INTAKE;
      const m = this.members[id];
      if (m === undefined || m.kind !== "ai") {
        this.error(
          "E-001",
          src,
          "humans.intake_member",
          `人宛ての依頼を受ける社員「${id}」が、AI の社員として members.yaml にいません${written === undefined ? "（書いていないときは ceo）" : ""}。いる AI の社員に直してください`,
        );
      }
    }
  }

  private checkSecrets(): void {
    const mode = this.input.secretsMode;
    if (mode === undefined || mode === null) return;
    if ((mode & 0o777) !== 0o600) {
      const shown = (mode & 0o777).toString(8).padStart(4, "0");
      this.error(
        "E-008",
        "secrets.json",
        "",
        `権限が ${shown} です。本物の資格が入っているので、自分だけが読み書きできる 0600 にしてください（例：chmod 600 ${this.input.home}/secrets.json）`,
      );
    }
  }

  // ---- groups.yaml ----

  private checkGroups(): void {
    const src = "groups.yaml";
    for (const [id, g] of Object.entries(this.groups)) {
      const at = `groups.${id}`;

      if (g.box === "none" && id !== CEO) {
        this.error(
          "E-002",
          src,
          `${at}.box`,
          "box: none（箱なし）を使えるのは、CEO の部署 ceo だけです。vm か srt にしてください",
        );
      }
      if (id === CEO && g.box !== "none") {
        this.error(
          "E-002",
          src,
          `${at}.box`,
          "部署 ceo は CEO がホストで動く部署なので、box: none にしてください（5.11）",
        );
      }
      if (id === EXECUTIVES && g.box !== "vm") {
        this.error(
          "E-012",
          src,
          `${at}.box`,
          "役員室（executives）は、部長を部員の乗っ取りから守るため box: vm にしてください（5.1.1）",
        );
      }
      if ((id === CEO || id === EXECUTIVES) && g.ceiling.length > 0) {
        this.error(
          "E-014",
          src,
          `${at}.ceiling`,
          `部署 ${id} の社員はサービスを直接使わないので、ceiling は空（[]）にしてください`,
        );
      }
      if (g.box === "srt" && g.ceiling.length > 0) {
        this.error(
          "E-003",
          src,
          `${at}.ceiling`,
          "box: srt の箱の通信は資格プロキシを通らないので、一時権限で操作が足されてもルールで守れません。ceiling を空（[]）にするか、box: vm にしてください",
        );
      }

      if (g.intake_member !== undefined) {
        const m = this.members[g.intake_member];
        if (m === undefined) {
          this.error(
            "E-001",
            src,
            `${at}.intake_member`,
            `社員「${g.intake_member}」は members.yaml にいません。部署 ${id} の社員（${list(this.membersOf(id))}）から選んでください`,
          );
        } else if (m.kind !== "ai" || m.group !== id) {
          const where = m.kind === "ai" ? `部署 ${m.group} にいます` : "人間の社員です";
          this.error(
            "E-009",
            src,
            `${at}.intake_member`,
            `社員「${g.intake_member}」は部署 ${id} の社員ではありません（${where}）。部署 ${id} の社員（${list(this.membersOf(id))}）から選んでください`,
          );
        }
      }

      g.can_request.forEach((target, i) => {
        if (this.groups[target] === undefined) {
          this.error(
            "E-001",
            src,
            `${at}.can_request.${i}`,
            `部署「${target}」は groups.yaml にありません。ある部署（${list(Object.keys(this.groups))}）に直してください`,
          );
        }
      });

      g.ceiling.forEach((item, i) => {
        this.checkPermissionItem(src, `${at}.ceiling.${i}`, item);
      });
    }
  }

  /** 許可項目（ceiling・allow 共通）：op・params の参照（E-001）と、push の hold（E-005） */
  private checkPermissionItem(src: string, at: string, item: PermissionItem): void {
    const [serviceId = "", ...rest] = item.op.split(".");
    const operation = rest.join(".");
    const service = this.services.byId.get(serviceId);
    if (service === undefined) {
      this.error(
        "E-001",
        src,
        `${at}.op`,
        `サービス「${serviceId}」の定義がありません。使えるサービスは ${list(this.services.byId.keys())} です。足すなら services/${serviceId}.yaml に定義を書いてください`,
      );
      return;
    }
    const definition = Object.hasOwn(service.operations, operation)
      ? service.operations[operation]
      : undefined;
    if (definition === undefined) {
      const ops = Object.keys(service.operations).map((o) => `${serviceId}.${o}`);
      this.error(
        "E-001",
        src,
        `${at}.op`,
        `サービス ${serviceId} に操作「${operation}」はありません（ある操作：${list(ops)}）。打ち間違いでないか確かめてください`,
      );
      return;
    }

    const usable = new Set(
      definition.match.flatMap((m) =>
        [...m.path.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((x) => x[1] ?? ""),
      ),
    );
    for (const name of Object.keys(item.params ?? {})) {
      if (usable.has(name)) continue;
      this.error(
        "E-001",
        src,
        `${at}.params.${name}`,
        `パラメーター「${name}」は ${item.op} のパスにありません（${usable.size === 0 ? "この操作にはパラメーターがありません" : `使えるのは ${list(usable)}`}）。このままでは一致しないので、許可が効きません`,
      );
    }

    if (item.op === "github.git.push" && item.mode === "hold") {
      this.error(
        "E-005",
        src,
        `${at}.mode`,
        "github.git.push には mode: hold を付けられません（push はあとから送り直すと失敗しやすいため。5.2.6）。mode を消し、main への取り込み（github.pr.merge）を hold にしてください",
      );
    }
  }

  // ---- roles.yaml ----

  private checkRoles(): void {
    const src = "roles.yaml";
    const mcp = this.files["mcp_servers.yaml"].servers;
    const comfyui = this.files["host_tools.yaml"].tools.comfyui;

    for (const [id, role] of Object.entries(this.roles)) {
      const at = `roles.${id}`;
      role.allow.forEach((item, i) => {
        this.checkPermissionItem(src, `${at}.allow.${i}`, item);
      });

      role.tools.forEach((tool, i) => {
        if (tool === "generate_image") {
          if (comfyui === undefined) {
            this.error(
              "E-001",
              src,
              `${at}.tools.${i}`,
              "generate_image は ComfyUI を使いますが、host_tools.yaml に comfyui が登録されていません。先に host_tools.yaml に comfyui を書いてください（5.12）",
            );
          }
          return;
        }
        const upstream = tool.slice(0, tool.indexOf("."));
        if (mcp[upstream] === undefined) {
          this.error(
            "E-001",
            src,
            `${at}.tools.${i}`,
            `上流MCP「${upstream}」は mcp_servers.yaml にありません。mcp_servers.yaml の servers に足すか、tools から消してください`,
          );
        }
      });

      role.skills.forEach((skill, i) => {
        if (!this.input.skills.has(skill)) {
          this.error(
            "E-001",
            src,
            `${at}.skills.${i}`,
            `スキルのフォルダ skills/${skill}/ がありません。作るか、skills から消してください`,
          );
        }
      });
    }
  }

  // ---- members.yaml ----

  private checkMembers(): void {
    const src = "members.yaml";
    const managedBy = new Map<string, string>();
    const ceos: string[] = [];
    let hasManager = false;

    for (const [id, m] of this.aiMembers()) {
      const at = `members.${id}`;
      const group = this.groups[m.group];
      const role = this.roles[m.role];

      if (group === undefined) {
        this.error(
          "E-001",
          src,
          `${at}.group`,
          `部署「${m.group}」は groups.yaml にありません。groups.yaml に足すか、ある部署（${list(Object.keys(this.groups))}）に直してください`,
        );
      }
      if (role === undefined) {
        this.error(
          "E-001",
          src,
          `${at}.role`,
          `役職「${m.role}」は roles.yaml にありません。roles.yaml に足すか、ある役職（${list(Object.keys(this.roles))}）に直してください`,
        );
      }

      // E-002：CEO と box: none
      if (m.role === CEO) {
        ceos.push(id);
        if (group !== undefined && group.box !== "none") {
          this.error(
            "E-002",
            src,
            `${at}.group`,
            `CEO（役職 ceo）は box: none の部署 ceo に置いてください（いまは box: ${group.box} の部署 ${m.group}）`,
          );
        }
      } else if (group?.box === "none") {
        this.error(
          "E-002",
          src,
          `${at}.group`,
          `box: none（箱なし）の部署 ${m.group} で動けるのは CEO だけです。役職 ${m.role} の社員は、箱のある部署に移してください`,
        );
      }

      // E-003：srt の部署の社員は、サービスの操作を1つも許可されない
      if (group?.box === "srt" && role !== undefined && role.allow.length > 0) {
        this.error(
          "E-003",
          src,
          `${at}.role`,
          `box: srt の部署 ${m.group} の社員なのに、役職 ${m.role} がサービスの操作を許可しています（${role.allow.map((a) => a.op).join("、")}）。srt の箱の通信は資格プロキシを通らないので、ルールで守れません。役職の allow を空にするか、部署を box: vm にしてください`,
        );
      }

      // E-004：部長
      if (m.role === MANAGER) {
        hasManager = true;
        if (m.group !== EXECUTIVES) {
          this.error(
            "E-004",
            src,
            `${at}.group`,
            `部長（役職 manager）は、部員の箱ではなく役員室で動くので、group: executives にしてください（5.1.1）`,
          );
        }
        if (m.manages === undefined) {
          this.error("E-004", src, at, "部長には、担当する部署を manages で書いてください");
        } else if (m.manages === EXECUTIVES || m.manages === CEO) {
          this.error(
            "E-004",
            src,
            `${at}.manages`,
            `manages に ${m.manages} は書けません。部員のいる部署を担当にしてください`,
          );
        } else if (this.groups[m.manages] === undefined) {
          this.error(
            "E-001",
            src,
            `${at}.manages`,
            `部署「${m.manages}」は groups.yaml にありません。ある部署（${list(Object.keys(this.groups))}）に直してください`,
          );
        } else {
          const other = managedBy.get(m.manages);
          if (other !== undefined) {
            this.error(
              "E-004",
              src,
              `${at}.manages`,
              `部署 ${m.manages} は ${other} も担当しています。1つの部署の部長は1人だけにしてください`,
            );
          } else {
            managedBy.set(m.manages, id);
          }
        }
      } else if (m.manages !== undefined) {
        this.error(
          "E-013",
          src,
          `${at}.manages`,
          "manages を書けるのは、部長（役職 manager）の社員だけです。消してください",
        );
      }
    }

    if (ceos.length > 1) {
      this.error(
        "E-002",
        src,
        `members.${ceos[1]}.role`,
        `CEO（役職 ceo）の社員が${ceos.length}人います（${ceos.join("、")}）。CEO は1人だけにしてください`,
      );
    }
    if (hasManager && this.groups[EXECUTIVES] === undefined) {
      this.error(
        "E-012",
        "groups.yaml",
        "groups",
        "部長（役職 manager）の社員がいるのに、役員室の部署 executives がありません。groups.yaml に executives（box: vm、ceiling: []）を足してください",
      );
    }
  }

  // ---- prompts/（5.4.3） ----

  private checkPrompts(): void {
    const prompts = this.input.prompts;
    if (!prompts.has("company.md")) {
      this.error(
        "E-001",
        "prompts/company.md",
        "",
        "会社の方針のファイル prompts/company.md がありません。作ってください（すべての社員のプロンプトの最初に入ります。5.4.3）",
      );
    }

    for (const [id, role] of Object.entries(this.roles)) {
      if (role.prompt !== undefined) {
        if (!prompts.has(role.prompt)) {
          this.error(
            "E-001",
            "roles.yaml",
            `roles.${id}.prompt`,
            `prompts/${role.prompt} がありません。作るか、prompt を直してください`,
          );
        }
        continue;
      }
      const users = this.aiMembers()
        .filter(([, m]) => m.role === id)
        .map(([mid]) => mid);
      const path = `roles/${id}.md`;
      if (users.length > 0 && !prompts.has(path)) {
        this.error(
          "E-001",
          "roles.yaml",
          `roles.${id}`,
          `役職 ${id} のやり方を書いた prompts/${path} がありません（${users.join("、")} が使っています）。作るか、役職の prompt に別のファイルを書いてください`,
        );
      }
    }

    for (const [id, m] of this.aiMembers()) {
      if (m.prompt !== undefined && !prompts.has(m.prompt)) {
        this.error(
          "E-001",
          "members.yaml",
          `members.${id}.prompt`,
          `prompts/${m.prompt} がありません。作るか、prompt を直してください`,
        );
      }
    }
  }

  // ---- triggers.yaml ----

  private checkTriggers(): void {
    const src = "triggers.yaml";
    const timezone = this.files["aicoop.yaml"].timezone;
    const seen = new Map<string, number>();

    this.files[src].triggers.forEach((t, i) => {
      const at = `triggers.${i}`;

      const first = seen.get(t.id);
      if (first !== undefined) {
        this.error(
          "E-013",
          src,
          `${at}.id`,
          `トリガーの id「${t.id}」は triggers.${first} と同じです。別の id にしてください`,
        );
      } else {
        seen.set(t.id, i);
      }

      const m = this.members[t.member];
      if (m === undefined || m.kind !== "ai") {
        this.error(
          "E-001",
          src,
          `${at}.member`,
          `社員「${t.member}」は、AI の社員として members.yaml にいません。仕事をする AI の社員を書いてください`,
        );
      }

      if (t.timeout_minutes !== undefined && t.timeout_minutes > 55) {
        this.error("E-006", src, `${at}.timeout_minutes`, timeoutMessage(t.timeout_minutes));
      }

      if (t.type === "cron") {
        const reason = checkCronSchedule(t.schedule, timezone, this.input.now ?? new Date());
        if (reason !== undefined) {
          this.error(
            "E-007",
            src,
            `${at}.schedule`,
            `cron式「${t.schedule}」を読めません（${reason}）。「分 時 日 月 曜日」の5項目で書いてください（例："0 8 * * 1-5" は平日の8時）`,
          );
        }
      }

      if (t.type === "on_hold_resolved") return;
      const allowed =
        t.type === "github" ? templateVariablesFor(t.events) : new Map<string, never>();
      const fields: [string, string | undefined][] = [
        ["thread", t.thread],
        ["task.purpose", t.task.purpose],
        ["task.context", t.task.context],
        ["task.done_when", t.task.done_when],
      ];
      for (const [field, text] of fields) {
        if (text === undefined) continue;
        this.checkTemplate(src, `${at}.${field}`, text, t, allowed, field === "thread");
      }
    });
  }

  private checkTemplate(
    src: string,
    at: string,
    text: string,
    trigger: Files["triggers.yaml"]["triggers"][number],
    allowed: ReadonlyMap<string, { readonly external: boolean }>,
    isThread: boolean,
  ): void {
    const { names, malformed } = parseTemplate(text);
    if (malformed) {
      this.error(
        "E-013",
        src,
        at,
        "テンプレートの {{ と }} が組になっていません。{{issue.number}} のように書いてください",
      );
    }
    if (trigger.type !== "github") {
      if (names.length > 0) {
        this.error(
          "E-013",
          src,
          at,
          `テンプレート変数（{{${names[0]}}}）を使えるのは github トリガーだけです。${trigger.type} トリガーでは、そのままの文字を書いてください`,
        );
      }
      return;
    }
    for (const name of names) {
      const variable = allowed.get(name);
      if (variable === undefined) {
        const lacking = trigger.events.filter((e) => !templateVariablesFor([e]).has(name));
        const existsSomewhere = Object.values(GITHUB_TEMPLATE_VARIABLES).some((vars) =>
          vars.some((v) => v.name === name),
        );
        const detail = existsSomewhere
          ? `変数「${name}」は ${lacking.join("、")} のイベントでは使えません`
          : `変数「${name}」はありません`;
        this.error(
          "E-013",
          src,
          at,
          `${detail}。使えるのは ${list(allowed.keys())} です（6.6 の表）`,
        );
      } else if (isThread && variable.external) {
        this.error(
          "E-013",
          src,
          at,
          `変数「${name}」は外の人が書いた文章なので、スレッド名には使えません（スレッドを外から選ばせないため）。番号などを使ってください`,
        );
      }
    }
  }

  // ---- 警告 ----

  /** W-001：役職の allow に、所属部署の ceiling にない操作がある（その操作は効かない） */
  private checkCeilingCoverage(): void {
    const reported = new Set<string>();
    for (const [memberId, m] of this.aiMembers()) {
      const role = this.roles[m.role];
      const groupId = m.role === MANAGER ? EXECUTIVES : m.group;
      const group = this.groups[groupId];
      if (role === undefined || group === undefined) continue;
      const ceilingOps = new Set(group.ceiling.map((c) => c.op));
      role.allow.forEach((a, i) => {
        if (ceilingOps.has(a.op)) return;
        const key = `${m.role}\u0000${groupId}\u0000${i}`;
        if (reported.has(key)) return;
        reported.add(key);
        this.warn(
          "W-001",
          "roles.yaml",
          `roles.${m.role}.allow.${i}.op`,
          `${a.op} は、部署 ${this.groupLabel(groupId)}の ceiling にないので、社員 ${memberId} には効きません。部署の ceiling に足すか、役職の allow から消してください`,
        );
      });
    }
  }

  /**
   * W-002：持ち出しの危険。ある役職の有効な許可に sends_external の操作が mode: allow で入っていて、
   * 同じ部署のだれかの有効な許可に reads_internal の操作がある。
   */
  private checkExfiltration(): void {
    const catalog = this.services.catalog;
    const tagsOf = (op: string) => catalog.getOperation(op)?.tags ?? [];

    for (const groupId of Object.keys(this.groups)) {
      const group = this.groups[groupId] as GroupConfig;
      const perMember = this.membersOf(groupId).map((memberId) => {
        const m = this.members[memberId] as Extract<MemberConfig, { kind: "ai" }>;
        const role = this.roles[m.role];
        const effective = role
          ? effectivePermissions({ allow: role.allow, ceiling: group.ceiling, now: new Date(0) })
          : [];
        return { memberId, role: m.role, effective };
      });

      const readers = perMember.flatMap(({ memberId, effective }) =>
        effective
          .filter((p) => tagsOf(p.op).includes("reads_internal"))
          .map((p) => `${memberId} の ${p.op}`),
      );
      if (readers.length === 0) continue;

      const byRole = new Map<string, { members: string[]; ops: Set<string> }>();
      for (const { memberId, role, effective } of perMember) {
        const sends = effective
          .filter((p) => p.mode === "allow" && tagsOf(p.op).includes("sends_external"))
          .map((p) => p.op);
        if (sends.length === 0) continue;
        const entry = byRole.get(role) ?? { members: [], ops: new Set<string>() };
        entry.members.push(memberId);
        for (const op of sends) entry.ops.add(op);
        byRole.set(role, entry);
      }

      for (const [role, { members, ops }] of byRole) {
        this.warn(
          "W-002",
          "groups.yaml",
          `groups.${groupId}`,
          `持ち出しの危険：部署 ${this.groupLabel(groupId)}で、役職 ${role}（${members.join("、")}）が外へ送れる操作（${[...ops].join("、")}）を mode: allow で持ち、同じ部署で社内のデータを読む操作（${[...new Set(readers)].join("、")}）が使えます。作業フォルダの社内データを外へ送れてしまいます。送る操作を mode: hold にするか、読む社員と送る社員を別の部署に分けてください`,
        );
      }
    }
  }

  /** W-003：can_request の循環（強連結成分ごとに1つ） */
  private checkRequestCycles(): void {
    const ids = Object.keys(this.groups);
    const edges = new Map(
      ids.map((id) => [
        id,
        (this.groups[id]?.can_request ?? []).filter((t) => this.groups[t] !== undefined),
      ]),
    );

    for (const component of stronglyConnected(ids, edges)) {
      const start = component[0] as string;
      const inside = new Set(component);
      const selfLoop = edges.get(start)?.includes(start) ?? false;
      if (component.length === 1 && !selfLoop) continue;
      const cycle =
        selfLoop && component.length === 1 ? [start, start] : findCycle(start, edges, inside);
      this.warn(
        "W-003",
        "groups.yaml",
        `groups.${start}.can_request`,
        `依頼票の can_request が循環しています（${cycle.join(" → ")}）。依頼が行き来して利用枠を使い切るおそれがあるので、一方向にしてください`,
      );
    }
  }
}

function timeoutMessage(minutes: number): string {
  return `1回の実行は最長55分です（実行の開始時に発行するトークンの有効期限が1時間のため。5.5.5）。55以下にしてください（いまの値：${minutes}）`;
}

/** Tarjan の方法で強連結成分を求める（成分の中は、もとの並び順） */
function stronglyConnected(
  ids: readonly string[],
  edges: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  const visit = (v: string) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v) as number, low.get(w) as number));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) as number, index.get(w) as number));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop() as string;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      const order = new Map(ids.map((id, i) => [id, i]));
      result.push(component.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)));
    }
  };

  for (const id of ids) if (!index.has(id)) visit(id);
  const order = new Map(ids.map((id, i) => [id, i]));
  return result.sort((a, b) => (order.get(a[0] ?? "") ?? 0) - (order.get(b[0] ?? "") ?? 0));
}

/** 成分の中で、start から start に戻る道（幅優先なので一番短いもの） */
function findCycle(
  start: string,
  edges: ReadonlyMap<string, readonly string[]>,
  inside: ReadonlySet<string>,
): string[] {
  const previous = new Map<string, string>();
  const queue = [start];
  while (queue.length > 0) {
    const v = queue.shift() as string;
    for (const w of edges.get(v) ?? []) {
      if (!inside.has(w)) continue;
      if (w === start) {
        const nodes: string[] = [];
        for (let x: string | undefined = v; x !== undefined && x !== start; x = previous.get(x)) {
          nodes.unshift(x);
        }
        return [start, ...nodes, start];
      }
      if (!previous.has(w)) {
        previous.set(w, v);
        queue.push(w);
      }
    }
  }
  return [start, start];
}
