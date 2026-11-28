/**
 * 道具ゲート（5.3.1〜5.3.3、9.3）：実行ごとの MCP サーバー（Streamable HTTP）。
 *
 * - 実行ごとに `127.0.0.1` の空いているポートで、パス `/mcp` だけで待ち受ける。ポートと実行は1対1
 *   なので、呼び出し元の社員はポートで決まる。実行が終わったら閉じる（5.3.1 の1）
 * - `127.0.0.1` のポートは、ホストのほかのプロセスからも届く。実行ごとにランダムなトークンを作り、
 *   `Authorization: Bearer <トークン>` のないリクエストは 401 にする（時間が一定の比較）。
 *   トークンは箱の中の `/etc/aicoop/mcp.json` の `headers` で Claude Code に渡す（箱の中の AI には
 *   見えるが、その実行のゲートにしか効かない）。ログには書かない
 * - vm の箱からは `http://aicoop.internal/mcp` で届く（Gondolin の `tcp.hosts`。5.3.1 の2）ので、
 *   `Host: aicoop.internal` を受け付ける。それ以外の Host（DNS リバインディング）と、ブラウザからの
 *   リクエスト（`Origin` あり）は受け付けない
 * - `report_result` はすべての役職に出す。ほかの組み込み道具（P2：`review_decision`・`list_my_holds`・
 *   `request_access`）は、呼ぶ側がその役職に見せるものだけを `tools` で渡す。一覧にない道具は呼べない（5.3.1）
 * - 呼び出しは監査ログ `gateway.call`（社員、道具名、引数の正規化JSONの SHA-256、成否）に書く（5.10）
 * - 組み込み道具のエラーは、`isError: true` と `{"error": "<コード>", "message": "..."}`（9.3）
 *
 * セッションを持たない形（stateless）で動かす：POST ごとに MCP サーバーを作って答える。
 * Claude Code がつなぎ直しても、前の接続の状態に左右されない。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { GATEWAY_HOST } from "@aicoop/box-gondolin";
import { canonicalJson } from "@aicoop/shared";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";
import { appendAudit } from "../db/audit.ts";
import type { StateDb } from "../db/open.ts";
import {
  REPORT_RESULT_INPUT_SCHEMA,
  type ReportResult,
  validateReportResult,
} from "./report-result.ts";

export type { ReportResult } from "./report-result.ts";

/** 9.3 の道具ゲートのエラーのコード（P2 までに使うもの） */
export type GatewayErrorCode =
  | "invalid_input"
  | "not_allowed"
  | "outside_ceiling"
  | "too_long"
  | "daily_limit";

/** onReport がこれを投げたら、記録せずに not_allowed を返す（例：タスクがもう動いていない） */
export class ReportRejectedError extends Error {
  override name = "ReportRejectedError";
}

/** 組み込み道具の結果（成功は JSON にして返す。失敗は 9.3 の形） */
export type GatewayToolResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: GatewayErrorCode; readonly message: string };

/** report_result のほかの組み込み道具（5.3.3）。役職ごとに、見せるものだけを渡す（5.3.1） */
export interface GatewayTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly type: "object" } & Record<string, unknown>;
  call(args: unknown): Promise<GatewayToolResult> | GatewayToolResult;
}

export interface GatewayOptions {
  readonly db: StateDb;
  /** この実行の社員（ポートで決まる。5.3.1 の1） */
  readonly memberId: string;
  /** この実行のタスク（監査ログの対象） */
  readonly taskId: string;
  /** 部署の作業フォルダのホスト側のパス（files を確かめる） */
  readonly workDir: string;
  /** report_result を受け付けたとき。ReportRejectedError を投げたら記録しない */
  readonly onReport: (result: ReportResult) => void | Promise<void>;
  /** report_result のほかに見せる道具（その役職の社員に見せるものだけ）。一覧にないものは呼べない */
  readonly tools?: readonly GatewayTool[];
  readonly logger?: Logger;
}

export interface Gateway {
  readonly port: number;
  /**
   * この実行のゲートのトークン（`Authorization: Bearer <token>`。32バイトの乱数の base64url）。
   * mcp.json に書いて箱へ渡す。ログには書かない（伏せ字にする）
   */
  readonly token: string;
  /** ポートを閉じる。何度呼んでもよい */
  close(): Promise<void>;
}

const REPORT_RESULT = "report_result";
const MAX_TOOL_NAME = 128;

