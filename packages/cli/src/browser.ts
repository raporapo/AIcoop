/**
 * 既定のブラウザで URL を開くコマンド（5.14 の1）。
 *
 * - macOS：`open`
 * - WSL（/proc/version に microsoft）：`wslview`（wslu）。なければ開かない（URL を出すだけ）
 * - Linux：`xdg-open`
 * - そのほか（Windows で直接動かしたときなど）：開かない
 *
 * シェルは通さず、URL は引数1つとして渡す。
 */
import type { CliContext } from "./context.ts";

export function browserCommand(ctx: CliContext, url: string): string[] | null {
  const { deps, platform } = ctx;
  if (platform === "darwin") return deps.which("open") === null ? null : ["open", url];
  if (platform !== "linux") return null;
  if (deps.isWsl()) return deps.which("wslview") === null ? null : ["wslview", url];
  return deps.which("xdg-open") === null ? null : ["xdg-open", url];
}

/** 開けたら true。開けなくても投げない（URL を出してあるので、失敗にしない） */
export async function openInBrowser(ctx: CliContext, url: string): Promise<boolean> {
  const argv = browserCommand(ctx, url);
  if (argv === null) return false;
  try {
    return await ctx.deps.launchDetached(argv);
  } catch {
    return false;
  }
}
