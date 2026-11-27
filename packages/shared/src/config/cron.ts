/**
 * cron トリガーの時刻（5.5.1、6.6）。
 * 設定の検証（E-007）と、daemon が次に起こす時刻を求めるところで、同じ読み方をする。
 */
import { Cron } from "croner";

function parseCron(schedule: string, timezone: string): Cron {
  // 5項目だけ（秒つきの6項目や @daily などは、設計書の「5項目のcron式」ではない）
  return new Cron(schedule, { timezone, mode: "5-part", paused: true });
}

/**
 * cron式を確かめる。読めなければ、その理由（日本語）を返す。
 * 読めても一度も起きない式（例：2月31日）も、誤りとして扱う。
 */
export function checkCronSchedule(
  schedule: string,
  timezone: string,
  now: Date = new Date(),
): string | undefined {
  const fields = schedule.trim() === "" ? [] : schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    return fields.length === 0 ? "空です" : `項目が${fields.length}個あります（5個にしてください）`;
  }
  let cron: Cron;
  try {
    cron = parseCron(schedule, timezone);
  } catch (e) {
    return cronErrorReason(e);
  }
  try {
    if (cron.nextRun(now) === null) return "この式では一度も起きません";
  } finally {
    cron.stop();
  }
  return undefined;
}

const FIELD_NAMES: Readonly<Record<string, string>> = {
  minute: "分",
  hour: "時",
  day: "日",
  month: "月",
  "day-of-week": "曜日",
  dayOfWeek: "曜日",
  weekday: "曜日",
};

/** croner の英語の理由を、分かるものは日本語にする */
function cronErrorReason(e: unknown): string {
  const message = (e instanceof Error ? e.message : String(e)).replace(/^CronPattern:\s*/, "");
  const invalid = /^Invalid value for ([\w-]+): (.*)$/.exec(message);
  if (invalid) {
    const field = FIELD_NAMES[invalid[1] ?? ""] ?? invalid[1];
    return `${field}の値「${invalid[2]}」が範囲外か、読めません`;
  }
  return message;
}

/** `after` より後で、次に起こす時刻。読めない式や、もう起きない式なら null */
export function nextCronRun(schedule: string, timezone: string, after: Date): Date | null {
  if (checkCronSchedule(schedule, timezone, after) !== undefined) return null;
  const cron = parseCron(schedule, timezone);
  try {
    return cron.nextRun(after);
  } finally {
    cron.stop();
  }
}