export async function openGateway(options: GatewayOptions): Promise<Gateway> {
  let port = 0;
  const token = randomBytes(32).toString("base64url");
  const expected = digest(`Bearer ${token}`);
  const allowedHosts = () => [GATEWAY_HOST, `${GATEWAY_HOST}:80`, `127.0.0.1:${port}`];

  const http = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      options.logger?.warn({ err: errorName(error) }, "道具ゲートで処理できないリクエスト");
      if (!res.headersSent) respondJson(res, 500, { error: "internal" });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host;
    if (host === undefined || !allowedHosts().includes(host) || req.headers.origin !== undefined) {
      respondJson(res, 403, { error: "forbidden" });
      return;
    }
    // パスより先に確かめる（トークンのない者には、何も答えない）
    const authorization = req.headers.authorization;
    if (typeof authorization !== "string" || !timingSafeEqual(digest(authorization), expected)) {
      respondJson(res, 401, { error: "unauthorized" });
      return;
    }
    const path = (req.url ?? "").split("?", 1)[0];
    if (path !== "/mcp") {
      respondJson(res, 404, { error: "not_found" });
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const server = createMcpServer(options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: allowedHosts(),
    });
    res.on("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.off("error", reject);
      resolve();
    });
  });
  port = (http.address() as AddressInfo).port;

  let closing: Promise<void> | null = null;
  return {
    port,
    token,
    close() {
      closing ??= new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
      return closing;
    },
  };
}

function createMcpServer(options: GatewayOptions): Server {
  const server = new Server(
    { name: "aicoop", version: "0.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: REPORT_RESULT,
        description:
          "タスクの結果を記録します。仕事は必ずこれで終えてください。呼ばずに終えると「報告なしで終了」になります。",
        inputSchema: REPORT_RESULT_INPUT_SCHEMA as unknown as {
          type: "object";
          properties: Record<string, object>;
        },
      },
      ...(options.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as unknown as {
          type: "object";
          properties: Record<string, object>;
        },
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const result = await callTool(options, name, args);
    appendAudit(options.db, {
      actor: `member:${options.memberId}`,
      kind: "gateway.call",
      subject: options.taskId,
      data: {
        member: options.memberId,
        tool: safeToolName(name),
        args_sha256: argsHash(args),
        ok: result.isError !== true,
      },
    });
    return result;
  });

  return server;
}

async function callTool(
  options: GatewayOptions,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  if (name !== REPORT_RESULT) {
    const tool = (options.tools ?? []).find((t) => t.name === name);
    if (tool === undefined) {
      return toolError(
        "not_allowed",
        "この道具は使えません。使える道具は tools/list のものだけです",
      );
    }
    let result: GatewayToolResult;
    try {
      result = await tool.call(args);
    } catch (error) {
      options.logger?.error(
        { tool: tool.name, err: errorName(error) },
        "組み込み道具で例外が起きました",
      );
      return toolError(
        "not_allowed",
        "この道具は、いま使えません（制御サーバーの中でエラーが起きました）",
      );
    }
    if (!result.ok) return toolError(result.code, result.message);
    return { content: [{ type: "text", text: JSON.stringify(result.value) }] };
  }
  const checked = validateReportResult(args, options.workDir);
  if (!checked.ok) return toolError("invalid_input", checked.message);
  try {
    await options.onReport(checked.value);
  } catch (error) {
    if (error instanceof ReportRejectedError) return toolError("not_allowed", error.message);
    throw error;
  }
  options.logger?.info(
    { task: options.taskId, files: checked.value.files.length },
    "結果の報告を受けました",
  );
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          message: "結果を記録しました。ほかに残った作業がなければ、これで仕事を終えてください。",
        }),
      },
    ],
  };
}

function toolError(code: GatewayErrorCode, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: code, message }) }],
  };
}

/** 時間が一定の比較のために、長さをそろえる（SHA-256） */
function digest(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

function argsHash(args: unknown): string {
  let json: string;
  try {
    json = canonicalJson(args);
  } catch {
    json = "";
  }
  return createHash("sha256").update(json).digest("hex");
}

/** 監査ログに書く道具名（箱の中から来る値なので、形を限って短くする） */
function safeToolName(name: unknown): string {
  if (typeof name !== "string") return "(不明)";
  const cleaned = name.replace(/[^A-Za-z0-9_.-]/g, "?");
  return cleaned.length > MAX_TOOL_NAME ? `${cleaned.slice(0, MAX_TOOL_NAME)}…` : cleaned;
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
