/**
 * 設定ファイルのスキーマ（6.2〜6.6、6.8、6.9）。
 *
 * - 打ち間違いのキーを黙って無視しないよう、すべて `z.strictObject` で書く。
 * - 書いていないキーには、設計書の表の既定値を入れる。範囲を外れた値は E-013。
 * - 読んだあとの型は、YAML のキー名（snake_case）のままにする。
 * - ファイルどうしの参照（存在しない部署など）は、ここでは見ない（`validate.ts`）。
 */
import { z } from "zod";
import type { BoxKind } from "../box.ts";
import type { ParseResult } from "../config-issue.ts";
import { permissionItemSchema } from "../permission.ts";
import { configErrorMap, zodIssuesToConfigIssues } from "./messages.ts";

// ---- ID と共通の値 ----

/**
 * 社員ID・部署ID・役職ID（6.5）：英小文字・数字・ハイフンで1〜40文字。
 * 先頭のハイフンは許さない（`aicoop run -x` のように、コマンドのオプションと取り違えるため）。
 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const idSchema = (what: string) =>
  z
    .string()
    .regex(
      ID_PATTERN,
      `${what}は英小文字・数字・ハイフンで、1〜40文字にしてください（先頭にハイフンは使えません）`,
    );

export const groupIdSchema = idSchema("部署ID");
export const roleIdSchema = idSchema("役職ID");
export const memberIdSchema = idSchema("社員ID");
const triggerIdSchema = idSchema("トリガーのID");
const mcpServerIdSchema = idSchema("上流MCPのID");
const secretIdSchema = idSchema("資格のID");

/** 会社のID（7.1）：`c_` + ULID */
export const COMPANY_ID_PATTERN = /^c_[0-9A-HJKMNP-TV-Z]{26}$/;
const companyIdSchema = z
  .string()
  .regex(
    COMPANY_ID_PATTERN,
    "会社のIDは c_ と ULID（26文字）です。aicoop init が作った値のままにしてください",
  );

const displayNameSchema = z.string().trim().min(1);

/** 範囲つきの整数。書いていなければ既定値 */
const intIn = (min: number, max: number, fallback: number) =>
  z.number().int().min(min).max(max).default(fallback);

/**
 * ID をキーにした表を、プロトタイプを持たないオブジェクトにする。
 * `constructor` は ID として正しい形なので、ふつうのオブジェクトのままだと、
 * 書いていない部署 `constructor` を引いたときに Object の組み込みが返り、「ある」と取り違える。
 */
function withoutPrototype<T>(record: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, record);
}

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const hostnameSchema = z
  .string()
  .regex(
    HOSTNAME,
    "ホスト名だけを書いてください（例：api.anthropic.com。* や https:// は書けません）",
  )
  .transform((h) => h.toLowerCase());

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** URL の形と、使ってよい scheme。`loopbackHttp` なら http はループバックの宛先だけ */
const urlSchema = (opts: { readonly https: boolean; readonly http: "any" | "loopback" | "none" }) =>
  z.string().refine(
    (value) => {
      const url = parseUrl(value);
      if (url === undefined || url.username !== "" || url.password !== "") return false;
      if (url.protocol === "https:") return opts.https;
      if (url.protocol === "http:") {
        return (
          opts.http === "any" || (opts.http === "loopback" && LOOPBACK_HOSTS.has(url.hostname))
        );
      }
      return false;
    },
    {
      error: () =>
        opts.http === "none"
          ? "https:// で始まる URL を書いてください"
          : opts.http === "loopback" && opts.https
            ? "https:// の URL か、http://127.0.0.1 などループバックの URL を書いてください"
            : opts.http === "loopback"
              ? "http://127.0.0.1:<ポート>/... の形の URL を書いてください（ホストの外には出しません）"
              : "http:// か https:// で始まる URL を書いてください",
    },
  );

const emptyOr = (schema: z.ZodType<string>) => z.union([z.literal(""), schema]);

/**
 * IANA形式のタイムゾーン（`Area/Location` か `UTC`）。
 * `JST`・`Japan`・`+09:00`・小文字のような、実行環境が受け付けても IANA の正式な名前でないものは許さない。
 */
