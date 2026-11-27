/**
 * 制御サーバーのログ（11.5）。
 *
 * - pino の JSON を `logs/daemon-YYYY-MM-DD.log`（`aicoop.yaml` の timezone の日付）に書き、日付が変わったら次のファイルにする
 * - `stdout` を渡すと、標準出力にも人が読める形で出す（`aicoop daemon` を前面で動かすとき）
 * - 本物の資格はどのログにも書かない。資格の入りうるキー（authorization・token・secret など）は値を伏せ、
 *   書き出す直前の文字列からも、仮の札（`GONDOLIN_SECRET_****`）・Bearer の値・GitHub のトークンの形・
 *   `addSecret` で渡した値（ローカルAPI のトークンなど）を伏せる
 * - 30日を過ぎたログ（daemon のログと `logs/runs/*.jsonl`）は `pruneOldLogs` で消す
 */
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { type Logger, pino } from "pino";

/** ログを残す日数（11.5） */
export const LOG_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const CENSOR = "****";

/** 値を伏せるキー（1段目と2段目） */
const SECRET_KEYS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "token",
  "api_token",
  "apiToken",
  "access_token",
  "password",
  "secret",
  "secrets",
];
const REDACT_PATHS = SECRET_KEYS.flatMap((k) => {
  const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `["${k}"]`;
  return [key, `*.${key}`.replace('*.["', '*["')];
});

/** 書き出す直前に伏せる形（資格の取り違えで、キー以外のところに混ざったときのため） */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/GONDOLIN_SECRET_[A-Za-z0-9_]+/g, `GONDOLIN_SECRET_${CENSOR}`],
  [/\b(Bearer|Basic|token)(\s+)[A-Za-z0-9._~+/=-]+/gi, `$1$2${CENSOR}`],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, CENSOR],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, CENSOR],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, CENSOR],
];

