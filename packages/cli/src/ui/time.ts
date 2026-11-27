/**
 * 時刻の表示（7.1：保存は UTC、表示は aicoop.yaml の timezone）。
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface FormatTimeOptions {
  readonly seconds?: boolean;
  /** 日付を省いて「時:分:秒」だけ */
  readonly timeOnly?: boolean;
  /** 年を省く（表の列を狭くする。`11-28 08:34`） */
  readonly noYear?: boolean;
}

/** `2026-11-28 08:34`（seconds なら `:56` まで）。読めない値はそのまま返す */
export function formatTime(iso: string, timeZone: string, options: FormatTimeOptions = {}): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatterFor(timeZone).formatToParts(new Date(t));
  } catch {
    return iso;
  }
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const time = `${get("hour")}:${get("minute")}`;
  if (options.timeOnly) return `${time}:${get("second")}`;
  const date = options.noYear
    ? `${get("month")}-${get("day")}`
    : `${get("year")}-${get("month")}-${get("day")}`;
  return options.seconds ? `${date} ${time}:${get("second")}` : `${date} ${time}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "1秒未満";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}時間${m}分` : `${h}時間`;
  if (m > 0) return s > 0 ? `${m}分${s}秒` : `${m}分`;
  return `${s}秒`;
}