export function isIanaTimeZone(value: string): boolean {
  if (value !== "UTC" && !/^[A-Z][A-Za-z_+-]*(?:\/[A-Z0-9][A-Za-z0-9_+-]*){1,2}$/.test(value)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z
  .string()
  .refine(isIanaTimeZone, "IANA形式のタイムゾーンを書いてください（例：Asia/Tokyo、UTC）");

/**
 * `prompts/` からの相対パスの md（6.4 の `prompt`、6.5 の `prompt`）。
 * `prompts/` の外を指せないように、`..`・絶対パス・`\`・ドライブ名・`~` を許さない。
 */
export function isPromptPath(value: string): boolean {
  if (!value.endsWith(".md")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くため
  if (/[\\:*?"<>|\u0000-\u001f]/.test(value) || value.startsWith("~")) return false;
  const segments = value.split("/");
  return segments.every((s) => s !== "" && s !== "." && s !== "..");
}

const promptPathSchema = z
  .string()
  .refine(
    isPromptPath,
    "prompts/ からの相対パスで、.md のファイルを書いてください（例：roles/implementer.md。.. や / で始まるパスは使えません）",
  );

// ---- 6.2 aicoop.yaml ----

export const aicoopFileSchema = z.strictObject({
  company: z.strictObject({
    id: companyIdSchema,
    name: displayNameSchema,
  }),
  timezone: timezoneSchema.default("Asia/Tokyo"),
  daemon: z
    .strictObject({
      /** 書いていなければ、実際に読んでいる置き場所（validate.ts で埋める） */
      home: z.string().min(1).optional(),
      port: intIn(1, 65535, 7070),
      max_concurrent_boxes: intIn(1, 16, 3),
    })
    .prefault({}),
  task: z
    .strictObject({
      // 55 を超えるものは E-006 にするので、ここでは下限だけを見る（validate.ts）
      timeout_minutes: z.number().int().min(1).default(45),
    })
    .prefault({}),
  anthropic_passthrough_hosts: z.array(hostnameSchema).min(1).default(["api.anthropic.com"]),
  holds: z.strictObject({ ttl_hours: intIn(1, 168, 72) }).prefault({}),
  grants: z.strictObject({ max_hours: intIn(1, 720, 168) }).prefault({}),
  tickets: z
    .strictObject({ max_depth: intIn(1, 5, 2), daily_limit: intIn(0, 1000, 20) })
    .prefault({}),
  sessions: z.strictObject({ max_idle_days: intIn(1, 365, 30) }).prefault({}),
  audit: z.strictObject({ retention_days: intIn(30, 3650, 365) }).prefault({}),
  relay: z
    .strictObject({ url: emptyOr(urlSchema({ https: true, http: "none" })).default("") })
    .prefault({}),
  humans: z
    .strictObject({
      daily_limit: intIn(0, 20, 3),
      /** 書いていなければ "ceo"（validate.ts で埋める） */
      intake_member: memberIdSchema.optional(),
    })
    .prefault({}),
  runtimes: z
    .strictObject({ local_llm: emptyOr(urlSchema({ https: true, http: "any" })).default("") })
    .prefault({}),
});
export type AicoopFile = z.output<typeof aicoopFileSchema>;

// ---- 6.3 groups.yaml ----

/** 箱の種類（5.1.2）。box.ts の BoxKind と同じ値 */
export const boxKindSchema = z.enum(["vm", "srt", "none"] as const satisfies readonly BoxKind[]);

/** `vm` のイメージに足す Alpine のパッケージ（`apk add` に渡るので、オプションや空白を許さない） */
const alpinePackageSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9+._-]*$/,
    "Alpine のパッケージ名を1つずつ書いてください（英小文字・数字・+ . _ -。例：nodejs）",
  );

export const groupSchema = z.strictObject({
  name: displayNameSchema,
  box: boxKindSchema,
  memory_mib: intIn(512, 16384, 2048),
  cpus: intIn(1, 8, 2),
  packages: z.array(alpinePackageSchema).default([]),
  intake_member: memberIdSchema.optional(),
  can_request: z.array(groupIdSchema).default([]),
  ceiling: z.array(permissionItemSchema).default([]),
});
export type GroupConfig = z.output<typeof groupSchema>;

export const groupsFileSchema = z.strictObject({
  groups: z.record(groupIdSchema, groupSchema).transform(withoutPrototype),
});

// ---- 6.4 roles.yaml ----

/** Claude Code の `--model` に渡す値。オプションに見える値（- で始まる）は許さない */
const modelSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/,
    "モデルの名前を書いてください（例：sonnet、opus、claude-sonnet-4-5）",
  );

/** `generate_image`、`<上流のID>.<道具名>`、`<上流のID>.*`（6.4） */
export const TOOL_PATTERN =
  /^(?:generate_image|[a-z0-9][a-z0-9-]{0,39}\.(?:\*|[A-Za-z0-9_.-]{1,128}))$/;
const toolSchema = z
  .string()
  .regex(
    TOOL_PATTERN,
    "tools に書けるのは generate_image、<上流のID>.<道具名>、<上流のID>.* だけです（report_result などの組み込み道具は自動で付きます）",
  );

/** スキルのフォルダ名（`~/.aicoop/skills/<name>/`） */
const skillSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,63}$/,
    "スキルは skills/ の下のフォルダ名を書いてください（英小文字・数字・ハイフン）",
  );