/** 文字列の中の仮の札・Bearer の値・トークンの形を伏せ字にする */
export function maskSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function parts(date: Date, timezone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

/** `timezone` での日付（`YYYY-MM-DD`） */
export function localDate(date: Date, timezone: string): string {
  const p = parts(date, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

function localDateTime(date: Date, timezone: string): string {
  const p = parts(date, timezone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

export interface LineStream {
  write(line: string): unknown;
}

/** 日付ごとのファイルに追記する（同期で書く。0600） */
function dailyFileStream(dir: string, timezone: string, now: () => Date) {
  let date = "";
  let fd: number | null = null;
  let closed = false;
  const closeFile = () => {
    if (fd !== null) closeSync(fd);
    fd = null;
  };
  const close = () => {
    closed = true;
    closeFile();
  };
  return {
    write(line: string) {
      // 閉じたあと（daemon を止めたあと）に来た行は書かない
      if (closed) return;
      const today = localDate(now(), timezone);
      if (fd === null || today !== date) {
        closeFile();
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `daemon-${today}.log`);
        fd = openSync(path, "a", 0o600);
        if (process.platform !== "win32") chmodSync(path, 0o600);
        date = today;
      }
      writeSync(fd, line);
    },
    close,
  };
}

const LEVEL_LABELS: Readonly<Record<number, string>> = {
  10: "詳細",
  20: "デバッグ",
  30: "情報",
  40: "警告",
  50: "エラー",
  60: "致命的",
};
const HIDDEN_KEYS = new Set(["level", "time", "pid", "hostname", "msg"]);

function formatValue(key: string, value: unknown): string {
  if (key === "err" && typeof value === "object" && value !== null && "message" in value) {
    return JSON.stringify(String((value as { message: unknown }).message));
  }
  if (typeof value === "string") return /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
  return JSON.stringify(value);
}

/** 人が読める1行：`2026-11-28 23:30:00 警告 文 key=value ...` */
function prettyStream(out: LineStream, timezone: string): LineStream {
  return {
    write(line: string) {
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        out.write(line);
        return;
      }
      const time = typeof entry.time === "string" ? new Date(entry.time) : new Date();
      const level = LEVEL_LABELS[Number(entry.level)] ?? String(entry.level);
      const extras = Object.entries(entry)
        .filter(([k]) => !HIDDEN_KEYS.has(k))
        .map(([k, v]) => `${k}=${formatValue(k, v)}`);
      const head = `${localDateTime(time, timezone)} ${level} ${String(entry.msg ?? "")}`;
      out.write(`${[head, ...extras].join(" ")}\n`);
    },
  };
}

export interface DaemonLoggerOptions {
  readonly logsDir: string;
  /** 日付の区切りと、標準出力の時刻（aicoop.yaml の timezone） */
  readonly timezone: string;
  readonly now?: () => Date;
  /** 標準出力にも出す。true なら process.stdout */
  readonly stdout?: boolean | LineStream;
  readonly level?: string;
}

export interface DaemonLogger {
  readonly logger: Logger;
  /** ログに出たら伏せる値（ローカルAPI のトークンなど） */
  addSecret(value: string): void;
  close(): void;
}

export function createDaemonLogger(opts: DaemonLoggerOptions): DaemonLogger {
  const now = opts.now ?? (() => new Date());
  const level = opts.level ?? "info";
  const secrets = new Set<string>();
  const file = dailyFileStream(opts.logsDir, opts.timezone, now);
  const streams: Array<{ level: string; stream: LineStream }> = [{ level, stream: file }];
  if (opts.stdout) {
    const out: LineStream =
      opts.stdout === true ? { write: (s: string) => process.stdout.write(s) } : opts.stdout;
    streams.push({ level, stream: prettyStream(out, opts.timezone) });
  }

  const logger = pino(
    {
      level,
      base: { pid: process.pid },
      timestamp: () => `,"time":"${now().toISOString()}"`,
      redact: { paths: REDACT_PATHS, censor: CENSOR },
      hooks: {
        streamWrite(line) {
          let out = maskSecrets(line);
          for (const secret of secrets) out = out.replaceAll(secret, CENSOR);
          return out;
        },
      },
    },
    pino.multistream(streams as Parameters<typeof pino.multistream>[0]),
  );

  return {
    logger,
    addSecret(value) {
      if (value.length >= 8) secrets.add(value);
    },
    close() {
      file.close();
    },
  };
}

/**
 * 11.5：30日を過ぎたログを消す。
 * - `logs/daemon-YYYY-MM-DD.log`：ファイル名の日付が、timezone で今日から30日より前
 * - `logs/runs/*.jsonl`：最後に書いた時刻が30日より前
 * ほかのファイル・フォルダ・シンボリックリンクには触らない。消せなかったものは飛ばす。
 */
export function pruneOldLogs(opts: {
  readonly logsDir: string;
  readonly runLogsDir: string;
  readonly timezone: string;
  readonly now: Date;
  readonly retentionDays?: number;
}): { deleted: string[] } {
  const days = opts.retentionDays ?? LOG_RETENTION_DAYS;
  const cutoffMs = opts.now.getTime() - days * DAY_MS;
  const cutoffDate = localDate(new Date(cutoffMs), opts.timezone);
  const deleted: string[] = [];

  const remove = (path: string) => {
    try {
      unlinkSync(path);
      deleted.push(path);
    } catch {
      // 消せなかったものは、次の機会に
    }
  };

  for (const entry of listFiles(opts.logsDir)) {
    const m = /^daemon-(\d{4}-\d{2}-\d{2})\.log$/.exec(entry);
    if (m && (m[1] as string) < cutoffDate) remove(join(opts.logsDir, entry));
  }
  for (const entry of listFiles(opts.runLogsDir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(opts.runLogsDir, entry);
    try {
      if (statSync(path).mtimeMs < cutoffMs) remove(path);
    } catch {
      // 読めないものは飛ばす
    }
  }
  return { deleted };
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
