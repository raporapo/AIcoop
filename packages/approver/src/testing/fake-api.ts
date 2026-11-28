/**
 * テスト用：ローカルAPI（9.2）の偽物。`fetch` の代わりに渡す。
 * 道は `"GET /holds"` のように、メソッドと `/api/v1` より後ろのパス（問い合わせを除く）で書く。
 */
import { vi } from "vitest";

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly init: RequestInit;
}

export interface FakeResponse {
  readonly status?: number;
  readonly body: unknown;
}

export type FakeHandler =
  | FakeResponse
  | ((req: FakeRequest) => FakeResponse | Promise<FakeResponse>);

export interface FakeApi {
  readonly fetch: typeof fetch;
  readonly calls: FakeRequest[];
  /** 道を足す・置き換える */
  on(route: string, handler: FakeHandler): void;
  /** true のあいだは、すべての呼び出しを通信の失敗にする */
  offline: boolean;
  /** その道が呼ばれた回数 */
  count(route: string): number;
  /** 呼ばれた順（`"POST /approvals/intent"` など） */
  routes(): string[];
}

export function ok(body: unknown): FakeResponse {
  return { status: 200, body };
}

export function fail(status: number, error: string, message: string): FakeResponse {
  return { status, body: { error, message } };
}

export function createFakeApi(initial: Record<string, FakeHandler> = {}): FakeApi {
  const handlers = new Map<string, FakeHandler>(Object.entries(initial));
  const calls: FakeRequest[] = [];
  const api: FakeApi = {
    calls,
    offline: false,
    on(route, handler) {
      handlers.set(route, handler);
    },
    count(route) {
      return calls.filter((c) => `${c.method} ${c.path}` === route).length;
    },
    routes() {
      return calls.map((c) => `${c.method} ${c.path}`);
    },
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost:7070");
      const method = init?.method ?? "GET";
      const path = url.pathname.replace(/^\/api\/v1/, "");
      let body: unknown;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      const req: FakeRequest = { method, path, query: url.searchParams, body, init: init ?? {} };
      calls.push(req);
      if (api.offline) throw new TypeError("Failed to fetch");
      const handler = handlers.get(`${method} ${path}`);
      const res =
        handler === undefined
          ? fail(404, "not_found", `テストの偽の API にない道です：${method} ${path}`)
          : typeof handler === "function"
            ? await handler(req)
            : handler;
      return new Response(JSON.stringify(res.body), {
        status: res.status ?? 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }) as unknown as typeof fetch,
  };
  return api;
}

/** テスト用の localStorage の代わり */
export function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => Array.from(map.keys())[i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}
