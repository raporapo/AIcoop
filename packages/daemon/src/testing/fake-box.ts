/**
 * テスト用の偽の箱（BoxDriver）。Gondolin の VM の代わりに、テストごとに決めた
 * 「偽の Claude Code」の動きを再生する。
 *
 * - `create` で渡された BoxSpec（マウント・環境変数・資格・ネットワーク）を記録する
 * - `exec` で渡された引数・作業ディレクトリ・環境変数を記録し、偽の Claude Code（`claude`）を動かす
 * - 偽の Claude Code は、次のことができる（FakeClaudeContext）
 *   - stream-json の行を出す（`emit`。オブジェクトは JSON にする）
 *   - 道具ゲート `http://127.0.0.1:<gatewayPort>/mcp` に MCP クライアントでつなぎ、道具を呼ぶ
 *   - `spec.network.onRequest` に偽のリクエストを渡して、資格プロキシの判定を確かめる
 *   - 時間がかかる（`sleep`。止められたら早く終わる）、終了コードを返す
 * - `kill`・`destroy` の回数を記録する。止められた exec は終了コード 137 で終わる
 *
 * 使い方（例）：
 * ```ts
 * const driver = new FakeBoxDriver(async (claude) => {
 *   claude.emit(fakeEvents.init("s-1"));
 *   await claude.reportResult("やりました");
 *   claude.emit(fakeEvents.result());
 *   return 0;
 * });
 * const handle = startRun({ ...env, drivers: { vm: driver } }, { taskId, config });
 * ```
 */

import { join } from "node:path";
import type {
  Box,
  BoxDriver,
  BoxKind,
  BoxSpec,
  ExecHandle,
  ExecLine,
  ProxiedRequest,
  ProxyDecision,
} from "@aicoop/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** 偽の Claude Code の動き。戻り値は終了コード（なければ 0） */
export type FakeClaude = (
  claude: FakeClaudeContext,
) => Promise<number | undefined> | number | undefined;

export interface FakeRequestInput {
  readonly method?: string;
  readonly protocol?: "http" | "https";
  readonly host: string;
  readonly port?: number;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
}

export interface FakeClaudeContext {
  readonly spec: BoxSpec;
  readonly box: FakeBox;
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** kill・destroy されたら中断する */
  readonly signal: AbortSignal;
  /** 標準出力に1行出す（オブジェクトは JSON にする） */
  emit(line: unknown): void;
  /** 標準エラーに1行出す */
  emitStderr(line: string): void;
  /** 道具ゲートにつないだ MCP クライアント（使い終わったら close する） */
  connectMcp(): Promise<Client>;
  /** 道具ゲートの道具を1回呼ぶ（つないで、呼んで、閉じる） */
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** 道具ゲートの道具の名前の一覧 */
  listTools(): Promise<string[]>;
  /** report_result を呼ぶ */
  reportResult(summary: string, files?: readonly string[]): Promise<CallToolResult>;
  /** 箱から外へ出るリクエストを、資格プロキシの判定（spec.network.onRequest）に渡す */
  request(input: FakeRequestInput): Promise<ProxyDecision>;
  /** 箱の中のパスを、マウントのホスト側のパスにする */
  hostPath(guestPath: string): string;
  /** 待つ。止められたら早く終わる */
  sleep(ms: number): Promise<void>;
}

export interface FakeExecCall {
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** よく使う stream-json の行 */
export const fakeEvents = {
  init: (sessionId: string) => ({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    tools: ["mcp__aicoop__report_result"],
    mcp_servers: [{ name: "aicoop", status: "connected" }],
  }),
  result: (over: Record<string, unknown> = {}) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "終わりました",
    ...over,
  }),
  rateLimit: (info: Record<string, unknown>) => ({
    type: "rate_limit_event",
    rate_limit_info: info,
  }),
  text: (text: string) => ({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  }),
};

/** 何もしない Claude Code：init と result を出して 0 で終わる（報告しない） */
export const quietClaude: FakeClaude = (claude) => {
  claude.emit(fakeEvents.init("fake-session"));
  claude.emit(fakeEvents.result());
  return 0;
};

export class FakeBoxDriver implements BoxDriver {
  readonly kind: BoxKind;
  /** 次に作る箱の exec で動かす偽の Claude Code（テストの途中で替えてよい） */
  claude: FakeClaude;
  /** create で投げるエラー（箱の起動の失敗） */
  createError: Error | null = null;
  readonly boxes: FakeBox[] = [];

  constructor(claude: FakeClaude = quietClaude, kind: BoxKind = "vm") {
    this.claude = claude;
    this.kind = kind;
  }

  async create(spec: BoxSpec): Promise<FakeBox> {
    if (this.createError) throw this.createError;
    const box = new FakeBox(spec, this.claude);
    this.boxes.push(box);
    return box;
  }

  /** 最後に作った箱 */
  get lastBox(): FakeBox {
    const box = this.boxes.at(-1);
    if (box === undefined) throw new Error("箱はまだ作られていません");
    return box;
  }
}

