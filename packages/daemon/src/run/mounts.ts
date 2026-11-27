/**
 * vm の箱のマウント（5.1.7 の2の表）と、箱の中のパス。
 *
 * 実行をまたいで残るのは、部署の作業フォルダと社員のホームだけ。
 * 実行ごとに作る設定・スキル・管理設定は読み取り専用にする（箱の中から書き換えさせない）。
 * ほかの部署の作業フォルダ・ほかの社員のホームはマウントしない（5.1.1、5.1.3 の3）。
 */
import type { Mount } from "@aicoop/shared";
import type { AicoopPaths } from "../paths.ts";

/** 箱の中のパス（5.1.7 の3：どの部署・どの社員でも同じ） */
export const GUEST_PATHS = {
  work: "/work",
  home: "/home/agent",
  etc: "/etc/aicoop",
  skills: "/home/agent/.claude/skills",
  managed: "/etc/claude-code",
  mcpConfig: "/etc/aicoop/mcp.json",
} as const;

export function vmMounts(
  paths: AicoopPaths,
  run: { readonly runId: string; readonly groupId: string; readonly memberId: string },
): Mount[] {
  return [
    { hostPath: paths.groupWork(run.groupId), guestPath: GUEST_PATHS.work, readOnly: false },
    { hostPath: paths.memberHome(run.memberId), guestPath: GUEST_PATHS.home, readOnly: false },
    { hostPath: paths.runEtc(run.runId), guestPath: GUEST_PATHS.etc, readOnly: true },
    { hostPath: paths.runSkills(run.runId), guestPath: GUEST_PATHS.skills, readOnly: true },
    { hostPath: paths.runManaged(run.runId), guestPath: GUEST_PATHS.managed, readOnly: true },
  ];
}