export const roleSchema = z.strictObject({
  name: displayNameSchema,
  model: modelSchema.default("sonnet"),
  max_turns: intIn(1, 500, 100),
  prompt: promptPathSchema.optional(),
  allow: z.array(permissionItemSchema).default([]),
  tools: z.array(toolSchema).default([]),
  skills: z.array(skillSchema).default([]),
  can_request_humans: z.boolean().default(false),
});
export type RoleConfig = z.output<typeof roleSchema>;

export const rolesFileSchema = z.strictObject({
  roles: z.record(roleIdSchema, roleSchema).transform(withoutPrototype),
});

// ---- 6.5 members.yaml ----

export const aiMemberSchema = z.strictObject({
  kind: z.literal("ai"),
  name: displayNameSchema,
  group: groupIdSchema,
  role: roleIdSchema,
  manages: groupIdSchema.optional(),
  prompt: promptPathSchema.optional(),
});
export type AiMemberConfig = z.output<typeof aiMemberSchema>;

export const humanMemberSchema = z.strictObject({
  kind: z.literal("human"),
  name: displayNameSchema,
  company_id: companyIdSchema,
  public_key: z.string().min(1),
});
export type HumanMemberConfig = z.output<typeof humanMemberSchema>;

export const memberSchema = z.preprocess(
  // kind の既定は ai（6.5）
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value) && !("kind" in value)
      ? { kind: "ai", ...value }
      : value,
  z.discriminatedUnion("kind", [aiMemberSchema, humanMemberSchema]),
);
export type MemberConfig = AiMemberConfig | HumanMemberConfig;

export const membersFileSchema = z.strictObject({
  members: z.record(memberIdSchema, memberSchema).transform(withoutPrototype),
});

// ---- 6.6 triggers.yaml ----

export const githubEventSchema = z.enum([
  "issues.opened",
  "issues.labeled",
  "issue_comment.created",
  "pull_request.opened",
  "pull_request.synchronize",
  "push",
]);
export type GithubEvent = z.infer<typeof githubEventSchema>;

export const replyAsSchema = z.enum(["file", "task"]);

const triggerTaskSchema = z.strictObject({
  purpose: z.string().trim().min(1),
  context: z.string().default(""),
  done_when: z.string().trim().min(1),
  reply_as: replyAsSchema.default("file"),
});

const triggerCommon = {
  id: triggerIdSchema,
  enabled: z.boolean().default(true),
  member: memberIdSchema,
  // 55 を超えるものは E-006 にするので、ここでは下限だけを見る（validate.ts）
  timeout_minutes: z.number().int().min(1).optional(),
};

const threadSchema = z.string().trim().min(1).max(200);

export const cronTriggerSchema = z.strictObject({
  ...triggerCommon,
  type: z.literal("cron"),
  /** 5項目のcron式（読めるかは validate.ts の E-007） */
  schedule: z.string(),
  thread: threadSchema.optional(),
  task: triggerTaskSchema,
});

export const githubTriggerSchema = z.strictObject({
  ...triggerCommon,
  type: z.literal("github"),
  events: z.array(githubEventSchema).min(1),
  filter: z
    .strictObject({
      repository: z
        .string()
        .regex(
          /^[^/\s]+\/[^/\s]+$/,
          "repository は owner/name の形で書いてください（例：myorg/app）",
        )
        .optional(),
      label: z.string().min(1).optional(),
      branch: z.string().min(1).optional(),
    })
    .optional(),
  thread: threadSchema.optional(),
  task: triggerTaskSchema,
});

