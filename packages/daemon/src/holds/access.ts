/**
 * 一時権限の申請（5.7.3 の1・2・4、5.3.3 の request_access）。
 *
 * 1. 入力を確かめる（型・上限。誤りは invalid_input）
 * 2. `service.operation` が、その社員の部署（部長は役員室）の `ceiling` にない → outside_ceiling
 *    `params` が `ceiling` の範囲の外 → outside_ceiling
 * 3. `duration_hours` が `grants.max_hours` を超える → too_long
 * 4. 通れば一時権限を `pending_manager`（部長がいなければ `pending_owner`）で作り、部長にレビューのタスクを作る
 *
 * `mode` は申請では決められない。`ceiling` の同じ操作の項目のうち、申請の範囲を含むものの `mode` を使う
 * （複数あって、どれかが hold なら hold。拒否側）。
 *
 * `params` の範囲の確かめ方（申請した値 v が、上限の glob g の中にあるか）：
 * - v に `*` がなければ、g が v に当てはまるか
 * - v に `*` があれば、v と g が同じ・g が `*`・g が「`*` のない文字列 + 末尾の `*`」で v がその文字列で始まる、のどれか
 *   （それ以外は、広さを比べられないので範囲の外とする）
 */
import {
  type CompiledOperation,
  matchesGlob,
  type PermissionItem,
  resolveMember,
} from "@aicoop/shared";
import { createGrant, type Grant } from "../db/grants.ts";
import { writeTransaction } from "../db/open.ts";
import { hasUnsafeChar } from "../gateway/report-result.ts";
import type { HoldDeps } from "./deps.ts";
import { createGrantReviewTask, reviewerFor } from "./review.ts";
import { grantSummaryOf } from "./views.ts";

export const MAX_REASON_CHARS = 1000;
export const DEFAULT_DURATION_HOURS = 24;
const MAX_PARAM_VALUES = 20;
const MAX_PARAM_CHARS = 200;
const KEYS = new Set(["service", "operation", "params", "reason", "duration_hours"]);

export type AccessOutcome =
  | { readonly ok: true; readonly grant: Grant }
  | {
      readonly ok: false;
      readonly code: "invalid_input" | "outside_ceiling" | "too_long" | "not_allowed";
      readonly message: string;
    };

const invalid = (message: string): AccessOutcome => ({ ok: false, code: "invalid_input", message });

/** request_access の入力の JSON Schema（tools/list で見せる） */
export function requestAccessInputSchema(maxHours: number) {
  return {
    type: "object",
    properties: {
      service: { type: "string", description: "サービス（例：github）" },
      operation: { type: "string", description: "サービスの中の操作（例：git.push）" },
      params: {
        type: "object",
        additionalProperties: { type: "array", items: { type: "string" } },
        description: 'パラメーターの範囲（例：{"repo": ["myorg/new"]}）。部署の上限の範囲の中だけ',
      },
      reason: {
        type: "string",
        maxLength: MAX_REASON_CHARS,
        description: "なぜ要るのか（必須。1000文字まで）",
      },
      duration_hours: {
        type: "integer",
        minimum: 1,
        maximum: maxHours,
        description: `何時間使うか（既定 ${DEFAULT_DURATION_HOURS}、最大 ${maxHours}）`,
      },
    },
    required: ["service", "operation", "reason"],
    additionalProperties: false,
  } as const;
}

