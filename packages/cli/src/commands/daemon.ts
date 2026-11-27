/**
 * `aicoop daemon`（9.1）：制御サーバーを前面で動かす。ログは標準出力に（`--background` なら logs/ に）。
 * Ctrl+C で止める（動いている実行を止めてから終わる）。もう一度 Ctrl+C で、待たずに終わる。
 *
 * 制御サーバーの本体は `daemon-entry.ts` の1か所から読み込む。
 */
import { existsSync } from "node:fs";
import { probeDaemon } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { CliError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { requireInitialized } from "../home.ts";
import { renderIssues } from "../ui/issues.ts";
import {
  configIssuesOf,
  DAEMON_MISSING,
  DAEMON_MISSING_HINTS,
  type DaemonHandle,
} from "./daemon-entry.ts";

export async function run(input: CommandInput): Promise<number> {
  const { home, values, err, ctx } = input;
  requireInitialized(home);
  const background = values.background === true;
  const style = err.style;

  const probe = await probeDaemon(ctx, home);
  if (probe.running) {
    const { info } = probe.client;
    throw new CliError(
      EXIT.failure,
      `制御サーバーはすでに動いています（ポート ${info.port}、pid ${info.pid}）`,
      ["止めるなら：aicoop stop"],
    );
  }

  const entry = await ctx.deps.loadDaemonEntry();
  if (entry === null) throw new CliError(EXIT.failure, DAEMON_MISSING, DAEMON_MISSING_HINTS);

  const drivers = await ctx.deps.createDrivers(home, ctx.platform);
  if (drivers.vm === undefined) {
    err.line(
      `${style.yellow("注意：")}この OS（${ctx.platform}）では vm の箱が動かないので、vm の部署のタスクは失敗します。WSL2 の中で動かしてください`,
    );
  } else {
    const { imageDir } = await import("@aicoop/box-gondolin");
    if (!existsSync(imageDir(home))) {
      err.line(
        `${style.yellow("注意：")}vm の箱のイメージがありません。先に aicoop image build を実行してください`,
      );
    }
  }

  let handle: DaemonHandle;
  try {
    handle = await entry.startDaemon({
      home,
      startRun: entry.startRun,
      drivers,
      logToStdout: !background,
    });
  } catch (e) {
    const issues = configIssuesOf(e);
    if (issues) {
      err.line(`${style.red("設定にエラーがあるので、起動しません。")}`);
      err.line("");
      err.lines(renderIssues(issues, style));
      err.line("");
      err.line("直したら、aicoop check で確かめてから起動してください。");
      return EXIT.failure;
    }
    throw new CliError(
      EXIT.failure,
      `制御サーバーを起動できませんでした：${e instanceof Error ? e.message : String(e)}`,
      ["ポートがほかのソフトと重なっていないか（aicoop.yaml の daemon.port）確かめてください"],
    );
  }

  err.line(
    `${style.green("✓")} 制御サーバーを起動しました（http://127.0.0.1:${handle.port}、pid ${handle.info.pid}）${background ? "" : "。Ctrl+C で止めます"}`,
  );

  let presses = 0;
  let onFirst: () => void = () => undefined;
  let onSecond: () => void = () => undefined;
  const firstPress = new Promise<"interrupt">((resolve) => {
    onFirst = () => resolve("interrupt");
  });
  const secondPress = new Promise<"force">((resolve) => {
    onSecond = () => resolve("force");
  });
  const off = ctx.deps.onInterrupt(() => {
    presses++;
    if (presses === 1) onFirst();
    else onSecond();
  });
  try {
    const why = await Promise.race([handle.stopped.then(() => "stopped" as const), firstPress]);
    if (why === "interrupt") {
      err.line(
        "止めています…（動いている実行を止めてから終わります。もう一度 Ctrl+C で、待たずに終わります）",
      );
      const done = await Promise.race([handle.stop().then(() => "stopped" as const), secondPress]);
      if (done === "force") {
        err.line(
          style.yellow(
            "待たずに終わります。動いていた箱は、次に起動したときに片付けます（設計書 8.6）",
          ),
        );
        return EXIT.interrupted;
      }
    }
    err.line("制御サーバーを止めました");
    return EXIT.ok;
  } finally {
    off();
  }
}
