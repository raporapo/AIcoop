/**
 * ローカルHTTP API のサーバー（9.2）。形は `contract.ts` のとおり。
 *
 * どの要求も、次の順に確かめてから道に進む（拒否側に倒す）。
 * 1. `Host` が `127.0.0.1:<port>`・`localhost:<port>` のどちらか（DNS リバインディング対策）→ 違えば 403 `forbidden_host`
 * 2. 本文は 64 KiB まで → 超えれば 413
 * 3. 認証なしの道（承認アプリの画面 `/app/*`、端末の登録・ログイン。`routes/`）
 * 4. `Authorization: Bearer <api_token>`（時間が一定の比較）か、承認アプリのセッションクッキー（`auth.ts`）
 *    → 違えば 401 `unauthorized`。クッキーで来た POST は `Origin` が違えば 403 `forbidden_origin`
 *
 * 待ち受けるのは `127.0.0.1` だけ（4.3 の2。`listenApi`）。
 *
 * HTTP のステータス：400 `invalid_input`、401 `unauthorized`、403 `forbidden_host`・`forbidden_origin`、404 `not_found`、
 * 409 `invalid_state`、413・415 `invalid_input`、422 `unknown_member`・`config_invalid`、500 `internal`
 */
import type { Server } from "node:http";
import {
  type CompanyConfig,
  type ConfigIssue,
  ID_PATTERN,
  isId,
  isTaskStatus,
  isTerminalTaskStatus,
  TASK_STATUSES,
  type TaskStatus,
  timeoutMinutesFor,
} from "@aicoop/shared";
import { createAdaptorServer } from "@hono/node-server";
import { desc, inArray } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import type { ApprovalService } from "../approvals/service.ts";
import { listAuditLog } from "../db/audit.ts";
import type { StateDb } from "../db/open.ts";
import { listRunsForTask } from "../db/runs.ts";
import { tasks } from "../db/schema.ts";
import { cancelTask, createTask, getTask, InvalidTaskTransitionError } from "../db/tasks.ts";
import { getUsageState, type UsageState } from "../db/usage.ts";
import type { AicoopPaths } from "../paths.ts";
import type { RunHandle } from "../run/types.ts";
import type { RunnableCheck } from "../triggers/runnable.ts";
import { actorOf, authenticate, requireBearer } from "./auth.ts";
import {
  API_PREFIX,
  type ApiError,
  type ApiErrorCode,
  type AuditEntryView,
  type CancelTaskResponse,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type GetTaskResponse,
  type ListAuditResponse,
  type ListTasksResponse,
  type ReloadResponse,
  type RunningBoxView,
  type ShutdownResponse,
  type StatusResponse,
  type TriggerView,
  toRunView,
  toTaskView,
  type UsageResponse,
  type UsageView,
} from "./contract.ts";
import { appRoutes } from "./routes/app.ts";
import { protectedApprovalRoutes, publicApprovalRoutes } from "./routes/approvals.ts";
import { registerHoldRoutes } from "./routes/holds.ts";

/** 本文の上限 */
export const MAX_BODY_BYTES = 64 * 1024;
const MAX_PURPOSE_CHARS = 2000;
const MAX_DONE_WHEN_CHARS = 2000;
const MAX_CONTEXT_CHARS = 32_000;
const MAX_TIMEOUT_MINUTES = 55;

/** API の向こう側（daemon の中身）。テストではなく daemon の本体が渡す */
export interface ApiControl {
  readonly db: StateDb;
  /** `~/.aicoop` の中の置き場所（保留したリクエストのファイルを読む） */
  readonly paths: AicoopPaths;
  readonly logger: Logger;
  /** ローカルAPI のトークン */
  readonly token: string;
  /** 待ち受けているポート（Host の確かめに使う） */
  port(): number;
  config(): CompanyConfig;
  warnings(): readonly ConfigIssue[];
  daemon(): StatusResponse["daemon"];
  runningBoxes(): RunningBoxView[];
  triggers(): TriggerView[];
  canRun(memberId: string): RunnableCheck;
  /** タスクを作ったあと（順番待ちを見直す） */
  taskCreated(): void;
  handleFor(taskId: string): RunHandle | undefined;
  reload():
    | {
        readonly ok: true;
        readonly warnings: readonly ConfigIssue[];
        readonly files: Readonly<Record<string, string>>;
      }
    | { readonly ok: false; readonly issues: readonly ConfigIssue[] };
  /** 応答を返したあとで止め始める */
  shutdown(): void;
  /** 端末の登録・ログイン・承認の署名（5.8） */
  readonly approvals: ApprovalService;
  /** 承認アプリの静的ファイル（packages/approver/dist） */
  readonly approverDir: string;
}

