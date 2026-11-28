/**
 * `aicoop start`（9.1）：`aicoop daemon --background` を裏で起こし、API が応答するまで待つ。
 *
 * - すでに動いていれば、何もしない（終了コード 0）
 * - 設定にエラーがあれば、起こす前に止める（daemon も起動しないので、先に分かりやすく出す）
 * - 起こした daemon の標準出力・標準エラー（ログが始まる前の失敗）は logs/daemon-console.log に書く
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { aicoopPaths, type DaemonInfo } from "@aicoop/daemon";
import { type ConfigIssue, loadConfig } from "@aicoop/shared";
import { probeDaemon, readDaemonInfo } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import type { CliContext } from "../context.ts";
import { CliError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { isInitialized, requireInitialized, shortPath } from "../home.ts";
import { renderIssues } from "../ui/issues.ts";
import { createPrinter, type Printer } from "../ui/printer.ts";
import { cleanLine } from "../ui/text.ts";
import { DAEMON_MISSING, DAEMON_MISSING_HINTS } from "./daemon-entry.ts";

const POLL_MS = 200;
/** 起動を待つ長さ（POLL_MS の回数で数える） */
export const START_WAIT_TICKS = 150;
export const CONSOLE_LOG = "daemon-console.log";

function tailOf(path: string, lines: number): string[] {
  try {
    return readFileSync(path, "utf8")
      .replace(/\n+$/, "")
      .split("\n")
      .slice(-lines)
      .map((l) => cleanLine(l));
  } catch {
    return [];
  }
}

/** 設定にエラーがあるので起動しない（start は issues を並べ、open はまとめて見せる） */
export class ConfigInvalidError extends CliError {
  override name = "ConfigInvalidError";
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[], hints: readonly string[]) {
    super(EXIT.failure, "設定にエラーがあるので、制御サーバーを起動しません", hints);
    this.issues = issues;
  }
}

export interface LaunchInput {
  readonly home: string;
  readonly ctx: CliContext;
  /** 進み具合（「起動しています…」）を出す先 */
  readonly err: Printer;
}

/**
 * 動いていない制御サーバーを裏で起こし、API が応答するまで待つ（`aicoop start`・`aicoop open`）。
 * 起動できなければ CliError（設定のエラーは ConfigInvalidError）
 */
export async function launchDaemon({ home, ctx, err }: LaunchInput): Promise<DaemonInfo> {
  const paths = aicoopPaths(home);
  const config = loadConfig(home, { now: ctx.deps.now() });
  if (!config.ok) {
    throw new ConfigInvalidError(config.issues, [
      ...renderIssues(config.issues, err.style),
      "直したら、aicoop check で確かめてください",
    ]);
  }
  if ((await ctx.deps.loadDaemonEntry()) === null) {
    throw new CliError(EXIT.failure, DAEMON_MISSING, DAEMON_MISSING_HINTS);
  }

  const logFile = join(paths.logsDir, CONSOLE_LOG);
  const child = ctx.deps.spawnDaemon(home, logFile);
  let exitCode: number | null | undefined;
  void child.exited.then((code) => {
    exitCode = code;
  });
  err.line("制御サーバーを起動しています…");

  for (let tick = 0; tick < START_WAIT_TICKS; tick++) {
    await ctx.deps.sleep(POLL_MS);
    if (exitCode !== undefined) {
      throw new CliError(
        EXIT.failure,
        `制御サーバーが、起動してすぐに終わりました${exitCode === null ? "" : `（終了コード ${exitCode}）`}`,
        [...tailOf(logFile, 12).map((l) => `| ${l}`), `ログ：${shortPath(logFile, ctx.userHome)}`],
      );
    }
    const info = readDaemonInfo(home);
    if (info === null || info.pid !== child.pid) continue;
    const ready = await probeDaemon(ctx, home, 1000);
    if (!ready.running) continue;
    return info;
  }
  throw new CliError(
    EXIT.failure,
    `${Math.round((START_WAIT_TICKS * POLL_MS) / 1000)}秒待っても、制御サーバーが応答しません（pid ${child.pid}）`,
    [`ログを確かめてください：${shortPath(logFile, ctx.userHome)}`, "止めるなら：aicoop stop"],
  );
}

export const AUTOSTART_LOG = "autostart.log";

/**
 * `--autostart`（Windows のログオン時の自動起動。5.14 の1）：設定（aicoop.yaml）がなければ何もせず、
 * 動いていれば何もしない。そうでなければ起動し、時刻と結果を logs/autostart.log に足す（標準出力にも出す）
 */
async function autostart(input: CommandInput): Promise<number> {
  const { home, ctx } = input;
  if (!isInitialized(home)) return EXIT.ok;
  if ((await probeDaemon(ctx, home)).running) return EXIT.ok;

  const logsDir = aicoopPaths(home).logsDir;
  mkdirSync(logsDir, { recursive: true });
  const logFile = join(logsDir, AUTOSTART_LOG);
  const log = createPrinter(
    {
      isTTY: false,
      write: (text) => {
        appendFileSync(logFile, text, { mode: 0o600 });
        ctx.stdout.write(text);
      },
    },
    false,
  );
  log.line(`== ${ctx.deps.now().toISOString()} 自動起動`);
  try {
    return await startOnce({ ...input, out: log, err: log });
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    log.line(`エラー：${e.headline}`);
    for (const hint of e.hints) log.line(`  ${hint}`);
    return e.exitCode;
  }
}

export async function run(input: CommandInput): Promise<number> {
  if (input.values.autostart === true) return autostart(input);
  return startOnce(input);
}

async function startOnce(input: CommandInput): Promise<number> {
  const { home, out, err, ctx } = input;
  requireInitialized(home);
  const paths = aicoopPaths(home);
  const style = out.style;

  const probe = await probeDaemon(ctx, home);
  if (probe.running) {
    const { info } = probe.client;
    out.line(`制御サーバーはすでに動いています（http://127.0.0.1:${info.port}、pid ${info.pid}）`);
    return EXIT.ok;
  }

  let info: DaemonInfo;
  try {
    info = await launchDaemon({ home, ctx, err });
  } catch (e) {
    if (!(e instanceof ConfigInvalidError)) throw e;
    err.line(`${err.style.red("設定にエラーがあるので、起動しません。")}`);
    err.line("");
    err.lines(renderIssues(e.issues, err.style));
    err.line("");
    err.line("直したら、aicoop check で確かめてから、もう一度 aicoop start してください。");
    return EXIT.failure;
  }
  out.line(
    `${style.green("✓")} 制御サーバーを起動しました（http://127.0.0.1:${info.port}、pid ${info.pid}）`,
  );
  if (ctx.platform === "win32") {
    out.line(
      `    ${style.yellow("注意：")}Windows では vm の箱が動かないので、vm の部署のタスクは失敗します。WSL2 の中で動かしてください`,
    );
  }
  out.line(`    ログ      ${shortPath(paths.logsDir, ctx.userHome)}`);
  out.line(`    様子を見る  ${style.cyan("aicoop status")}　止める  ${style.cyan("aicoop stop")}`);
  return EXIT.ok;
}
