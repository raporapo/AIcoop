/**
 * テスト用：ローカルAPI に HTTP で送る。Host ヘッダーを自分で決められるように node:http を使う。
 */
import { request as httpRequest } from "node:http";
import { API_PREFIX } from "../api/contract.ts";

export interface TestResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly text: string;
  // biome-ignore lint/suspicious/noExplicitAny: テストで形を確かめるため
  readonly json: any;
}

export interface TestRequest {
  readonly method?: string;
  /** `/api/v1` からのパス（`/status` など）。`raw: true` なら、そのままのパス */
  readonly path: string;
  readonly raw?: boolean;
  /** Bearer トークン。null なら Authorization を付けない */
  readonly token?: string | null;
  /** Host ヘッダー。既定は `127.0.0.1:<port>`。null なら付けない */
  readonly host?: string | null;
  readonly body?: unknown;
  /** 本文をそのまま送る（JSON にしない） */
  readonly rawBody?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** つなぐ先のアドレス（既定 127.0.0.1） */
  readonly address?: string;
  /** 応答を待つ長さ（既定 3000 ミリ秒）。過ぎたら失敗にする */
  readonly timeoutMs?: number;
}

export function apiRequest(port: number, req: TestRequest): Promise<TestResponse> {
  const headers: Record<string, string> = { ...req.headers };
  if (req.host !== null) headers.host = req.host ?? `127.0.0.1:${port}`;
  if (req.token != null) headers.authorization = `Bearer ${req.token}`;
  let payload: string | undefined;
  if (req.rawBody !== undefined) payload = req.rawBody;
  else if (req.body !== undefined) {
    payload = JSON.stringify(req.body);
    headers["content-type"] ??= "application/json";
  }
  if (payload !== undefined) headers["content-length"] = String(Buffer.byteLength(payload));

  return new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        host: req.address ?? "127.0.0.1",
        port,
        method: req.method ?? "GET",
        path: req.raw ? req.path : `${API_PREFIX}${req.path}`,
        headers,
        setHost: false,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    r.on("error", reject);
    r.setTimeout(req.timeoutMs ?? 3000, () => r.destroy(new Error("応答がありません")));
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}
