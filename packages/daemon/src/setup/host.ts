/**
 * 準備の画面（5.14 の3）が見る、この PC のこと。daemon の既定（自分のプロセスの OS・PATH）。
 * `aicoop daemon` から起こしたときも同じものを使う（CLI の `which` と同じ探し方）。
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ReadinessHost } from "./readiness.ts";

/** PATH から実行ファイルを探す（見つからなければ null） */
export function which(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts =
    process.platform === "win32"
      ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())]
      : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // 次の候補へ
      }
    }
  }
  return null;
}

export function canAccess(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function defaultReadinessHost(now: () => Date): ReadinessHost {
  return {
    platform: process.platform,
    arch: process.arch,
    which: (command) => which(command),
    canAccess,
    now,
  };
}