export class FakeBox implements Box {
  readonly spec: BoxSpec;
  readonly execCalls: FakeExecCall[] = [];
  /** 偽の Claude Code が投げた例外（テストで「台本が最後まで動いたか」を確かめる） */
  readonly claudeErrors: unknown[] = [];
  /** 判定の結果（request を呼んだ順） */
  readonly decisions: ProxyDecision[] = [];
  killed = 0;
  destroyed = 0;
  readonly #claude: FakeClaude;
  readonly #running = new Set<AbortController>();

  constructor(spec: BoxSpec, claude: FakeClaude) {
    this.spec = spec;
    this.#claude = claude;
  }

  exec(
    cmd: readonly string[],
    opts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
  ): ExecHandle {
    if (this.destroyed > 0) throw new Error("箱はもう壊されています");
    const call = { cmd: [...cmd], cwd: opts.cwd, env: { ...(opts.env ?? {}) } };
    this.execCalls.push(call);
    const abort = new AbortController();
    this.#running.add(abort);
    const lines = new LineQueue();
    const ctx = this.#context(call, abort.signal, lines);

    const exitCode = (async () => {
      const killed = new Promise<"killed">((resolve) => {
        if (abort.signal.aborted) resolve("killed");
        abort.signal.addEventListener("abort", () => resolve("killed"), { once: true });
      });
      const run = (async () => (await this.#claude(ctx)) ?? 0)();
      run.catch((error: unknown) => {
        if (!abort.signal.aborted) this.claudeErrors.push(error);
      });
      try {
        const outcome = await Promise.race([run, killed]);
        return outcome === "killed" ? 137 : outcome;
      } catch (error) {
        lines.push({ stream: "stderr", line: `偽の Claude Code が落ちました: ${String(error)}` });
        return 1;
      } finally {
        this.#running.delete(abort);
        lines.end();
      }
    })();

    return { exitCode, [Symbol.asyncIterator]: () => lines.iterator() };
  }

  async kill(): Promise<void> {
    this.killed += 1;
    for (const abort of this.#running) abort.abort();
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
    for (const abort of this.#running) abort.abort();
  }

  /** 箱の中のパスを、マウントのホスト側のパスにする（いちばん長く一致するマウント） */
  hostPath(guestPath: string): string {
    const mount = [...this.spec.mounts]
      .sort((a, b) => b.guestPath.length - a.guestPath.length)
      .find((m) => guestPath === m.guestPath || guestPath.startsWith(`${m.guestPath}/`));
    if (mount === undefined) throw new Error(`マウントされていない場所です: ${guestPath}`);
    const rest = guestPath.slice(mount.guestPath.length).split("/").filter(Boolean);
    return join(mount.hostPath, ...rest);
  }

  #context(call: FakeExecCall, signal: AbortSignal, lines: LineQueue): FakeClaudeContext {
    const spec = this.spec;
    const box = this;
    const connectMcp = async () => {
      const client = new Client({ name: "fake-claude", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${spec.network.gatewayPort}/mcp`),
        ),
      );
      return client;
    };
    const callTool = async (name: string, args: Record<string, unknown>) => {
      const client = await connectMcp();
      try {
        return (await client.callTool({ name, arguments: args })) as CallToolResult;
      } finally {
        await client.close();
      }
    };
    return {
      spec,
      box,
      cmd: call.cmd,
      cwd: call.cwd,
      env: call.env,
      signal,
      emit(line) {
        if (signal.aborted) return;
        lines.push({
          stream: "stdout",
          line: typeof line === "string" ? line : JSON.stringify(line),
        });
      },
      emitStderr(line) {
        if (signal.aborted) return;
        lines.push({ stream: "stderr", line });
      },
      connectMcp,
      callTool,
      async listTools() {
        const client = await connectMcp();
        try {
          return (await client.listTools()).tools.map((t) => t.name);
        } finally {
          await client.close();
        }
      },
      reportResult: (summary, files) =>
        callTool(
          "report_result",
          files === undefined ? { summary } : { summary, files: [...files] },
        ),
      async request(input) {
        const body =
          typeof input.body === "string" ? new TextEncoder().encode(input.body) : input.body;
        const protocol = input.protocol ?? "https";
        const req: ProxiedRequest = {
          method: input.method ?? "GET",
          protocol,
          host: input.host,
          port: input.port ?? (protocol === "https" ? 443 : 80),
          path: input.path,
          headers: input.headers ?? {},
          bodyBytes: body?.byteLength ?? 0,
          readBody: async () => body ?? new Uint8Array(),
        };
        const decision = await spec.network.onRequest(req);
        box.decisions.push(decision);
        return decision;
      },
      hostPath: (guestPath) => box.hostPath(guestPath),
      sleep(ms) {
        return new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          const timer = setTimeout(resolve, ms);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      },
    };
  }
}

/** exec の出力の行を、読み手が来るまでためておく */
class LineQueue {
  readonly #items: ExecLine[] = [];
  readonly #waiters: ((result: IteratorResult<ExecLine>) => void)[] = [];
  #done = false;

  push(item: ExecLine): void {
    if (this.#done) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  end(): void {
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  iterator(): AsyncIterator<ExecLine> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: () => {
        this.#items.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
