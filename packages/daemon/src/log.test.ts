import { mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemonLogger, localDate, maskSecrets, pruneOldLogs } from "./log.ts";
import { type ManualClock, manualClock } from "./testing/manual-clock.ts";
import { type TempDir, tempDir } from "./testing/state-db.ts";

let dir: TempDir;
let clock: ManualClock;
let logsDir: string;
let runLogsDir: string;

beforeEach(() => {
  dir = tempDir();
  // 2026-11-28 23:30 JST
  clock = manualClock("2026-11-28T14:30:00.000Z");
  logsDir = join(dir.path, "logs");
  runLogsDir = join(logsDir, "runs");
});

afterEach(() => dir.cleanup());

const lines = (file: string) =>
  readFileSync(join(logsDir, file), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("11.5：制御サーバーのログ", () => {
  it("pino の JSON で logs/daemon-YYYY-MM-DD.log に書き、日付（timezone）が変わったら次のファイルにする", () => {
    const { logger, close } = createDaemonLogger({
      logsDir,
      timezone: "Asia/Tokyo",
      now: clock.now,
    });
    logger.info({ task_id: "t_1" }, "一つ目");
    clock.advance(31 * 60_000); // 00:01 JST（翌日）
    logger.warn("二つ目");
    close();

    expect(readdirSync(logsDir).sort()).toEqual(["daemon-2026-11-28.log", "daemon-2026-11-29.log"]);
    expect(lines("daemon-2026-11-28.log")).toEqual([
      expect.objectContaining({
        level: 30,
        msg: "一つ目",
        task_id: "t_1",
        time: "2026-11-28T14:30:00.000Z",
      }),
    ]);
    expect(lines("daemon-2026-11-29.log")).toEqual([
      expect.objectContaining({ level: 40, msg: "二つ目" }),
    ]);
  });

  it.skipIf(process.platform === "win32")("ログのファイルは 0600", () => {
    const { logger, close } = createDaemonLogger({ logsDir, timezone: "UTC", now: clock.now });
    logger.info("x");
    close();
    expect(statSync(join(logsDir, "daemon-2026-11-28.log")).mode & 0o777).toBe(0o600);
  });

  it("11.5：本物の資格を書かない（authorization・token・secret のキー、Bearer、仮の札、GitHub のトークン、渡した秘密の値を伏せる）", () => {
    const apiToken = "Zq3vY8eXbN1sT6uW0aK4mP7rC2dF5gH9jL0nB3vX6z";
    const { logger, close, addSecret } = createDaemonLogger({
      logsDir,
      timezone: "UTC",
      now: clock.now,
    });
    addSecret(apiToken);
    logger.info(
      {
        headers: {
          authorization: "Bearer real-github-token-1234567890",
          "set-cookie": "sid=cookie-value-42",
        },
        token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        secret: { value: "super-secret-value" },
        request: { token: "nested-token-value" },
        note: `api ${apiToken} を使う`,
      },
      "仮の札 GONDOLIN_SECRET_0123456789abcdef0123456789abcdef0123456789abcdef と ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 と github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    );
    close();
    const text = readFileSync(join(logsDir, "daemon-2026-11-28.log"), "utf8");
    for (const secret of [
      "real-github-token-1234567890",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "super-secret-value",
      "nested-token-value",
      "cookie-value-42",
      apiToken,
      "0123456789abcdef0123456789abcdef0123456789abcdef",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("GONDOLIN_SECRET_****");
  });

  it("logToStdout なら、標準出力にも人が読める形（時刻・日本語の重さ・文・キー）で出す", () => {
    const out: string[] = [];
    const { logger, close } = createDaemonLogger({
      logsDir,
      timezone: "Asia/Tokyo",
      now: clock.now,
      stdout: { write: (s: string) => out.push(s) },
    });
    logger.warn({ task_id: "t_1", token: "secret-token-value" }, "タスクを始めました");
    close();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^2026-11-28 23:30:00 警告 タスクを始めました task_id=t_1/);
    expect(out[0]).not.toContain("secret-token-value");
    expect(out[0]?.endsWith("\n")).toBe(true);
  });

  it("閉じたあと（daemon を止めたあと）に来た行は書かない（ファイルを開き直さない）", () => {
    const { logger, close } = createDaemonLogger({ logsDir, timezone: "UTC", now: clock.now });
    logger.info("止める前");
    close();
    logger.info("止めたあと");
    clock.advance(24 * 3600_000);
    logger.info("次の日");
    expect(readdirSync(logsDir)).toEqual(["daemon-2026-11-28.log"]);
    expect(lines("daemon-2026-11-28.log").map((l) => l.msg)).toEqual(["止める前"]);
  });

  it("maskSecrets：仮の札と Bearer の値を伏せ字にする", () => {
    expect(maskSecrets("GONDOLIN_SECRET_abc123 Bearer xyz.789")).toBe(
      "GONDOLIN_SECRET_**** Bearer ****",
    );
  });

  it("localDate：timezone での日付", () => {
    expect(localDate(new Date("2026-11-28T15:00:00.000Z"), "Asia/Tokyo")).toBe("2026-11-29");
    expect(localDate(new Date("2026-11-28T15:00:00.000Z"), "UTC")).toBe("2026-11-28");
  });
});

describe("11.5：古いログを消す", () => {
  it("30日を過ぎた daemon のログと logs/runs/*.jsonl を消し、30日以内のもの・ほかのファイルは残す", () => {
    mkdirSync(runLogsDir, { recursive: true });
    for (const name of [
      "daemon-2026-10-28.log",
      "daemon-2026-10-29.log",
      "daemon-2026-11-28.log",
      "notes.txt",
    ]) {
      writeFileSync(join(logsDir, name), "x");
    }
    const old = join(runLogsDir, "r_01OLD.jsonl");
    const fresh = join(runLogsDir, "r_01NEW.jsonl");
    const oldOther = join(runLogsDir, "keep.txt");
    for (const p of [old, fresh, oldOther]) writeFileSync(p, "{}\n");
    const longAgo = new Date("2026-10-28T00:00:00.000Z");
    utimesSync(old, longAgo, longAgo);
    utimesSync(oldOther, longAgo, longAgo);

    const result = pruneOldLogs({ logsDir, runLogsDir, timezone: "Asia/Tokyo", now: clock.now() });
    expect([...result.deleted].sort()).toEqual(
      [join(logsDir, "daemon-2026-10-28.log"), join(runLogsDir, "r_01OLD.jsonl")].sort(),
    );
    expect(readdirSync(logsDir).sort()).toEqual([
      "daemon-2026-10-29.log",
      "daemon-2026-11-28.log",
      "notes.txt",
      "runs",
    ]);
    expect(readdirSync(runLogsDir).sort()).toEqual(["keep.txt", "r_01NEW.jsonl"]);
  });

  it("フォルダがなくても失敗しない", () => {
    expect(
      pruneOldLogs({ logsDir, runLogsDir, timezone: "UTC", now: clock.now() }).deleted,
    ).toEqual([]);
  });
});
