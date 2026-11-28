/**
 * 時刻の表し方。API は UTC の ISO 8601 を返す（9.2）。画面ではブラウザのタイムゾーンで、
 * 「3分後に期限」のように今からの近さで出す（5.8 の4）。
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** ISO 8601 を読む。読めなければ null（黙って今の時刻などにしない） */
export function parseTime(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || iso === "") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** 今からの近さ（「3分後」「2時間5分前」「3日後」） */
export function relativeTime(target: number, now: number): string {
  const diff = target - now;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "後" : "前";
  if (abs < MIN) return diff >= 0 ? "1分以内" : "たった今";
  if (abs < HOUR) {
    const m = Math.min(59, Math.round(abs / MIN));
    return `${m}分${suffix}`;
  }
  if (abs < 6 * HOUR) {
    let h = Math.floor(abs / HOUR);
    let m = Math.round((abs - h * HOUR) / MIN);
    if (m === 60) {
      h += 1;
      m = 0;
    }
    return m === 0 ? `${h}時間${suffix}` : `${h}時間${m}分${suffix}`;
  }
  if (abs < DAY) return `${Math.floor(abs / HOUR)}時間${suffix}`;
  return `${Math.floor(abs / DAY)}日${suffix}`;
}

export type DeadlineLevel = "past" | "urgent" | "soon" | "normal";

export interface Deadline {
  readonly text: string;
  /** past：過ぎた（読めない）、urgent：1時間を切った、soon：6時間を切った */
  readonly level: DeadlineLevel;
}

/** 期限の表し方。読めない期限は「過ぎた」とみなす（承認を押せないほうに倒す） */
export function deadline(iso: string | null | undefined, now: number): Deadline {
  const t = parseTime(iso);
  if (t === null) return { text: "期限を読めません", level: "past" };
  const diff = t - now;
  if (diff <= 0) return { text: `期限切れ（${relativeTime(t, now)}）`, level: "past" };
  const text = `${relativeTime(t, now)}に期限`;
  if (diff < HOUR) return { text, level: "urgent" };
  if (diff < 6 * HOUR) return { text, level: "soon" };
  return { text, level: "normal" };
}

export interface FormatOptions {
  readonly now: number;
  /** 既定はブラウザのタイムゾーン（テストで決めるときだけ渡す） */
  readonly timeZone?: string | undefined;
}

function parts(t: number, timeZone: string | undefined): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(t)) out[p.type] = p.value;
  return out;
}

/** 「11月28日(土) 12:04」。今と年が違えば「2025年1月2日(木) 00:00」 */
export function formatDateTime(iso: string | null | undefined, opts: FormatOptions): string {
  const t = parseTime(iso);
  if (t === null) return "（時刻を読めません）";
  const p = parts(t, opts.timeZone);
  const year = p.year !== parts(opts.now, opts.timeZone).year ? `${p.year}年` : "";
  return `${year}${p.month}月${p.day}日(${p.weekday}) ${p.hour}:${p.minute}`;
}

/** 「12:04:05」 */
export function formatClock(iso: string | null | undefined, opts: { timeZone?: string }): string {
  const t = parseTime(iso);
  if (t === null) return "（時刻を読めません）";
  const p = parts(t, opts.timeZone);
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** 残り時間（「1分52秒」） */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}分${r}秒` : `${r}秒`;
}