/** 道の中で投げて、決まった形の失敗を返す */
export class ApiFailure extends Error {
  override name = "ApiFailure";
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 500;
  readonly code: ApiErrorCode;
  readonly issues: readonly ConfigIssue[] | undefined;
  constructor(
    status: ApiFailure["status"],
    code: ApiErrorCode,
    message: string,
    issues?: readonly ConfigIssue[],
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

function errorBody(code: ApiErrorCode, message: string, issues?: readonly ConfigIssue[]): ApiError {
  return issues === undefined ? { error: code, message } : { error: code, message, issues };
}

const invalid = (message: string) => new ApiFailure(400, "invalid_input", message);

function usageView(state: UsageState | undefined): UsageView | null {
  if (state === undefined) return null;
  return {
    status: state.status,
    resets_at: state.resetsAt,
    rate_limit_type: state.rateLimitType,
    utilization: state.utilization,
    updated_at: state.updatedAt,
  };
}

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseIntParam(
  value: string | undefined,
  name: string,
  range: { readonly min: number; readonly max: number; readonly fallback: number },
): number {
  if (value === undefined || value === "") return range.fallback;
  if (!/^\d{1,10}$/.test(value)) {
    throw invalid(`${name} は ${range.min}〜${range.max} の整数にしてください`);
  }
  const n = Number(value);
  if (n < range.min || n > range.max) {
    throw invalid(`${name} は ${range.min}〜${range.max} の整数にしてください`);
  }
  return n;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くため
const BAD_TEXT_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** スレッド名（state.db の決まり：1〜200文字、制御文字・書式文字・行区切りを含まない） */
const THREAD = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]{1,200}$/u;

const CREATE_KEYS = new Set([
  "member",
  "purpose",
  "done_when",
  "context",
  "thread",
  "timeout_minutes",
]);

function text(
  body: Record<string, unknown>,
  key: string,
  label: string,
  opts: { readonly required: boolean; readonly max: number },
): string | undefined {
  const value = body[key];
  if (value === undefined && !opts.required) return undefined;
  if (typeof value !== "string" || (opts.required && value.trim() === "")) {
    throw invalid(
      `${key}（${label}）を${opts.required ? "書いてください" : "文字列で書いてください"}`,
    );
  }
  if ([...value].length > opts.max) throw invalid(`${key}（${label}）は ${opts.max} 文字までです`);
  if (BAD_TEXT_CHARS.test(value)) {
    throw invalid(`${key}（${label}）に、改行とタブ以外の制御文字は使えません`);
  }
  return value;
}

/** `POST /tasks` の本文を確かめる（知らないキーも誤りにする） */
function parseCreateTask(body: unknown): CreateTaskRequest {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw invalid("本文は JSON のオブジェクトにしてください");
  }
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !CREATE_KEYS.has(k));
  if (unknown.length > 0) {
    throw invalid(
      `知らないキーがあります：${unknown.join("、")}（書けるのは ${[...CREATE_KEYS].join("・")}）`,
    );
  }
  if (typeof b.member !== "string" || b.member === "")
    throw invalid("member（社員ID）を書いてください");
  if (!ID_PATTERN.test(b.member)) {
    throw invalid("member は社員ID（英小文字・数字・ハイフンで1〜40文字）で書いてください");
  }
  const purpose = text(b, "purpose", "目的", { required: true, max: MAX_PURPOSE_CHARS }) as string;
  const doneWhen = text(b, "done_when", "完了の条件", {
    required: true,
    max: MAX_DONE_WHEN_CHARS,
  }) as string;
  const context = text(b, "context", "背景", { required: false, max: MAX_CONTEXT_CHARS });
  let thread: string | undefined;
  if (b.thread !== undefined) {
    if (typeof b.thread !== "string" || !THREAD.test(b.thread)) {
      throw invalid("thread（スレッド名）は1〜200文字で、改行や制御文字を含めないでください");
    }
    thread = b.thread;
  }
  let timeout: number | undefined;
  if (b.timeout_minutes !== undefined) {
    const v = b.timeout_minutes;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_TIMEOUT_MINUTES) {
      throw invalid(
        `timeout_minutes（時間制限）は1〜${MAX_TIMEOUT_MINUTES}の整数（分）にしてください（5.5.5）`,
      );
    }
    timeout = v;
  }
  return {
    member: b.member,
    purpose,
    done_when: doneWhen,
    ...(context !== undefined && { context }),
    ...(thread !== undefined && { thread }),
    ...(timeout !== undefined && { timeout_minutes: timeout }),
  };
}

