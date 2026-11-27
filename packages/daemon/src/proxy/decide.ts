/**
 * 資格プロキシの判定（5.2.4〜5.2.6 の1）：`NetworkPolicy.onRequest` の中身。
 *
 * 箱から外へ出る HTTP/HTTPS のリクエストごとに呼ばれる（vm の箱。5.2.2 の1：フックは実行ごとに作るので、
 * 呼ばれた時点で社員が決まる）。
 *
 * 1. その社員の有効な許可 E(m) を、リクエストのたびに求める（一時権限は grants 表の active を読む）
 * 2. `evaluateRequest`（5.2.4）で allow・hold・deny を決める
 * 3. 監査ログ `proxy.decision` を書く（パスはクエリを除く。本文は書かない。5.10）
 * 4. allow → `forward`（仮の札はこのときだけ本物に置き換わる。5.2.1 の2）
 *    deny → 403（5.2.5）
 *    hold → リクエストを `state/holds/<hold_id>.bin` に保存し、保留を作って 428（5.2.5、5.2.6 の1）
 *
 * 加えて、拒否側に倒す決まり：
 * - 実行が動いていない（Claude Code の起動前・終了後。箱を壊せずに残ったときも）ときは、何も送らない
 *   （403、監査ログの理由は `run_not_active`）。仮の札を無効にする（5.1.3 の2）のを、箱のドライバーに頼らない
 * - ポートは、そのプロトコルの既定（https は 443、http は 80）だけ。ほかは、どの操作にも当てない
 * - 資格を使うサービスへの http（暗号なし）は、どの操作にも当てない（本物の資格を平文で流さない）
 * - 監査ログのパスと保留の URL の中の仮の札は伏せ字にし、仮の札の入ったヘッダーは保留に保存しない（11.5）
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  type CompanyConfig,
  denyResponse,
  denyResponseFor,
  effectivePermissionsFor,
  evaluateRequest,
  holdResponse,
  managerOf,
  newId,
  type ProxiedRequest,
  type ProxyDecision,
  resolveMember,
} from "@aicoop/shared";
import type { Logger } from "pino";
import { appendAudit } from "../db/audit.ts";
import { activeGrantsFor } from "../db/grants.ts";
import { createHold } from "../db/holds.ts";
import type { StateDb } from "../db/open.ts";
import type { AicoopPaths } from "../paths.ts";
import { containsPlaceholder, maskPlaceholders } from "../run/redact.ts";

/** 保留にできる本文の上限（5.2.6 の1） */
export const MAX_HOLD_BODY_BYTES = 10 * 1024 * 1024;

/** 監査ログに書くパスの長さの上限（それより長い分は切る） */
const MAX_AUDIT_PATH = 2048;

const HOUR_MS = 60 * 60 * 1000;

/** 保留に保存しないヘッダー（認証の情報）。その資格の header も除く */
const DROPPED_HEADERS = new Set(["authorization", "proxy-authorization", "cookie"]);

export interface ProxyContext {
  readonly db: StateDb;
  readonly paths: AicoopPaths;
  /** その実行の設定（タスクが始まったときのもの） */
  readonly config: CompanyConfig;
  readonly runId: string;
  readonly taskId: string;
  readonly memberId: string;
  /** その実行のスレッド（保留の記録に残す） */
  readonly thread: string;
  /**
   * その実行の Claude Code が動いているか。false のあいだは、許可していても何も送らない
   * （起動前・終了後に箱に残ったプロセスや、壊せずに残った箱から、資格を使わせない）
   */
  readonly active: () => boolean;
  readonly logger?: Logger;
  /** 時刻の元。なければ `db.now` */
  readonly now?: () => Date;
}

