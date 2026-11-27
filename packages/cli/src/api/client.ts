/**
 * ローカルAPI（9.2）のクライアント。
 *
 * - daemon が書いた `runtime/daemon.json` でポートを知り、`runtime/api_token` を Bearer で送る
 * - 宛先は必ず `127.0.0.1`（4.3 の2）。daemon.json のポートは 1〜65535 の整数だけを受け付ける
 * - リダイレクトには従わない（トークンをほかへ送らない）
 * - トークンは、画面にもエラーにも出さない
 */
import { readFileSync } from "node:fs";
import { API_PREFIX, type ApiError, aicoopPaths, type DaemonInfo } from "@aicoop/daemon";
import type { CliContext } from "../context.ts";
import { CliError, DaemonUnavailableError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";

export class ApiRequestError extends Error {
  override name = "ApiRequestError";
  readonly status: number;
  readonly body: ApiError | null;
  constructor(status: number, body: ApiError | null) {
    super(body?.message ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** `runtime/daemon.json`。なければ・壊れていれば null */
export function readDaemonInfo(home: string): DaemonInfo | null {
  const value = readJson(aicoopPaths(home).daemonInfo);
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const port = v.port;
  const pid = v.pid;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return null;
  return {
    pid,
    port,
    started_at: typeof v.started_at === "string" ? v.started_at : "",
    home: typeof v.home === "string" ? v.home : home,
    version: typeof v.version === "string" ? v.version : "",
  };
}

function readToken(home: string): string | null {
  try {
    const token = readFileSync(aicoopPaths(home).apiToken, "utf8").trim();
    return /^[\x21-\x7e]{16,512}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

export interface RequestOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class DaemonClient {
  readonly info: DaemonInfo;
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(ctx: CliContext, info: DaemonInfo, token: string) {
    this.info = info;
    this.token = token;
    this.fetchImpl = ctx.deps.fetch;
    this.baseUrl = `http://127.0.0.1:${info.port}${API_PREFIX}`;
  }

  /** daemon.json と api_token を読む。なければ「動いていない」（終了コード 3） */
  static connect(ctx: CliContext, home: string): DaemonClient {
    const info = readDaemonInfo(home);
    if (info === null) throw new DaemonUnavailableError();
    const token = readToken(home);
    if (token === null) {
      throw new DaemonUnavailableError(
        "制御サーバーの API トークン（runtime/api_token）が読めません",
        ["aicoop stop と aicoop start で起動し直してください"],
      );
    }
    return new DaemonClient(ctx, info, token);
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw this.networkError(e, timeoutMs);
    }
    let parsed: unknown;
    try {
      const text = await res.text();
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (res.status >= 200 && res.status < 300) return parsed as T;
    throw new ApiRequestError(res.status, isApiError(parsed) ? parsed : null);
  }

  get<T>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  post<T>(path: string, body: unknown = {}, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, body, options);
  }

  private networkError(e: unknown, timeoutMs: number): CliError {
    const name = (e as { name?: unknown }).name;
    if (name === "TimeoutError" || name === "AbortError") {
      return new DaemonUnavailableError(
        `制御サーバーが ${Math.round(timeoutMs / 1000)}秒待っても応答しません（ポート ${this.info.port}）`,
        [
          "しばらくしてから、もう一度試してください",
          "直らなければ aicoop stop と aicoop start で起動し直します",
        ],
      );
    }
    return new DaemonUnavailableError(
      `制御サーバー（daemon）に接続できません（ポート ${this.info.port}）`,
      ["aicoop start で起動してください（前の daemon が正しく止まらなかったのかもしれません）"],
    );
  }
}

/** API の失敗を、利用者に見せる形にする（コマンドごとの扱いがないもの） */
export function apiFailure(error: unknown, home: string): unknown {
  if (!(error instanceof ApiRequestError)) return error;
  const message = error.body?.message;
  switch (error.body?.error) {
    case "unauthorized":
      return new CliError(
        EXIT.failure,
        "制御サーバーに認証されませんでした（API トークンが合いません）",
        ["aicoop stop と aicoop start で起動し直してください"],
      );
    case "internal":
      return new CliError(EXIT.failure, message ?? "制御サーバーの中でエラーが起きました", [
        `ログを確かめてください：${aicoopPaths(home).logsDir}`,
      ]);
    case undefined:
      return new CliError(
        EXIT.failure,
        `制御サーバーから思いがけない応答がありました（HTTP ${error.status}）`,
        ["aicoop と daemon の版が合っているか確かめてください（aicoop stop → aicoop start）"],
      );
    default:
      return new CliError(EXIT.failure, message ?? `HTTP ${error.status}`);
  }
}

/** 動いているか（`aicoop check`・`aicoop start`・`aicoop stop` 用）。投げない */
export async function probeDaemon(
  ctx: CliContext,
  home: string,
  timeoutMs = 2000,
): Promise<
  { readonly running: true; readonly client: DaemonClient } | { readonly running: false }
> {
  let client: DaemonClient;
  try {
    client = DaemonClient.connect(ctx, home);
  } catch {
    return { running: false };
  }
  try {
    const status = await client.get<unknown>("/status", { timeoutMs });
    // daemon.json が古く、そのポートをほかのソフトが使っていることがある。daemon の応答の形か確かめる
    const isDaemon =
      typeof status === "object" &&
      status !== null &&
      typeof (status as { daemon?: unknown }).daemon === "object";
    return isDaemon ? { running: true, client } : { running: false };
  } catch (e) {
    // daemon の形の誤り（認証の誤りなど）は「動いている」（別の起動のトークンを持っている）
    if (e instanceof ApiRequestError && e.body !== null) return { running: true, client };
    return { running: false };
  }
}
