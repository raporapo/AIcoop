/**
 * サービスと操作の定義（5.2.3、6.7）。
 *
 * ルールを「GitHubにpushしてよい」のような言葉で書けるように、HTTPの細かい形はここに閉じ込める。
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { configErrorMap, zodIssuesToConfigIssues } from "./config/messages.ts";
import type { ConfigIssue, ParseResult } from "./config-issue.ts";
import { compilePathPattern, type PathPattern, PathPatternError } from "./path-pattern.ts";

const ID = /^[a-z0-9-]+$/;
const OPERATION_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const PARAM_NAME = /^[a-z][a-z0-9_]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const HOST =
  /^(?:\*|(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/i;

export const httpMethodSchema = z.enum([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

/** 操作のタグ（5.2.3 の5）。設定の検証（W-002）で使う */
export const operationTagSchema = z.enum(["reads_external", "reads_internal", "sends_external"]);
export type OperationTag = z.infer<typeof operationTagSchema>;

/** 保留したときの要約の作り方（5.7.1 の2） */
export const summaryKindSchema = z.enum(["gmail_message", "github_pr_merge", "social_post"]);
export type SummaryKind = z.infer<typeof summaryKindSchema>;

/** 本物の資格の種類（5.2.8 の4） */
export const secretKindSchema = z.enum([
  "static_token",
  "github_app",
  "google_oauth",
  "anthropic_oauth",
]);
export type SecretKind = z.infer<typeof secretKindSchema>;

const hostSchema = z
  .string()
  .regex(HOST, "ホスト名として読めません")
  .transform((h) => h.toLowerCase());

const matchSchema = z.strictObject({
  method: z
    .union([httpMethodSchema, z.array(httpMethodSchema).min(1)])
    .transform((m) => (Array.isArray(m) ? m : [m])),
  host: hostSchema.optional(),
  path: z.string(),
});

const operationSchema = z.strictObject({
  match: z.array(matchSchema).min(1, "match を1つ以上書いてください"),
  tags: z.array(operationTagSchema).default([]),
  summary: summaryKindSchema.optional(),
  github_permissions: z.record(z.string().regex(/^[a-z_]+$/), z.enum(["read", "write"])).optional(),
});

const secretSchema = z.strictObject({
  env: z.string().regex(ENV_NAME, "環境変数の名前は英大文字・数字・_ で書いてください"),
  kind: secretKindSchema,
  header: z
    .string()
    .regex(HEADER_NAME)
    .transform((h) => h.toLowerCase()),
});

export const serviceDefinitionSchema = z
  .strictObject({
    id: z.string().regex(ID, "サービスの名前は英小文字・数字・ハイフンで書いてください"),
    hosts: z.array(hostSchema).min(1, "hosts を1つ以上書いてください"),
    params: z.record(z.string().regex(PARAM_NAME), z.number().int().min(1)).default({}),
    secret: secretSchema.nullable().default(null),
    operations: z.record(
      z
        .string()
        .regex(OPERATION_NAME, "操作の名前は英小文字・数字・ハイフンを . でつないで書いてください"),
      operationSchema,
    ),
  })
  .superRefine((service, ctx) => {
    for (const [name, op] of Object.entries(service.operations)) {
      op.match.forEach((m, i) => {
        const at = ["operations", name, "match", i];
        try {
          compilePathPattern(m.path, service.params);
        } catch (e) {
          if (!(e instanceof PathPatternError)) throw e;
          ctx.addIssue({ code: "custom", message: e.message, path: [...at, "path"] });
        }
        if (m.host !== undefined && !service.hosts.includes(m.host)) {
          ctx.addIssue({
            code: "custom",
            message: `host ${m.host} がサービスの hosts にありません`,
            path: [...at, "host"],
          });
        }
      });
    }
  });

export type ServiceDefinition = z.output<typeof serviceDefinitionSchema>;
export type OperationDefinition = ServiceDefinition["operations"][string];

export function parseServiceDefinition(
  input: unknown,
  source?: string,
): ParseResult<ServiceDefinition> {
  // メッセージは日本語にする（11.7）
  const result = serviceDefinitionSchema.safeParse(input, { error: configErrorMap });
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: zodIssuesToConfigIssues(result.error, source, serviceDefinitionSchema, input),
  };
}

