/**
 * state.db に書く値の形の確かめ（書く前に弾く。拒否側に倒す）。
 */

/** 社員ID・部署ID（6.5：英小文字・数字・ハイフンで1〜40文字） */
const MEMBER_OR_GROUP_ID = /^[a-z0-9-]{1,40}$/;

/** スレッド名・セッションID：1〜200文字、制御文字・見えない書式文字・行区切りを含まない */
const SAFE_TOKEN = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,200}$/u;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function assertMemberId(value: unknown, name = "社員ID"): asserts value is string {
  if (typeof value !== "string" || !MEMBER_OR_GROUP_ID.test(value)) {
    throw new TypeError(`${name}の形が違います（英小文字・数字・ハイフンで1〜40文字）`);
  }
}

export function assertGroupId(value: unknown): asserts value is string {
  assertMemberId(value, "部署ID");
}

export function assertThread(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new TypeError("スレッド名は1〜200文字で、改行や制御文字を含めないでください");
  }
}

export function assertSessionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SAFE_TOKEN.test(value)) {
    throw new TypeError("セッションIDは1〜200文字で、改行や制御文字を含めないでください");
  }
}

/** `2026-11-27T12:34:56.789Z` の形の UTC の時刻（7.1） */
export function isIsoTime(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC.test(value)) return false;
  const t = Date.parse(value);
  return !Number.isNaN(t) && new Date(t).toISOString() === value;
}
