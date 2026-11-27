/**
 * 制御サーバーの本体（`@aicoop/daemon` の `startDaemon`）と、1件の実行（`startRun`）をつなぐ、ただ1つの場所。
 *
 * いま（P1 の途中）の main には、どちらもまだ入っていない（担当E・担当Dが作っている）。
 * 型チェックを通すために、ここだけに仮の型を置き、実行時に `@aicoop/daemon` から名前で取り出す。
 * 入っていなければ null を返し、`aicoop daemon` は「まだ入っていない」と知らせて止まる。
 *
 * TODO（E・D のマージ後）：仮の型を `@aicoop/daemon` の本物の型に置き換え、
 * `import { startDaemon, startRun } from "@aicoop/daemon"` で読み込む。
 */
import type { BoxDrivers, DaemonInfo, StartRun } from "@aicoop/daemon";
import type { ConfigIssue } from "@aicoop/shared";

// ---- 仮の型（E の startDaemon の約束に合わせたもの） ----

export interface StartDaemonOptions {
  readonly home: string;
  readonly startRun: StartRun;
  readonly drivers?: BoxDrivers;
  /** true なら、ログを標準出力に書く（aicoop daemon を前面で動かすとき） */
  readonly logToStdout?: boolean;
}

export interface DaemonHandle {
  readonly port: number;
  readonly info: DaemonInfo;
  /** 動いている実行を止めてから終わる */
  stop(): Promise<void>;
  /** 止まったら解決する（POST /shutdown で止まったときも） */
  readonly stopped: Promise<void>;
}

/** 設定にエラーがあれば、`issues` を持つエラーを投げる */
export type StartDaemon = (options: StartDaemonOptions) => Promise<DaemonHandle>;

export interface DaemonEntry {
  readonly startDaemon: StartDaemon;
  readonly startRun: StartRun;
}

export async function loadDaemonEntry(): Promise<DaemonEntry | null> {
  const mod = (await import("@aicoop/daemon")) as unknown as Record<string, unknown>;
  const { startDaemon, startRun } = mod;
  if (typeof startDaemon !== "function" || typeof startRun !== "function") return null;
  return { startDaemon: startDaemon as StartDaemon, startRun: startRun as StartRun };
}

/** startDaemon が投げた「設定にエラーがある」の issues を取り出す */
export function configIssuesOf(error: unknown): readonly ConfigIssue[] | undefined {
  if (typeof error !== "object" || error === null || !("issues" in error)) return undefined;
  const issues = (error as { issues: unknown }).issues;
  return Array.isArray(issues) ? (issues as ConfigIssue[]) : undefined;
}
