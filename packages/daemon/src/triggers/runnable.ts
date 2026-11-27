/**
 * いまの daemon でタスクを作って動かせる社員か（API の `POST /tasks` と、cron トリガーで同じ判定をする）。
 *
 * 動かせるのは、AI の社員で、その社員が動く部署（部長は役員室。5.1.1）の箱の種類に
 * ドライバーがあるものだけ。P1 のドライバーは `vm` だけなので、`srt`（P4）・`none`（CEO、P4）・
 * 人間の社員（P6）・設定にいない社員は、日本語の理由をつけて断る。
 */
import { type CompanyConfig, type ResolvedMember, resolveMember } from "@aicoop/shared";
import type { BoxDrivers } from "../run/types.ts";

export type RunnableCheck =
  | { readonly ok: true; readonly member: ResolvedMember }
  | { readonly ok: false; readonly message: string };

export function checkRunnableMember(
  config: CompanyConfig,
  memberId: string,
  drivers: BoxDrivers,
): RunnableCheck {
  const configured = Object.hasOwn(config.members, memberId) ? config.members[memberId] : undefined;
  if (configured === undefined) {
    return { ok: false, message: `社員「${memberId}」は members.yaml にいません` };
  }
  if (configured.kind !== "ai") {
    return {
      ok: false,
      message: `「${memberId}」は人間の社員なので、タスクを作れません（人宛ての依頼は P6 から）`,
    };
  }
  const member = resolveMember(config, memberId);
  if (member === undefined) {
    return { ok: false, message: `社員「${memberId}」の部署か役職が、設定にありません` };
  }
  const box = member.group.box;
  if (box === "none") {
    return {
      ok: false,
      message: `社員「${memberId}」は CEO（箱の外で動く部署「${member.group.id}」）なので、まだ動かせません（CEO は P4 から）`,
    };
  }
  if (!Object.hasOwn(drivers, box) || drivers[box] === undefined) {
    return {
      ok: false,
      message: `社員「${memberId}」の部署「${member.group.id}」の箱（${box}）は、この daemon ではまだ動かせません（いま動かせる箱：${
        Object.keys(drivers).join("・") || "なし"
      }）`,
    };
  }
  return { ok: true, member };
}
