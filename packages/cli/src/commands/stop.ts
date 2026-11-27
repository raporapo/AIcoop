/**
 * `aicoop stop`（9.1）：POST /shutdown で止め、止まるまで待つ。
 *
 * 「止まった」は、API が応答しなくなり、daemon.json のプロセスがいなくなったこと。
 * 動いていなければ何もしない（終了コード 0）。
 */
import type { ShutdownResponse } from "@aicoop/daemon";
import { apiFailure, probeDaemon } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { CliError, DaemonUnavailableError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { interruption } from "./common.ts";

const POLL_MS = 500;
/** API が止まるまで（動いている実行を止めるのを待つ。POLL_MS の回数） */
export const STOP_WAIT_TICKS = 240;
/** API が止まってから、プロセスが終わるまで */
export const EXIT_WAIT_TICKS = 30;

export async function run(input: CommandInput): Promise<number> {
  const { home, out, err, ctx } = input;
  const probe = await probeDaemon(ctx, home);
  if (!probe.running) {
    out.line("制御サーバーは動いていません");
    return EXIT.ok;
  }
  const { info } = probe.client;
  try {
    await probe.client.post<ShutdownResponse>("/shutdown", {}, { timeoutMs: 10_000 });
  } catch (e) {
    // 受け取ってすぐに切れたなら、止まり始めている
    if (!(e instanceof DaemonUnavailableError)) throw apiFailure(e, home);
  }
  err.line("止めています…（動いている実行を止めてから終わります）");

  const stop = interruption(ctx);
  try {
    let apiDown = false;
    for (let tick = 0; tick < STOP_WAIT_TICKS && !apiDown; tick++) {
      apiDown = !(await probeDaemon(ctx, home, 1000)).running;
      if (apiDown) break;
      await stop.sleep(POLL_MS);
      if (stop.interrupted) {
        err.line(
          "待つのをやめました（制御サーバーは止まる途中です。aicoop status で確かめられます）",
        );
        return EXIT.interrupted;
      }
    }
    if (!apiDown) {
      throw new CliError(EXIT.failure, `制御サーバーが止まりません（pid ${info.pid}）`, [
        "動いている実行の後片付けに時間がかかっているのかもしれません。しばらくして aicoop status で確かめてください",
      ]);
    }
    for (let tick = 0; tick < EXIT_WAIT_TICKS && ctx.deps.isProcessAlive(info.pid); tick++) {
      await stop.sleep(POLL_MS);
      if (stop.interrupted) return EXIT.interrupted;
    }
    if (ctx.deps.isProcessAlive(info.pid)) {
      throw new CliError(
        EXIT.failure,
        `API は止まりましたが、プロセス（pid ${info.pid}）がまだ残っています`,
        ["しばらくしても残るなら、OS の機能（kill など）で止めてください"],
      );
    }
  } finally {
    stop.dispose();
  }
  out.line(`${out.style.green("✓")} 制御サーバーを止めました`);
  return EXIT.ok;
}