export function requestAccess(deps: HoldDeps, memberId: string, args: unknown): AccessOutcome {
  const config = deps.config();
  const member = resolveMember(config, memberId);
  if (member === undefined || member.role.id === "ceo") {
    return { ok: false, code: "not_allowed", message: "request_access は使えません" };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return invalid("引数はオブジェクトで渡してください");
  }
  const a = args as Record<string, unknown>;
  const unknownKeys = Object.keys(a).filter((k) => !KEYS.has(k));
  if (unknownKeys.length > 0) {
    return invalid(`使える引数は ${[...KEYS].join("・")} だけです`);
  }
  if (typeof a.service !== "string" || !/^[a-z0-9-]{1,40}$/.test(a.service)) {
    return invalid("service はサービスの ID（例：github）で書いてください");
  }
  if (
    typeof a.operation !== "string" ||
    !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(a.operation) ||
    a.operation.length > 80
  ) {
    return invalid("operation はサービスの中の操作の名前（例：git.push）で書いてください");
  }
  const reason = a.reason;
  if (typeof reason !== "string" || reason.trim() === "") {
    return invalid("reason（なぜ要るのか）を書いてください");
  }
  if ([...reason].length > MAX_REASON_CHARS) {
    return invalid(`reason は${MAX_REASON_CHARS}文字までです`);
  }
  if (hasUnsafeChar(reason)) {
    return invalid("reason に制御文字や文字の向きを変える文字は使えません");
  }
  const rawDuration = a.duration_hours ?? DEFAULT_DURATION_HOURS;
  if (typeof rawDuration !== "number" || !Number.isInteger(rawDuration) || rawDuration < 1) {
    return invalid("duration_hours は1以上の整数（時間）にしてください");
  }
  const params = parseParams(a.params);
  if (typeof params === "string") return invalid(params);

  const opId = `${a.service}.${a.operation}`;
  const ceiling = member.group.ceiling.filter((c) => c.op === opId);
  const op = config.catalog.getOperation(opId);
  if (ceiling.length === 0 || op === undefined) {
    return {
      ok: false,
      code: "outside_ceiling",
      message: `操作 ${opId} は、あなたの部署（${member.group.id}）の上限にないので、申請できません`,
    };
  }
  const names = pathParams(op);
  const unknownParams = Object.keys(params).filter((n) => !names.has(n));
  if (unknownParams.length > 0) {
    return invalid(
      `操作 ${opId} には、パラメーター ${unknownParams.join("・")} がありません${names.size > 0 ? `（使えるのは ${[...names].join("・")}）` : ""}`,
    );
  }
  const containing = ceiling.filter((c) => within(params, c));
  if (containing.length === 0) {
    return {
      ok: false,
      code: "outside_ceiling",
      message: `申請した範囲（${JSON.stringify(params)}）は、部署の上限の範囲の外です`,
    };
  }
  const maxHours = config.aicoop.grants.max_hours;
  if (rawDuration > maxHours) {
    return {
      ok: false,
      code: "too_long",
      message: `duration_hours は ${maxHours} 時間までです（aicoop.yaml の grants.max_hours）`,
    };
  }
  const mode = containing.some((c) => c.mode === "hold") ? "hold" : "allow";

  const manager = reviewerFor(config, member.member.group);
  const grant = writeTransaction(deps.db, () => {
    const created = createGrant(deps.db, {
      memberId: member.id,
      service: a.service as string,
      operation: a.operation as string,
      params,
      mode,
      reason,
      durationHours: rawDuration,
      status: manager === undefined ? "pending_owner" : "pending_manager",
    });
    if (manager !== undefined) {
      createGrantReviewTask(deps, config, manager, created, grantSummaryOf(created));
    }
    return created;
  });
  if (manager !== undefined) deps.onTaskCreated?.();
  deps.logger?.info(
    { member: member.id, grant: grant.id, operation: opId, hours: rawDuration },
    "一時権限の申請を受けました",
  );
  return { ok: true, grant };
}

function parseParams(value: unknown): Record<string, string[]> | string {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 'params は {"<名前>": ["<値>", ...]} の形のオブジェクトにしてください';
  }
  const out: Record<string, string[]> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]*$/.test(name))
      return `params の名前 ${JSON.stringify(name)} は使えません`;
    const values = typeof raw === "string" ? [raw] : raw;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > MAX_PARAM_VALUES ||
      !values.every(
        (v) =>
          typeof v === "string" &&
          v !== "" &&
          v.length <= MAX_PARAM_CHARS &&
          !/[\p{Cc}\p{Cf}\s]/u.test(v),
      )
    ) {
      return `params の ${name} は、空白のない文字列の配列（${MAX_PARAM_VALUES}個まで）にしてください`;
    }
    out[name] = [...new Set(values as string[])];
  }
  return out;
}

function pathParams(op: CompiledOperation): Set<string> {
  return new Set(
    op.matchers.flatMap((m) =>
      [...m.pattern.source.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((x) => x[1] as string),
    ),
  );
}

/** 申請の範囲が、上限の1項目の範囲の中か */
function within(params: Readonly<Record<string, readonly string[]>>, c: PermissionItem): boolean {
  for (const [name, values] of Object.entries(params)) {
    const globs = c.params?.[name];
    if (globs === undefined) continue;
    if (!values.every((v) => globs.some((g) => subsumes(g, v)))) return false;
  }
  return true;
}

/** glob g が、申請の値 v（glob でもよい）に当てはまるものをすべて含むか（分からなければ false） */
export function subsumes(g: string, v: string): boolean {
  if (!v.includes("*")) return matchesGlob(g, v);
  if (g === v || g === "*") return true;
  const prefix = g.slice(0, -1);
  return g.endsWith("*") && !prefix.includes("*") && v.startsWith(prefix);
}
