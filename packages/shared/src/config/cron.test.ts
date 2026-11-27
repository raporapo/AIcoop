import { describe, expect, it } from "vitest";
import { checkCronSchedule, nextCronRun } from "./cron.ts";

describe("5.5.1 cron：次に起こす時刻", () => {
  it("aicoop.yaml の timezone で読む（平日の8時は、土曜の朝なら月曜の8時）", () => {
    // 2026-11-28 は土曜。日本時間では 09:00
    const next = nextCronRun("0 8 * * 1-5", "Asia/Tokyo", new Date("2026-11-28T00:00:00.000Z"));
    expect(next?.toISOString()).toBe("2026-11-29T23:00:00.000Z");
  });

  it("同じ式でも timezone が違えば、別の時刻になる", () => {
    const next = nextCronRun("0 8 * * *", "UTC", new Date("2026-11-28T00:00:00.000Z"));
    expect(next?.toISOString()).toBe("2026-11-28T08:00:00.000Z");
  });

  it.each(["61 * * * *", "0 0 8 * * *", "@hourly", "0 8 31 2 *"])(
    "読めない式・一度も起きない式（%s）は null（起こさない）",
    (schedule) => {
      expect(nextCronRun(schedule, "Asia/Tokyo", new Date("2026-11-28T00:00:00.000Z"))).toBeNull();
    },
  );

  it("6.10 E-007：理由を日本語で返す", () => {
    expect(checkCronSchedule("0 8 * *", "UTC")).toBe("項目が4個あります（5個にしてください）");
    expect(checkCronSchedule("   ", "UTC")).toBe("空です");
    expect(checkCronSchedule("0 8 31 2 *", "UTC")).toBe("この式では一度も起きません");
    expect(checkCronSchedule("0 8 * * 1-5", "UTC")).toBeUndefined();
    expect(checkCronSchedule("0 25 * * *", "UTC")).toBe("時の値「25」が範囲外か、読めません");
    expect(checkCronSchedule("61 8 * * *", "UTC")).toBe("分の値「61」が範囲外か、読めません");
  });
});