export function parseServiceYaml(text: string, source: string): ParseResult<ServiceDefinition> {
  let input: unknown;
  try {
    input = parseYaml(text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      issues: [{ code: "E-013", message: `YAMLとして読めません: ${message}`, source }],
    };
  }
  return parseServiceDefinition(input, source);
}

/**
 * 組み込みの定義にオーナーの定義を重ねる（5.2.3 の1）。
 * 同じ id があれば、オーナーの定義が組み込みを丸ごと上書きする。
 */
export function overrideServices(
  builtins: readonly ServiceDefinition[],
  owners: readonly ServiceDefinition[],
): ServiceDefinition[] {
  const byId = new Map(owners.map((s) => [s.id, s]));
  const merged = builtins.map((b) => byId.get(b.id) ?? b);
  const builtinIds = new Set(builtins.map((b) => b.id));
  return [...merged, ...owners.filter((o) => !builtinIds.has(o.id))];
}

/** サービス定義どうしに関わる設定の検証（6.10 の E-010・E-011） */
export function validateServiceCatalog(services: readonly ServiceDefinition[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  for (const s of services) {
    if (s.id !== "web" && s.hosts.includes("*")) {
      issues.push({
        code: "E-010",
        message: `サービス ${s.id} の hosts に * があります。* を使えるのは web だけです`,
        path: `${s.id}.hosts`,
      });
    }
  }

  const withSecret = services.filter((s) => s.secret !== null);
  for (let i = 0; i < withSecret.length; i++) {
    for (let j = i + 1; j < withSecret.length; j++) {
      const a = withSecret[i] as ServiceDefinition;
      const b = withSecret[j] as ServiceDefinition;
      const shared = a.hosts.filter((h) => h !== "*" && b.hosts.includes(h));
      if (shared.length > 0) {
        issues.push({
          code: "E-011",
          message: `資格を使うサービス ${a.id} と ${b.id} の hosts が重なっています: ${shared.join(", ")}`,
          path: `${b.id}.hosts`,
        });
      }
    }
  }

  return issues;
}

// ---- 判定に使う形（読み込み済み・検証済みの定義から作る） ----

export interface CompiledMatcher {
  readonly methods: ReadonlySet<string>;
  /** なければ、サービスの hosts のどれでもよい */
  readonly host: string | undefined;
  readonly pattern: PathPattern;
}

export interface CompiledOperation {
  /** `<service>.<operation>`（例：`github.git.push`） */
  readonly id: string;
  readonly service: string;
  readonly name: string;
  readonly tags: readonly OperationTag[];
  readonly summary: SummaryKind | undefined;
  readonly matchers: readonly CompiledMatcher[];
}

export interface CompiledService {
  readonly id: string;
  readonly hosts: ReadonlySet<string>;
  /** hosts に * がある（web） */
  readonly wildcard: boolean;
  readonly secret: ServiceDefinition["secret"];
  readonly operations: readonly CompiledOperation[];
}

export interface ServiceCatalog {
  readonly services: readonly CompiledService[];
  /** どのサービスかの hosts に名前で書かれているホスト（web の * から除く） */
  readonly explicitHosts: ReadonlySet<string>;
  getOperation(id: string): CompiledOperation | undefined;
}

export function createServiceCatalog(definitions: readonly ServiceDefinition[]): ServiceCatalog {
  const services: CompiledService[] = definitions.map((def) => ({
    id: def.id,
    hosts: new Set(def.hosts.filter((h) => h !== "*")),
    wildcard: def.hosts.includes("*"),
    secret: def.secret,
    operations: Object.entries(def.operations).map(([name, op]) => ({
      id: `${def.id}.${name}`,
      service: def.id,
      name,
      tags: op.tags,
      summary: op.summary,
      matchers: op.match.map((m) => ({
        methods: new Set(m.method),
        host: m.host,
        pattern: compilePathPattern(m.path, def.params),
      })),
    })),
  }));

  const explicitHosts = new Set(services.flatMap((s) => [...s.hosts]));
  const byId = new Map(services.flatMap((s) => s.operations.map((o) => [o.id, o] as const)));

  return {
    services,
    explicitHosts,
    getOperation: (id) => byId.get(id),
  };
}
