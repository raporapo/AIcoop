/**
 * ルールの判定（5.2.4）。
 *
 * 社員 m（役職 r、部署 g）から来たリクエスト q を、allow・hold・deny のどれかに決める。
 * 書いていないことは禁止（P-3）：どの許可にも一致しなければ、必ず deny になる。
 */
import { z } from "zod";
import { matchesGlob } from "./glob.ts";
import { identifyOperations, type RequestTarget } from "./operation.ts";
import type { CompiledOperation, ServiceCatalog } from "./service.ts";

export const modeSchema = z.enum(["allow", "hold"]);
/** `hold` は重い操作（5.7.1）。`allow` より厳しい */
export type Mode = z.infer<typeof modeSchema>;

/** 許可項目（6.3）。部署の `ceiling` と役職の `allow` で共通 */
export const permissionItemSchema = z.strictObject({
  op: z
    .string()
    .regex(
      /^[a-z0-9-]+\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/,
      "op は <service>.<operation> で書いてください",
    ),
  mode: modeSchema.default("allow"),
  params: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.array(z.string())).optional(),
});
export type PermissionItem = z.output<typeof permissionItemSchema>;
export type PermissionItemInput = z.input<typeof permissionItemSchema>;

export type GrantStatus = "pending_manager" | "pending_owner" | "active" | "rejected" | "expired";

/** 一時権限（7.2 の grants の1行のうち、判定に使う部分） */
export interface GrantInput {
  readonly id: string;
  /** `<service>.<operation>` */
  readonly op: string;
  readonly params?: Readonly<Record<string, readonly string[]>>;
  /** 部署の ceiling から決まる（5.7.3 の4） */
  readonly mode: Mode;
  readonly status: GrantStatus;
  readonly startsAt?: string | null;
  readonly expiresAt?: string | null;
}

/**
 * 有効な許可 E(m) の1項目。
 * `params` は名前ごとの制限の一覧で、値は「どの一覧にも、一致する glob が1つ以上ある」ときだけ通る。
 * （役職と上限の両方の制限を持つことで、共通部分を表す）
 */
export interface EffectivePermission {
  readonly op: string;
  readonly mode: Mode;
  readonly params: Readonly<Record<string, readonly (readonly string[])[]>>;
  readonly source: { readonly kind: "role" } | { readonly kind: "grant"; readonly grantId: string };
}

interface Restricting {
  readonly op: string;
  readonly mode?: Mode | undefined;
  readonly params?: Readonly<Record<string, readonly string[]>> | undefined;
}

/** 5.2.4 の2：役職の allow・部署の ceiling・一時権限から、有効な許可を求める */
export function effectivePermissions(input: {
  readonly allow: readonly PermissionItemInput[];
  readonly ceiling: readonly PermissionItemInput[];
  readonly grants?: readonly GrantInput[];
  readonly now: Date;
}): EffectivePermission[] {
  const result: EffectivePermission[] = [];

  for (const a of input.allow) {
    for (const c of input.ceiling) {
      if (c.op !== a.op) continue;
      result.push({ ...combine(a, c), source: { kind: "role" } });
    }
  }

  for (const x of input.grants ?? []) {
    if (!isGrantActive(x, input.now)) continue;
    for (const c of input.ceiling) {
      if (c.op !== x.op) continue;
      result.push({ ...combine(x, c), source: { kind: "grant", grantId: x.id } });
    }
  }

  return result;
}

function combine(
  a: Restricting,
  c: Restricting,
): Pick<EffectivePermission, "op" | "mode" | "params"> {
  const params: Record<string, (readonly string[])[]> = {};
  for (const item of [a, c]) {
    for (const [name, globs] of Object.entries(item.params ?? {})) {
      params[name] ??= [];
      params[name].push(globs);
    }
  }
  return { op: a.op, mode: stricter(a.mode ?? "allow", c.mode ?? "allow"), params };
}

function stricter(x: Mode, y: Mode): Mode {
  return x === "hold" || y === "hold" ? "hold" : "allow";
}

function isGrantActive(grant: GrantInput, now: Date): boolean {
  if (grant.status !== "active") return false;
  if (!grant.startsAt || !grant.expiresAt) return false;
  const starts = Date.parse(grant.startsAt);
  const expires = Date.parse(grant.expiresAt);
  if (Number.isNaN(starts) || Number.isNaN(expires)) return false;
  const t = now.getTime();
  return starts <= t && t < expires;
}

export type RuleDecision =
  | {
      readonly decision: "allow" | "hold";
      readonly operation: CompiledOperation;
      readonly params: Readonly<Record<string, string>>;
      /** 決め手になった許可 */
      readonly permission: EffectivePermission;
    }
  | {
      readonly decision: "deny";
      readonly reason: "not_allowed";
      readonly operation: CompiledOperation;
      readonly params: Readonly<Record<string, string>>;
    }
  | { readonly decision: "deny"; readonly reason: "no_operation"; readonly operation: null };

/** 5.2.4 の1・3・4：リクエストを判定する */
export function evaluateRequest(
  catalog: ServiceCatalog,
  effective: readonly EffectivePermission[],
  request: RequestTarget,
): RuleDecision {
  const matches = identifyOperations(catalog, request);
  const first = matches[0];
  if (first === undefined) {
    return { decision: "deny", reason: "no_operation", operation: null };
  }

  let held: RuleDecision | undefined;
  for (const { operation, params } of matches) {
    for (const permission of effective) {
      if (permission.op !== operation.id) continue;
      if (!paramsSatisfy(permission.params, params)) continue;
      if (permission.mode === "allow") {
        return { decision: "allow", operation, params, permission };
      }
      held ??= { decision: "hold", operation, params, permission };
    }
  }
  if (held) return held;

  return {
    decision: "deny",
    reason: "not_allowed",
    operation: first.operation,
    params: first.params,
  };
}

function paramsSatisfy(
  constraints: EffectivePermission["params"],
  values: Readonly<Record<string, string>>,
): boolean {
  for (const [name, lists] of Object.entries(constraints)) {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;
    // 制限しているパラメーターがリクエストになければ、一致したとみなさない（拒否側に倒す）
    if (value === undefined) return false;
    if (!lists.every((globs) => globs.some((g) => matchesGlob(g, value)))) return false;
  }
  return true;
}
