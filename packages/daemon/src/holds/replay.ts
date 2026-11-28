/**
 * 保留の再送（5.2.6 の2・3、5.7.1 の5）。
 *
 * - オーナーが承認した（`approved`）保留を、保存したリクエストに本物の資格の認証ヘッダーを付けて、1回だけ送る。
 *   自動の再試行はしない。リダイレクトは追わない（3xx も結果として残す）
 * - 二重に送らない：送る前に `claimHoldReplay` で「送り始めた」印（response_path）を書き、書けた者だけが送る。
 *   daemon が送っている途中で落ちたら、送ったかどうか分からないので、起動のときに `replay_failed` にして
 *   送り直さない（`recoverReplays`）
 * - 資格は、そのとき発行し直す（実行のときのトークンは1時間で切れている）。範囲は、その操作とパラメーターだけ
 * - 送る直前に、いまの設定で、その社員がその操作をまだ使えるか（判定が allow か hold か）を確かめる。
 *   設定から外されていたら送らない（replay_failed）
 * - 結果（ステータスと、本文の先頭 1 MiB）を `response_status`・`state/holds/<id>.response.bin` に残し、
 *   2xx・3xx なら `replayed`、ほかは `replay_failed`
 * - 結果が出たら、トリガー `on_hold_resolved` があれば、その社員のタスクを作る
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { effectivePermissionsFor, evaluateRequest, resolveMember } from "@aicoop/shared";
import { activeGrantsFor } from "../db/grants.ts";
import {
  claimHoldReplay,
  getHold,
  type Hold,
  HoldStateError,
  holdParams,
  listHolds,
  transitionHold,
} from "../db/holds.ts";
import { writeTransaction } from "../db/open.ts";
import { PLACEHOLDER_MASK } from "../run/redact.ts";
import { issueForOperation } from "./credentials.ts";
import type { HoldDeps } from "./deps.ts";
import { readHoldFile, type SavedHoldRequest } from "./hold-file.ts";
import { createOnHoldResolvedTask } from "./resolved.ts";

/** 残す本文の上限（5.2.6 の3） */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** 外のサービスの応答を待つ時間 */
const REPLAY_TIMEOUT_MS = 60_000;

/** 送るときに外すヘッダー（つなぎ方のもの。fetch が付け直す） */
const HOP_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);

export interface ReplayOptions {
  readonly timeoutMs?: number;
}

/**
 * 5.2.6 の2：承認された保留を1回だけ送る。approved でない・ほかの者が送り始めていれば、何もせずに
 * いまの保留を返す。失敗も、保留の状態（replay_failed）として残し、例外にしない
 */
