import { describe, expect, it } from "vitest";
import { formatDuration, formatTime } from "./time.ts";

describe("7.1：時刻は aicoop.yaml の timezone で表示する", () => {
  it("UTC の ISO 8601 を、そのタイムゾーンの時刻にする", () => {
    expect(formatTime("2026-11-27T23:34:56.789Z", "Asia/Tokyo")).toBe("2026-11-28 08:34");
    expect(formatTime("2026-11-27T23:34:56.789Z", "UTC")).toBe("2026-11-27 23:34");
    expect(formatTime("2026-11-27T23:34:56.789Z", "Asia/Tokyo", { seconds: true })).toBe(
      "2026-11-28 08:34:56",
    );
  });

  it("0時は 00 と書く（24 にならない）", () => {
    expect(formatTime("2026-11-27T15:00:00.000Z", "Asia/Tokyo")).toBe("2026-11-28 00:00");
  });

  it("時刻だけの形", () => {
    expect(formatTime("2026-11-27T23:34:56.789Z", "Asia/Tokyo", { timeOnly: true })).toBe(
      "08:34:56",
    );
  });

  it("読めない値はそのまま返す（落とさない）", () => {
    expect(formatTime("not-a-date", "Asia/Tokyo")).toBe("not-a-date");
  });
});

describe("経過時間", () => {
  it("秒・分・時間で書く", () => {
    expect(formatDuration(12_300)).toBe("12秒");
    expect(formatDuration(8 * 60_000 + 8_000)).toBe("8分8秒");
    expect(formatDuration(62 * 60_000)).toBe("1時間2分");
    expect(formatDuration(500)).toBe("1秒未満");
  });
});