export function createProxyHandler(
  ctx: ProxyContext,
): (req: ProxiedRequest) => Promise<ProxyDecision> {
  const now = ctx.now ?? ctx.db.now;
  const resolved = resolveMember(ctx.config, ctx.memberId);
  if (resolved === undefined) {
    throw new Error(`社員「${ctx.memberId}」は、AI の社員として設定にいません`);
  }
  // 保留を出した部署（部長は役員室。5.1.1）
  const holdGroup = resolved.member.group;
  const secretServices = new Set(
    ctx.config.services.filter((s) => s.secret !== null).map((s) => s.id),
  );

  return async (req) => {
    const at = now();
    const path = auditPath(req.path);
    const audit = (
      decision: "allow" | "hold" | "deny",
      operation: string | null,
      reason: string | null,
      bodyBytes: number | null,
    ) =>
      appendAudit(ctx.db, {
        actor: `member:${ctx.memberId}`,
        kind: "proxy.decision",
        subject: ctx.runId,
        data: {
          member: ctx.memberId,
          operation,
          host: req.host,
          path,
          decision,
          reason,
          body_bytes: bodyBytes,
        },
      });

    if (!ctx.active()) {
      audit("deny", null, "run_not_active", req.bodyBytes);
      return denyResponse(null, "not_allowed");
    }

    if (req.port !== (req.protocol === "https" ? 443 : 80)) {
      audit("deny", null, "no_operation", req.bodyBytes);
      return denyResponse(null, "no_operation");
    }

    const effective = effectivePermissionsFor(ctx.config, ctx.memberId, {
      grants: activeGrantsFor(ctx.db, ctx.memberId),
      now: at,
    });
    const result = evaluateRequest(ctx.config.catalog, effective, {
      method: req.method,
      host: req.host,
      path: req.path,
    });

    if (result.decision === "deny") {
      audit("deny", result.operation?.id ?? null, result.reason, req.bodyBytes);
      return denyResponseFor(result);
    }
    const op = result.operation;
    if (req.protocol !== "https" && secretServices.has(op.service)) {
      audit("deny", null, "no_operation", req.bodyBytes);
      return denyResponse(null, "no_operation");
    }

    if (result.decision === "allow") {
      audit("allow", op.id, null, req.bodyBytes);
      return { action: "forward" };
    }

    // hold（5.2.6 の1）
    if (req.bodyBytes !== null && req.bodyBytes > MAX_HOLD_BODY_BYTES) {
      audit("deny", op.id, "too_large_to_hold", req.bodyBytes);
      return denyResponse(op.id, "too_large_to_hold");
    }
    const body = await req.readBody();
    if (body.byteLength > MAX_HOLD_BODY_BYTES) {
      audit("deny", op.id, "too_large_to_hold", body.byteLength);
      return denyResponse(op.id, "too_large_to_hold");
    }

    const holdId = newId("hold", at.getTime());
    const file = ctx.paths.holdFile(holdId);
    const secretHeader = ctx.config.services.find((s) => s.id === op.service)?.secret?.header;
    mkdirSync(ctx.paths.holdsDir, { recursive: true });
    writeFileSync(file, encodeHoldFile(req, body, secretHeader), { mode: 0o600 });
    try {
      createHold(ctx.db, {
        id: holdId,
        runId: ctx.runId,
        taskId: ctx.taskId,
        memberId: ctx.memberId,
        groupId: holdGroup,
        thread: ctx.thread,
        service: op.service,
        operation: op.name,
        params: result.params,
        requestPath: file,
        requestBytes: body.byteLength,
        // 要約の中身（5.7.1 の2 の表）は、部長のレビューを作る P2 で作る
        summary: {
          kind: op.summary ?? "default",
          method: req.method,
          host: req.host,
          path,
          body_bytes: body.byteLength,
        },
        status:
          managerOf(ctx.config, holdGroup) === undefined ? "pending_owner" : "pending_manager",
        expiresAt: new Date(
          at.getTime() + ctx.config.aicoop.holds.ttl_hours * HOUR_MS,
        ).toISOString(),
      });
    } catch (e) {
      rmSync(file, { force: true });
      throw e;
    }
    audit("hold", op.id, null, body.byteLength);
    ctx.logger?.info(
      { run: ctx.runId, member: ctx.memberId, hold: holdId, operation: op.id },
      "重い操作を保留にしました",
    );
    return holdResponse(holdId);
  };
}

/** 監査ログに書くパス：クエリ文字列（と、あればフラグメント）を除き、仮の札を伏せ、長すぎれば切る */
function auditPath(path: string): string {
  const bare = maskPlaceholders(path.split(/[?#]/, 1)[0] ?? "");
  return bare.length > MAX_AUDIT_PATH ? `${bare.slice(0, MAX_AUDIT_PATH)}…` : bare;
}

// ---- 保留したリクエストのファイル（state/holds/<hold_id>.bin） ----

/** ファイルの形の名前（1行目の JSON の format） */
export const HOLD_FILE_FORMAT = "aicoop-hold/1";

export interface SavedHoldRequest {
  readonly method: string;
  /** クエリ文字列を含む URL */
  readonly url: string;
  /** 認証ヘッダー・cookie・その資格のヘッダー・仮の札の入ったヘッダーを除いたもの（名前は小文字） */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/**
 * 1行目に `{"format","method","url","headers","body_bytes"}` の JSON と改行、そのあとに本文をそのまま置く。
 * - 認証ヘッダー・cookie・その資格の `header` は保存しない（5.2.6 の1。再送のときに本物を付け直す）
 * - 仮の札は、どのヘッダーに入っていても置き換わる（C-3）ので、仮の札の入ったヘッダーは名前を問わず保存しない
 * - URL（クエリ）の中の仮の札は伏せ字にする（クエリでは置き換わらない。11.5）
 * 本文は、送るものとして保存する（5.2.1 の3：本文の中の仮の札は置き換わらない）
 */
function encodeHoldFile(
  req: ProxiedRequest,
  body: Uint8Array,
  secretHeader: string | undefined,
): Buffer {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (DROPPED_HEADERS.has(lower) || lower === secretHeader) continue;
    if (containsPlaceholder(value)) continue;
    headers[lower] = value;
  }
  const host = req.host.includes(":") ? `[${req.host}]` : req.host;
  const head = JSON.stringify({
    format: HOLD_FILE_FORMAT,
    method: req.method,
    url: maskPlaceholders(`${req.protocol}://${host}${req.path}`),
    headers,
    body_bytes: body.byteLength,
  });
  return Buffer.concat([Buffer.from(`${head}\n`, "utf8"), body]);
}

/** 保存したリクエストを読む（再送・承認アプリでの表示。P2） */
export function readHoldFile(bytes: Uint8Array): SavedHoldRequest {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const newline = buffer.indexOf(0x0a);
  if (newline < 0) throw new Error("保留のファイルの形が違います");
  const head = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
  const body = buffer.subarray(newline + 1);
  if (
    head.format !== HOLD_FILE_FORMAT ||
    typeof head.method !== "string" ||
    typeof head.url !== "string" ||
    typeof head.headers !== "object" ||
    head.headers === null ||
    head.body_bytes !== body.byteLength
  ) {
    throw new Error("保留のファイルの形が違います");
  }
  return {
    method: head.method,
    url: head.url,
    headers: head.headers as Record<string, string>,
    body: new Uint8Array(body),
  };
}