export async function replayHold(
  deps: HoldDeps,
  holdId: string,
  opts: ReplayOptions = {},
): Promise<Hold | undefined> {
  const hold = getHold(deps.db, holdId);
  if (hold === undefined || hold.status !== "approved") return hold;
  const responseFile = deps.paths.holdResponseFile(holdId);
  if (!claimHoldReplay(deps.db, holdId, responseFile)) return getHold(deps.db, holdId);
  const log = deps.logger?.child({ hold: holdId });

  const fail = (why: string, sent: { status: number | null; file: boolean }) => {
    log?.warn({ why, status: sent.status }, "保留の再送に失敗しました");
    return finish(deps, hold, "replay_failed", sent.status, sent.file ? responseFile : null);
  };

  // 1. 送るリクエストと、いまの設定での確かめ
  let saved: SavedHoldRequest;
  try {
    saved = readHoldFile(readFileSync(deps.paths.holdFile(holdId)));
  } catch {
    return fail("保存したリクエストを読めません", { status: null, file: false });
  }
  const config = deps.config();
  const checked = checkStillAllowed(deps, hold, saved);
  if (checked !== null) return fail(checked, { status: null, file: false });

  // 2. 資格をその場で発行する
  const issued = await issueForOperation({
    config,
    operationId: `${hold.service}.${hold.operation}`,
    params: holdParams(hold) ?? {},
    secretsPath: deps.paths.secrets,
    fetch: deps.fetch,
    now: deps.now(),
  });
  if (!issued.ok) return fail(issued.message, { status: null, file: false });

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(saved.headers)) {
    if (!HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  if (issued.credential !== null) {
    const { header, value } = issued.credential;
    const template =
      saved.auth !== null && saved.auth.header === header.toLowerCase()
        ? saved.auth.template
        : `Bearer ${PLACEHOLDER_MASK}`;
    headers[header] = template.replace(PLACEHOLDER_MASK, value);
  }

  // 3. 1回だけ送る
  const withBody = saved.method !== "GET" && saved.method !== "HEAD" && saved.body.byteLength > 0;
  let res: Response;
  try {
    res = await deps.fetch(saved.url, {
      method: saved.method,
      headers,
      ...(withBody && { body: saved.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs ?? REPLAY_TIMEOUT_MS),
    });
  } catch {
    // 届いたかどうか分からない。自動ではやり直さない
    return fail("外のサービスと通信できませんでした（届いたかは分かりません）", {
      status: null,
      file: false,
    });
  }

  // 4. 結果を残す
  let wrote = false;
  try {
    const body = await readHead(res, MAX_RESPONSE_BYTES);
    mkdirSync(deps.paths.holdsDir, { recursive: true });
    writeFileSync(responseFile, body, { mode: 0o600 });
    wrote = true;
  } catch {
    rmSync(responseFile, { force: true });
  }
  const ok = res.status >= 200 && res.status < 400;
  log?.info(
    { status: res.status },
    ok ? "保留を再送しました" : "保留を再送しましたが、失敗の応答でした",
  );
  return finish(
    deps,
    hold,
    ok ? "replayed" : "replay_failed",
    res.status,
    wrote ? responseFile : null,
  );
}

/** 送る直前の確かめ。送ってはいけない理由（日本語）か、null */
function checkStillAllowed(deps: HoldDeps, hold: Hold, saved: SavedHoldRequest): string | null {
  const config = deps.config();
  if (resolveMember(config, hold.memberId) === undefined) {
    return `社員 ${hold.memberId} が設定にいません`;
  }
  let url: URL;
  try {
    url = new URL(saved.url);
  } catch {
    return "保存した URL が読めません";
  }
  const service = config.services.find((s) => s.id === hold.service);
  if (url.port !== "" || (url.protocol !== "https:" && (service?.secret ?? null) !== null)) {
    return "資格を使うサービスへは、https の既定のポートでしか送りません";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "知らない scheme です";
  const effective = effectivePermissionsFor(config, hold.memberId, {
    grants: activeGrantsFor(deps.db, hold.memberId),
    now: deps.now(),
  });
  const result = evaluateRequest(config.catalog, effective, {
    method: saved.method,
    host: url.hostname.replace(/^\[|\]$/g, ""),
    path: `${url.pathname}${url.search}`,
  });
  if (result.decision === "deny") {
    return `いまの設定では、社員 ${hold.memberId} はこの操作を使えません（${result.reason}）`;
  }
  if (result.operation.id !== `${hold.service}.${hold.operation}`) {
    return "保存したリクエストが、保留の操作と食い違います";
  }
  return null;
}

async function readHead(res: Response, max: number): Promise<Uint8Array> {
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { value, done } = await reader.read();
      if (done) break;
      const room = max - total;
      chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
      total += Math.min(value.byteLength, room);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

function finish(
  deps: HoldDeps,
  hold: Hold,
  to: "replayed" | "replay_failed",
  responseStatus: number | null,
  responsePath: string | null,
): Hold | undefined {
  try {
    const after = writeTransaction(deps.db, () => {
      const changed = transitionHold(deps.db, hold.id, {
        from: ["approved"],
        to,
        by: "system",
        actor: "system",
        responseStatus,
        responsePath,
      });
      if (createOnHoldResolvedTask(deps, deps.config(), changed) !== null) deps.onTaskCreated?.();
      return changed;
    });
    return after;
  } catch (error) {
    if (error instanceof HoldStateError) return getHold(deps.db, hold.id);
    throw error;
  }
}

/**
 * daemon の起動のとき（8.6 の5 の続き）：
 * - 送り始めた印があるのに approved のままの保留（送っている途中で落ちた）は、送ったか分からないので
 *   replay_failed にする（送り直さない）
 * - 承認されたのに送り始めていない保留（承認の直後に落ちた）は、期限の内なら送る。過ぎていたら送らない
 */
export async function recoverReplays(deps: HoldDeps): Promise<void> {
  const now = deps.now().getTime();
  const pending: Promise<unknown>[] = [];
  for (const hold of listHolds(deps.db, { statuses: ["approved"], limit: 10_000 })) {
    if (hold.responsePath !== null) {
      deps.logger?.warn(
        { hold: hold.id },
        "保留を送っている途中で制御サーバーが止まりました。届いたかが分からないので、送り直しません",
      );
      const sentFile = (() => {
        try {
          readFileSync(deps.paths.holdResponseFile(hold.id));
          return true;
        } catch {
          return false;
        }
      })();
      finish(deps, hold, "replay_failed", null, sentFile ? hold.responsePath : null);
      continue;
    }
    if (now >= Date.parse(hold.expiresAt)) {
      // 承認のあと、送らないまま期限を過ぎた。claim してから失敗にする（ほかの者に送らせない）
      if (claimHoldReplay(deps.db, hold.id, deps.paths.holdResponseFile(hold.id))) {
        deps.logger?.warn(
          { hold: hold.id },
          "承認された保留を送らないまま期限を過ぎたので、送りません",
        );
        finish(deps, hold, "replay_failed", null, null);
      }
      continue;
    }
    pending.push(replayHold(deps, hold.id));
  }
  await Promise.allSettled(pending);
}
