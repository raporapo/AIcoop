/**
 * 設定の置き場所（home）と、そこから読む小さなもの（タイムゾーン）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CliContext } from "./context.ts";
import { CliError, UsageError } from "./errors.ts";
import { EXIT } from "./exit-codes.ts";

/** `--home`、なければ環境変数 `AICOOP_HOME`、なければ `~/.aicoop`（resolveAicoopHome） */
export async function resolveHome(ctx: CliContext, flag: string | undefined): Promise<string> {
  const { resolveAicoopHome } = await import("@aicoop/daemon");
  if (flag === undefined) return resolveAicoopHome(ctx.env, ctx.userHome);
  const { expandHome } = await import("@aicoop/shared");
  const trimmed = flag.trim();
  if (trimmed === "")
    throw new UsageError("--home の値が空です", ["--home <dir> の形で書いてください"]);
  return resolve(ctx.cwd, expandHome(trimmed, ctx.userHome));
}

export function isInitialized(home: string): boolean {
  return existsSync(join(home, "aicoop.yaml"));
}

/** aicoop init が済んでいなければ止める */
export function requireInitialized(home: string): void {
  if (isInitialized(home)) return;
  throw new CliError(EXIT.failure, `設定がありません（${home} に aicoop.yaml がありません）`, [
    "aicoop init で作ってください",
    "別の場所にあるなら --home <dir> か、環境変数 AICOOP_HOME で指定します",
  ]);
}

/** 6.2 の timezone の既定 */
export const DEFAULT_TIMEZONE = "Asia/Tokyo";

/**
 * 表示に使うタイムゾーン（7.1）。aicoop.yaml の timezone を読む。
 * 読めない・書いていない・正しくない値なら、6.2 の既定（Asia/Tokyo）。表示にだけ使うので、検証は aicoop check に任せる。
 */
export async function readTimezone(home: string): Promise<string> {
  let tz: unknown;
  try {
    const doc: unknown = parseYaml(readFileSync(join(home, "aicoop.yaml"), "utf8"));
    tz =
      typeof doc === "object" && doc !== null
        ? (doc as { timezone?: unknown }).timezone
        : undefined;
  } catch {
    return DEFAULT_TIMEZONE;
  }
  if (typeof tz !== "string") return DEFAULT_TIMEZONE;
  const { isIanaTimeZone } = await import("@aicoop/shared");
  return isIanaTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
}

/** 表示用に、ホームディレクトリの中なら ~ で短くする */
export function shortPath(path: string, userHome: string): string {
  const home = resolve(userHome);
  const p = resolve(path);
  if (p === home) return "~";
  return p.startsWith(home + sep) ? `~${sep}${p.slice(home.length + 1)}` : p;
}
