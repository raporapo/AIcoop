/**
 * テスト用：ローカルAPI（9.2）の偽物。127.0.0.1 の空いているポートで待ち受け、
 * `runtime/daemon.json` と `runtime/api_token` を、本物の daemon と同じように書く。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import type { DaemonInfo } from "@aicoop/daemon";

export const TEST_API_TOKEN = "test-api-token-0123456789";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface FakeResponse {
  readonly status?: number;
  readonly body?: unknown;
}

export type Handler = (req: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

export interface FakeDaemon {
  readonly port: number;
  readonly info: DaemonInfo;
  readonly requests: RecordedRequest[];
  /** `GET /status` のように、メソッドと /api/v1 からのパスで決める */
  on(route: string, handler: Handler | FakeResponse): void;
  /** daemon.json を残したまま、待ち受けだけをやめる（落ちた daemon） */
  closeServer(): Promise<void>;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text === "") return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(text);
      }
    });
  });
}

export async function startFakeDaemon(
  home: string,
  options: { readonly pid?: number; readonly writeInfo?: boolean } = {},
): Promise<FakeDaemon> {
  const routes = new Map<string, Handler>();
  const requests: RecordedRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const recorded: RecordedRequest = {
      method: req.method ?? "GET",
      path,
      query: url.searchParams,
      authorization: req.headers.authorization,
      body: await readBody(req),
    };
    requests.push(recorded);
    if (recorded.authorization !== `Bearer ${TEST_API_TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", message: "トークンが違います" }));
      return;
    }
    const handler = routes.get(`${recorded.method} ${path}`);
    const result: FakeResponse = handler
      ? await handler(recorded)
      : { status: 404, body: { error: "not_found", message: "見つかりません" } };
    res.writeHead(result.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const info: DaemonInfo = {
    pid: options.pid ?? process.pid,
    port,
    started_at: "2026-11-28T00:00:00.000Z",
    home,
    version: "0.0.0",
  };
  const runtime = join(home, "runtime");
  if (options.writeInfo !== false) {
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "daemon.json"), JSON.stringify(info));
    writeFileSync(join(runtime, "api_token"), `${TEST_API_TOKEN}\n`, { mode: 0o600 });
  }
  let open = true;
  const closeServer = () =>
    new Promise<void>((resolve) => {
      if (!open) return resolve();
      open = false;
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return {
    port,
    info,
    requests,
    on(route, handler) {
      routes.set(route, typeof handler === "function" ? handler : () => handler);
    },
    closeServer,
    async close() {
      await closeServer();
      rmSync(join(runtime, "daemon.json"), { force: true });
    },
  };
}