/** 目的とスレッドは固定（6.6）なので、task・thread は書けない */
export const onHoldResolvedTriggerSchema = z.strictObject({
  ...triggerCommon,
  type: z.literal("on_hold_resolved"),
});

export const triggerSchema = z.discriminatedUnion("type", [
  cronTriggerSchema,
  githubTriggerSchema,
  onHoldResolvedTriggerSchema,
]);
export type TriggerConfig = z.output<typeof triggerSchema>;
export type CronTriggerConfig = z.output<typeof cronTriggerSchema>;
export type GithubTriggerConfig = z.output<typeof githubTriggerSchema>;
export type OnHoldResolvedTriggerConfig = z.output<typeof onHoldResolvedTriggerSchema>;

export const triggersFileSchema = z.strictObject({
  triggers: z.array(triggerSchema).default([]),
});

// ---- 6.8 mcp_servers.yaml [P3] ----

export const mcpServerSchema = z.strictObject({
  // 上流の資格を載せて送るので、ホストの外へは https だけ
  url: urlSchema({ https: true, http: "loopback" }),
  secret: secretIdSchema.nullable().default(null),
});
export type McpServerConfig = z.output<typeof mcpServerSchema>;

export const mcpServersFileSchema = z.strictObject({
  servers: z.record(mcpServerIdSchema, mcpServerSchema).transform(withoutPrototype).prefault({}),
});

// ---- 6.9 host_tools.yaml [P4] ----

export const comfyuiSchema = z.strictObject({
  start: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1),
  // ホストの中の道具なので、ループバックの宛先だけ
  health: urlSchema({ https: false, http: "loopback" }),
  stop: z.enum(["SIGTERM", "SIGINT", "SIGKILL"]).default("SIGTERM"),
  start_timeout_seconds: intIn(1, 600, 120),
  custom_nodes_dir: z.string().min(1),
  allowed_custom_nodes: z.array(z.string().min(1)).default([]),
  /** 書いていなければ `<home>/host_tools/comfyui/presets`（6.1） */
  presets_dir: z.string().min(1).optional(),
});
export type ComfyuiConfig = z.output<typeof comfyuiSchema>;

export const hostToolsFileSchema = z.strictObject({
  // 登録できるのは、v1 では comfyui だけ（6.9）
  tools: z.strictObject({ comfyui: comfyuiSchema.optional() }).prefault({}),
});
export type HostToolsConfig = z.output<typeof hostToolsFileSchema>["tools"];

// ---- ファイルごとの読み方 ----

export const CONFIG_FILE_SCHEMAS = {
  "aicoop.yaml": aicoopFileSchema,
  "groups.yaml": groupsFileSchema,
  "roles.yaml": rolesFileSchema,
  "members.yaml": membersFileSchema,
  "triggers.yaml": triggersFileSchema,
  "mcp_servers.yaml": mcpServersFileSchema,
  "host_tools.yaml": hostToolsFileSchema,
} as const;

export type ConfigFileName = keyof typeof CONFIG_FILE_SCHEMAS;
export type ConfigFileContents = {
  [K in ConfigFileName]: z.output<(typeof CONFIG_FILE_SCHEMAS)[K]>;
};

export const CONFIG_FILE_NAMES = Object.keys(CONFIG_FILE_SCHEMAS) as ConfigFileName[];

/** なければエラーにするファイル（それ以外は、なければ空として扱う） */
export const REQUIRED_CONFIG_FILES: readonly ConfigFileName[] = [
  "aicoop.yaml",
  "groups.yaml",
  "roles.yaml",
  "members.yaml",
];

/** 1つの設定ファイルの中身（YAML を読んだもの）を、スキーマで読む */
export function parseConfigFile<K extends ConfigFileName>(
  name: K,
  input: unknown,
): ParseResult<ConfigFileContents[K]> {
  // K ごとのスキーマと出力の型の対応は CONFIG_FILE_SCHEMAS が決めている（TypeScript は K で絞れない）
  const schema = CONFIG_FILE_SCHEMAS[name] as unknown as z.ZodType<ConfigFileContents[K]>;
  // 中身が空のファイル（YAML の null）は、何も書いていないものとして扱う
  const value = input ?? {};
  const result = schema.safeParse(value, { error: configErrorMap });
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: zodIssuesToConfigIssues(result.error, name, schema, value) };
}
