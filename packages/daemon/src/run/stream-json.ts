/**
 * Claude Code の stream-json（`--output-format stream-json --verbose`）を1行ずつ読む。
 *
 * 使うのは次の3つだけ。それ以外の行は記録するだけで、中身は見ない。
 * - `system`（`subtype: init`）の `session_id`（5.4.5 の3）
 * - `rate_limit_event`（5.4.6 の1）
 * - `result`（終わり方。5.5.6、5.4.6 の2）
 *
 * 行は箱の中から来る（Z3）。形が違うもの・知らない値は、使わずに `other` にする（拒否側に倒す）。
 */

export type UsageEventStatus = "allowed" | "allowed_warning" | "rejected";

export type StreamEvent =
  | { readonly kind: "init"; readonly sessionId: string }
  | {
      readonly kind: "rate_limit";
      readonly status: UsageEventStatus;
      /** 再開予定時刻（ISO 8601 の UTC）。読めなければ null */
      readonly resetsAt: string | null;
      readonly rateLimitType: string | null;
      /** 0〜1。入っていない・範囲の外なら null（16章 V-7） */
      readonly utilization: number | null;
    }
  | {
      readonly kind: "result";
      readonly isError: boolean;
      readonly subtype: string | null;
      readonly text: string | null;
    }
  | { readonly kind: "other" };

const OTHER: StreamEvent = Object.freeze({ kind: "other" });
const STATUSES: ReadonlySet<string> = new Set<UsageEventStatus>([
  "allowed",
  "allowed_warning",
  "rejected",
]);
const RATE_LIMIT_TYPE = /^[A-Za-z0-9_.-]{1,64}$/;
const SUBTYPE = /^[A-Za-z0-9_.-]{1,64}$/;

export function parseStreamLine(line: string): StreamEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return OTHER;
  }
  if (!isRecord(value)) return OTHER;

  switch (value.type) {
    case "system":
      if (value.subtype === "init" && typeof value.session_id === "string") {
        return { kind: "init", sessionId: value.session_id };
      }
      return OTHER;
    case "rate_limit_event":
      return parseRateLimit(isRecord(value.rate_limit_info) ? value.rate_limit_info : value);
    case "result":
      return {
        kind: "result",
        isError: value.is_error === true,
        subtype:
          typeof value.subtype === "string" && SUBTYPE.test(value.subtype) ? value.subtype : null,
        text: typeof value.result === "string" ? value.result : null,
      };
    default:
      return OTHER;
  }
}

function parseRateLimit(info: Record<string, unknown>): StreamEvent {
  const status = info.status;
  if (typeof status !== "string" || !STATUSES.has(status)) return OTHER;
  const type = info.rateLimitType;
  const utilization = info.utilization;
  return {
    kind: "rate_limit",
    status: status as UsageEventStatus,
    resetsAt: toIsoTime(info.resetsAt),
    rateLimitType: typeof type === "string" && RATE_LIMIT_TYPE.test(type) ? type : null,
    utilization:
      typeof utilization === "number" &&
      Number.isFinite(utilization) &&
      utilization >= 0 &&
      utilization <= 1
        ? utilization
        : null,
  };
}

/** UNIX 秒・UNIX ミリ秒・ISO の文字列を ISO 8601 の UTC にする。読めなければ null */
export function toIsoTime(value: unknown): string | null {
  let ms: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    ms = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === "string" && /^\d{9,13}$/.test(value)) {
    return toIsoTime(Number(value));
  } else if (typeof value === "string") {
    ms = Date.parse(value);
  } else {
    return null;
  }
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 利用枠の上限を示す文言（Claude Code の結果のエラー） */
const USAGE_LIMIT_TEXT = /usage limit|limit reached|hit your limit/i;
const USAGE_LIMIT_EPOCH = /\|(\d{9,13})\b/;

/**
 * 5.4.6 の2：結果のエラーの文言が利用枠の上限を示すか。示すなら、読めた再開予定時刻（なければ null）。
 */
export function usageLimitInResult(text: string | null): { resetsAt: string | null } | null {
  if (text === null || !USAGE_LIMIT_TEXT.test(text)) return null;
  const epoch = USAGE_LIMIT_EPOCH.exec(text);
  return { resetsAt: epoch ? toIsoTime(Number(epoch[1])) : null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
