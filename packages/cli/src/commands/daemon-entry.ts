/**
 * 制御サーバーの本体（`@aicoop/daemon` の `startDaemon`）と、1件の実行（`startRun`）をつなぐ、ただ1つの場所。
 *
 * テストでは `CliDeps.loadDaemonEntry` を差し替えて、偽物の本体を使う。
 * シグナル（Ctrl+C）は CLI が受けて `stop()` を呼ぶので、`startDaemon` の `handleSignals` は使わない。
 */
import type { DaemonHandle, StartDaemonOptions, StartRun } from "@aicoop/daemon";
import type { ConfigIssue } from "@aicoop/shared";

export type { DaemonHandle, StartDaemonOptions };

/** 設定にエラーがあれば、`issues` を持つ `DaemonStartError` を投げる */
export type StartDaemon = (options: StartDaemonOptions) => Promise<DaemonHandle>;

export interface DaemonEntry {
  readonly startDaemon: StartDaemon;
  readonly startRun: StartRun;
}

/** 本体を読み込めなかったときの知らせ（aicoop daemon・aicoop start） */
export const DAEMON_MISSING = "制御サーバーの本体を読み込めませんでした";
export const DAEMON_MISSING_HINTS: readonly string[] = [
  "リポジトリの直下で pnpm install を実行してから、もう一度試してください",
];

export async function loadDaemonEntry(): Promise<DaemonEntry | null> {
  try {
    const { startDaemon, startRun } = await import("@aicoop/daemon");
    return { startDaemon, startRun };
  } catch {
    return null;
  }
}

/** startDaemon が投げた「設定にエラーがある」の issues を取り出す */
export function configIssuesOf(error: unknown): readonly ConfigIssue[] | undefined {
  if (typeof error !== "object" || error === null || !("issues" in error)) return undefined;
  const issues = (error as { issues: unknown }).issues;
  return Array.isArray(issues) && issues.length > 0 ? (issues as ConfigIssue[]) : undefined;
}
