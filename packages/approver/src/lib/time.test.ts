import { describe, expect, test } from "vitest";
import { deadline, formatClock, formatDateTime, formatRemaining, relativeTime } from "./time.ts";

const NOW = Date.parse("2026-11-28T03:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("時刻の表し方：API の UTC を、ブラウザの時刻で分かりやすく（5.8 の4）", () => {
  test("近い時刻は「N分後」「N分前」", () => {
    expect(relativeTime(NOW + 3 * MIN, NOW)).toBe("3分後");
    expect(relativeTime(NOW - 3 * MIN, NOW)).toBe("3分前");
    expect(relativeTime(NOW + 20_000, NOW)).toBe("1分以内");
    expect(relativeTime(NOW - 20_000, NOW)).toBe("たった今");
  });

  test("数時間なら「N時間M分後」、それより先は「N時間後」「N日後」", () => {
    expect(relativeTime(NOW + 2 * HOUR + 5 * MIN, NOW)).toBe("2時間5分後");
    expect(relativeTime(NOW + 2 * HOUR, NOW)).toBe("2時間後");
    expect(relativeTime(NOW + 10 * HOUR + 30 * MIN, NOW)).toBe("10時間後");
    expect(relativeTime(NOW - 5 * HOUR, NOW)).toBe("5時間前");
    expect(relativeTime(NOW + 72 * HOUR, NOW)).toBe("3日後");
    expect(relativeTime(NOW - 30 * 24 * HOUR, NOW)).toBe("30日前");
  });

  test("期限：近いものほど目立たせる段階を返す（色だけに頼らず、文でも言う）", () => {
    expect(deadline("2026-11-28T03:03:00.000Z", NOW)).toEqual({
      text: "3分後に期限",
      level: "urgent",
    });
    expect(deadline("2026-11-28T05:00:00.000Z", NOW)).toEqual({
      text: "2時間後に期限",
      level: "soon",
    });
    expect(deadline("2026-11-30T03:00:00.000Z", NOW)).toEqual({
      text: "2日後に期限",
      level: "normal",
    });
    expect(deadline("2026-11-28T02:50:00.000Z", NOW)).toEqual({
      text: "期限切れ（10分前）",
      level: "past",
    });
  });

  test("読めない時刻は、読めないと言う（黙って今の時刻などにしない）", () => {
    expect(deadline("あした", NOW)).toEqual({ text: "期限を読めません", level: "past" });
    expect(formatDateTime("not-a-date", { now: NOW })).toBe("（時刻を読めません）");
  });

  test("日時は、ブラウザのタイムゾーンの「月日(曜日) 時:分」。年が違えば年も", () => {
    expect(formatDateTime("2026-11-28T03:04:00.000Z", { now: NOW, timeZone: "Asia/Tokyo" })).toBe(
      "11月28日(土) 12:04",
    );
    expect(formatDateTime("2026-11-28T03:04:00.000Z", { now: NOW, timeZone: "UTC" })).toBe(
      "11月28日(土) 03:04",
    );
    expect(formatDateTime("2025-01-02T00:00:00.000Z", { now: NOW, timeZone: "UTC" })).toBe(
      "2025年1月2日(木) 00:00",
    );
    expect(formatClock("2026-11-28T03:04:05.000Z", { timeZone: "Asia/Tokyo" })).toBe("12:04:05");
  });

  test("署名の期限までの残りは「1分52秒」の形", () => {
    expect(formatRemaining(112_000)).toBe("1分52秒");
    expect(formatRemaining(9_500)).toBe("9秒");
    expect(formatRemaining(-1)).toBe("0秒");
  });
});