function requireTaskId(id: string): string {
  if (!isId(id, "task")) throw new ApiFailure(404, "not_found", "そのタスクはありません");
  return id;
}

export function createApiApp(control: ApiControl): Hono {
  const { db, logger } = control;
  const app = new Hono();

  // 1. Host（DNS リバインディング対策）
  app.use("*", async (c, next) => {
    const host = c.req.header("host")?.toLowerCase();
    const port = control.port();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return c.json(
        errorBody(
          "forbidden_host",
          `この API は http://127.0.0.1:${port}/ からだけ使えます（Host が違います）`,
        ),
        403,
      );
    }
    await next();
  });

  // 2. 本文の上限
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          errorBody("invalid_input", `本文が大きすぎます（${MAX_BODY_BYTES / 1024} KiB まで）`),
          413,
        ),
    }),
  );

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  // 3. 認証なしの道：承認アプリの画面（/app/*）、端末の登録・ログイン（Origin を確かめる。5.8）
  const approvalRoutes = { approvals: control.approvals, logger, port: control.port };
  app.route("/", appRoutes(control.approverDir));
  app.route(API_PREFIX, publicApprovalRoutes(approvalRoutes));

  // 4. 認証：Bearer トークン（CLI）か、承認アプリのセッションクッキー（auth.ts）
  app.use("*", authenticate({ ...approvalRoutes, token: control.token }));

  const api = new Hono();

  api.get("/status", (c) => {
    const config = control.config();
    const counts = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<
      TaskStatus,
      number
    >;
    const rows = db.sqlite
      .prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    for (const row of rows) if (isTaskStatus(row.status)) counts[row.status] = row.n;
    const pending = db.sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM holds WHERE status IN ('pending_manager', 'pending_owner')",
      )
      .get() as { n: number };
    const body: StatusResponse = {
      company: { id: config.aicoop.company.id, name: config.aicoop.company.name },
      daemon: control.daemon(),
      boxes: {
        max_concurrent: config.aicoop.daemon.max_concurrent_boxes,
        running: control.runningBoxes(),
      },
      tasks: counts,
      usage: usageView(getUsageState(db)),
      holds: { pending: pending.n },
      triggers: control.triggers(),
      warnings: control.warnings(),
    };
    return c.json(body);
  });

  api.get("/tasks", (c) => {
    const statusParam = c.req.query("status");
    let statuses: TaskStatus[] | undefined;
    if (statusParam !== undefined && statusParam !== "") {
      const values = statusParam.split(",");
      const bad = values.filter((v) => !isTaskStatus(v));
      if (bad.length > 0) {
        throw invalid(
          `知らない状態です：${bad.join("、")}（使える状態：${TASK_STATUSES.join("・")}）`,
        );
      }
      statuses = values as TaskStatus[];
    }
    const limit = parseIntParam(c.req.query("limit"), "limit", { min: 1, max: 500, fallback: 100 });
    const rows = db.orm
      .select()
      .from(tasks)
      .where(statuses === undefined ? undefined : inArray(tasks.status, statuses))
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .limit(limit)
      .all();
    const body: ListTasksResponse = { tasks: rows.map(toTaskView) };
    return c.json(body);
  });

  api.post("/tasks", async (c) => {
    const type = c.req.header("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(type)) {
      throw new ApiFailure(
        415,
        "invalid_input",
        "本文は JSON（Content-Type: application/json）で送ってください",
      );
    }
    const raw = await c.req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalid("本文を JSON として読めません");
    }
    const req = parseCreateTask(parsed);
    const config = control.config();
    const check = control.canRun(req.member);
    if (!check.ok) throw new ApiFailure(422, "unknown_member", check.message);

    const task = createTask(
      db,
      {
        memberId: check.member.id,
        groupId: check.member.group.id,
        triggerKind: "manual",
        thread: req.thread ?? null,
        purpose: req.purpose,
        context: req.context ?? "",
        // オーナーが自分で書いた文章なので、外から来た文章としては囲まない
        contextUntrusted: false,
        doneWhen: req.done_when,
        timeoutMinutes: req.timeout_minutes ?? timeoutMinutesFor(config),
      },
      { actor: actorOf(c) },
    );
    logger.info({ task_id: task.id, member: task.memberId }, "手動のタスクを作りました");
    control.taskCreated();
    const body: CreateTaskResponse = { task: toTaskView(task) };
    return c.json(body, 201);
  });

  api.get("/tasks/:id", (c) => {
    const id = requireTaskId(c.req.param("id"));
    const task = getTask(db, id);
    if (task === undefined) throw new ApiFailure(404, "not_found", "そのタスクはありません");
    const body: GetTaskResponse = {
      task: toTaskView(task),
      runs: listRunsForTask(db, id).map(toRunView),
    };
    return c.json(body);
  });

  api.post("/tasks/:id/cancel", async (c) => {
    const id = requireTaskId(c.req.param("id"));
    const task = getTask(db, id);
    if (task === undefined) throw new ApiFailure(404, "not_found", "そのタスクはありません");
    const handle = control.handleFor(id);
    if (handle !== undefined) {
      await handle.cancel("cancelled");
      const after = getTask(db, id) ?? task;
      if (after.status !== "cancelled") {
        throw new ApiFailure(
          409,
          "invalid_state",
          `取り消す前に、タスクが終わりました（状態：${after.status}）`,
        );
      }
      logger.info({ task_id: id }, "動いていたタスクを取り消しました");
      const body: CancelTaskResponse = { task: toTaskView(after), was_active: true };
      return c.json(body);
    }
    if (isTerminalTaskStatus(task.status)) {
      throw new ApiFailure(
        409,
        "invalid_state",
        `このタスクは、もう終わっています（状態：${task.status}）`,
      );
    }
    try {
      const result = cancelTask(db, id, { actor: actorOf(c) });
      logger.info({ task_id: id }, "タスクを取り消しました");
      const body: CancelTaskResponse = {
        task: toTaskView(result.task),
        was_active: result.wasActive,
      };
      return c.json(body);
    } catch (error) {
      if (error instanceof InvalidTaskTransitionError) {
        throw new ApiFailure(409, "invalid_state", `いまは取り消せません（状態：${error.from}）`);
      }
      throw error;
    }
  });

  api.post("/reload", requireBearer, (c) => {
    const result = control.reload();
    if (!result.ok) {
      throw new ApiFailure(
        422,
        "config_invalid",
        `設定にエラーがあるので、読み直しませんでした（${result.issues.length}件。前の設定のまま動いています）`,
        result.issues,
      );
    }
    const body: ReloadResponse = { ok: true, warnings: result.warnings, files: result.files };
    return c.json(body);
  });

  api.get("/audit", (c) => {
    const after = parseIntParam(c.req.query("after"), "after", {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
      fallback: 0,
    });
    const limit = parseIntParam(c.req.query("limit"), "limit", {
      min: 1,
      max: 1000,
      fallback: 200,
    });
    const entries: AuditEntryView[] = listAuditLog(db, { after, limit }).map((row) => ({
      seq: row.seq,
      ts: row.ts,
      actor: row.actor,
      kind: row.kind,
      subject: row.subject,
      data: parseJsonOrNull(row.data),
    }));
    const body: ListAuditResponse = { entries };
    return c.json(body);
  });

  // 保留・一時権限（P2。GET /holds・/holds/{id}・/grants）
  registerHoldRoutes(api, { db, paths: control.paths });

  api.get("/usage", (c) => {
    const body: UsageResponse = { usage: usageView(getUsageState(db)) };
    return c.json(body);
  });

  api.post("/shutdown", requireBearer, (c) => {
    logger.info("API から止めるよう頼まれました");
    control.shutdown();
    const body: ShutdownResponse = { ok: true };
    return c.json(body);
  });

  // 端末の登録（CLI）・ログイン中の端末・端末・承認の署名（5.8）
  api.route("/", protectedApprovalRoutes(approvalRoutes));

  app.route(API_PREFIX, api);

  app.notFound((c) => c.json(errorBody("not_found", "その道はありません"), 404));
  app.onError((error, c: Context) => {
    if (error instanceof ApiFailure) {
      return c.json(errorBody(error.code, error.message, error.issues), error.status);
    }
    logger.error(
      { err: error, method: c.req.method, path: c.req.path },
      "API の中でエラーが起きました",
    );
    return c.json(
      errorBody("internal", "制御サーバーの中でエラーが起きました。daemon のログを見てください"),
      500,
    );
  });

  return app;
}

/** API の HTTP サーバー（まだ待ち受けない） */
export function createApiServer(app: Hono): Server {
  return createAdaptorServer({ fetch: app.fetch }) as Server;
}

/** 4.3 の2：`127.0.0.1` だけで待ち受ける。待ち受けたポートを返す（`port` が 0 なら空いているポート） */
export function listenApi(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host: "127.0.0.1", exclusive: true });
  });
}

/** 受け付けを止め、つながっているものを閉じて待つ */
export function closeApiServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    const force = setTimeout(() => server.closeAllConnections(), 2000);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
}
