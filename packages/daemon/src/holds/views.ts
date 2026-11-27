/**
 * 保留・一時権限を、API（9.2 の `GET /holds`・`GET /holds/{id}`・`GET /grants`）と承認アプリに見せる形にする。
 *
 * 承認アプリに表示する要約（`summary`）は、承認の署名の `summary_sha256` のもとになる（5.8 の3）。
 * `ApprovalTarget.describe`（`targets.ts`）と API は、ここの同じ関数で要約を作る。
 */
import { readFileSync } from "node:fs";
import type { GrantView, HoldDetailView, HoldView } from "@aicoop/shared/api";
import { type Grant, grantParams } from "../db/grants.ts";
import { type Hold, holdParams, holdSummary } from "../db/holds.ts";
import type { AicoopPaths } from "../paths.ts";
import { readHoldFile } from "./hold-file.ts";
import type { GrantSummary } from "./render.ts";
import { bodyHead, decodeUtf8 } from "./text.ts";

/** HoldDetailView.request の本文の先頭（256 KiB） */
export const DETAIL_BODY_BYTES = 256 * 1024;
/** HoldDetailView.response_text（64 KiB） */
export const DETAIL_RESPONSE_BYTES = 64 * 1024;

/** 承認アプリに見せる保留の要約：作ったときの要約に、部長のコメントを添える */
export function holdApprovalSummary(hold: Hold): unknown {
  const stored = holdSummary(hold);
  const base =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : { stored };
  return { ...base, manager_comment: hold.managerComment };
}

/** 承認アプリに見せる一時権限の要約（誰が・何の操作を・どのパラメーターで・何時間・理由。5.7.3 の2） */
export function grantSummaryOf(grant: Grant): GrantSummary {
  return {
    kind: "grant",
    member_id: grant.memberId,
    operation: `${grant.service}.${grant.operation}`,
    params: grantParams(grant) ?? {},
    mode: grant.mode,
    duration_hours: grant.durationHours,
    reason: grant.reason,
    manager_comment: grant.managerComment,
  };
}

export function toHoldView(hold: Hold): HoldView {
  return {
    id: hold.id,
    task_id: hold.taskId,
    member_id: hold.memberId,
    group_id: hold.groupId,
    operation: `${hold.service}.${hold.operation}`,
    status: hold.status,
    summary: holdApprovalSummary(hold),
    created_at: hold.createdAt,
    expires_at: hold.expiresAt,
  };
}

/** 5.7.1 の4：元のリクエスト全体を展開して見せる（認証のヘッダーは保存していない） */
export function toHoldDetailView(hold: Hold, paths: AicoopPaths): HoldDetailView {
  let request: HoldDetailView["request"];
  try {
    const saved = readHoldFile(readFileSync(paths.holdFile(hold.id)));
    const head = bodyHead(saved.body, DETAIL_BODY_BYTES);
    request = {
      method: saved.method,
      url: saved.url,
      headers: saved.headers,
      body_bytes: saved.body.byteLength,
      body_text: head.text,
      body_base64: head.base64,
      truncated: head.truncated,
    };
  } catch {
    // ファイルが読めない（消えた・壊れた）。記録の分だけ見せる
    request = {
      method: "",
      url: "",
      headers: {},
      body_bytes: hold.requestBytes,
      body_text: null,
      body_base64: null,
      truncated: false,
    };
  }
  return {
    ...toHoldView(hold),
    thread: hold.thread,
    service: hold.service,
    params: holdParams(hold) ?? {},
    manager_comment: hold.managerComment,
    decided_at: hold.decidedAt,
    decided_by: hold.decidedBy,
    response_status: hold.responseStatus,
    request,
    response_text: readResponseText(hold, paths, DETAIL_RESPONSE_BYTES),
  };
}

/** 再送の結果の本文の先頭を、UTF-8 として読めれば返す */
export function readResponseText(hold: Hold, paths: AicoopPaths, maxBytes: number): string | null {
  if (hold.responsePath === null) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(paths.holdResponseFile(hold.id));
  } catch {
    return null;
  }
  const truncated = bytes.byteLength > maxBytes;
  return decodeUtf8(bytes.subarray(0, Math.min(bytes.byteLength, maxBytes)), truncated);
}

export function toGrantView(grant: Grant): GrantView {
  return {
    id: grant.id,
    member_id: grant.memberId,
    operation: `${grant.service}.${grant.operation}`,
    params: grantParams(grant) ?? {},
    mode: grant.mode,
    reason: grant.reason,
    duration_hours: grant.durationHours,
    status: grant.status,
    created_at: grant.createdAt,
    starts_at: grant.startsAt,
    expires_at: grant.expiresAt,
    decided_by: grant.decidedBy,
    manager_comment: grant.managerComment,
    summary: grantSummaryOf(grant),
  };
}
