import type { Box, BoxDriver, BoxSpec, ExecHandle, ExecLine } from "@aicoop/shared";
import { type ExecOptions, type HttpFetch, VM, type VMOptions } from "@earendil-works/gondolin";
import { killCommand, LineSplitter, pidFile, wrapCommand } from "./exec.ts";
import { createProxyHooks, type ProxyHooks } from "./proxy.ts";
import { assertEnvEntry, toVmOptions } from "./vm-options.ts";

/** Gondolin の VM のうち、このドライバーが使うところ（テストで差し替えるため） */
export interface GondolinVm {
  start(): Promise<void>;
  close(): Promise<void>;
  exec(command: string[], options: ExecOptions): GondolinExecProcess;
}

export interface GondolinExecProcess {
  output(): AsyncIterable<{ readonly stream: "stdout" | "stderr"; readonly data: Uint8Array }>;
  readonly result: Promise<{ readonly exitCode: number; readonly signal?: number }>;
}

export type CreateVm = (options: VMOptions) => Promise<GondolinVm>;

export interface GondolinDriverOptions {
  /** BoxSpec.image がないときのイメージ（`aicoop image build` で作ったもの）。なければ Gondolin の既定 */
  readonly defaultImage?: string;
  /** 資格プロキシの判定（`network.onRequest`）が例外を投げたときに呼ぶ。ログ用 */
  readonly onProxyError?: (error: unknown) => void;
  /** kill で、箱の中で止めたあと exec の終わりを待つ時間（ミリ秒、既定 5000） */
  readonly killGraceMs?: number;
  /** テスト用：Gondolin の VM を作る関数を差し替える */
  readonly createVm?: CreateVm;
  /**
   * テスト用：箱から外へ出る HTTP を送る fetch を差し替える（Gondolin の `fetch`）。
   * 差し替えると、Gondolin は接続先の IP の固定をしない（名前解決のあとの判定はする）。
   */
  readonly upstreamFetch?: HttpFetch;
}

const KILLED_EXIT_CODE = 137;
const KILL_SCRIPT_TIMEOUT_MS = 10_000;

export function createGondolinDriver(options: GondolinDriverOptions = {}): BoxDriver {
  const createVm: CreateVm = options.createVm ?? ((vmOptions) => VM.create(vmOptions));
  const killGraceMs = options.killGraceMs ?? 5000;

  return {
    kind: "vm",
    async create(spec: BoxSpec): Promise<Box> {
      if (spec.kind !== "vm") {
        throw new Error(`この箱のドライバーは vm だけを作ります（kind: ${String(spec.kind)}）`);
      }
      const proxy = createProxyHooks({
        network: spec.network,
        secrets: spec.secrets,
        ...(options.onProxyError === undefined ? {} : { onError: options.onProxyError }),
      });
      let vm: GondolinVm;
      try {
        const vmOptions = toVmOptions({
          spec,
          httpHooks: proxy.httpHooks,
          placeholders: proxy.placeholders,
          ...(options.defaultImage === undefined ? {} : { defaultImage: options.defaultImage }),
          ...(options.upstreamFetch === undefined ? {} : { upstreamFetch: options.upstreamFetch }),
        });
        vm = await createVm(vmOptions);
      } catch (error) {
        proxy.revoke();
        throw error;
      }
      try {
        await vm.start();
      } catch (error) {
        await vm.close().catch(() => {});
        proxy.revoke();
        throw error;
      }
      return new GondolinBox(vm, proxy, killGraceMs);
    },
  };
}

interface RunningExec {
  readonly abort: AbortController;
  readonly exitCode: Promise<number>;
}

class GondolinBox implements Box {
  readonly #vm: GondolinVm;
  readonly #proxy: ProxyHooks;
  readonly #killGraceMs: number;
  readonly #running = new Map<number, RunningExec>();
  #nextId = 0;
  #destroying: Promise<void> | null = null;

  constructor(vm: GondolinVm, proxy: ProxyHooks, killGraceMs: number) {
    this.#vm = vm;
    this.#proxy = proxy;
    this.#killGraceMs = killGraceMs;
  }

  exec(
    cmd: readonly string[],
    opts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
  ): ExecHandle {
    if (this.#destroying !== null) throw new Error("箱はもう壊されています");
    if (opts.env !== undefined) {
      for (const [name, value] of Object.entries(opts.env)) {
        assertEnvEntry(name, value);
        if (Object.hasOwn(this.#proxy.placeholders, name)) {
          throw new Error(`環境変数 ${name} は資格（secrets）と同じ名前なので渡せません`);
        }
      }
    }

    this.#nextId += 1;
    const id = this.#nextId;
    const argv = wrapCommand(cmd, pidFile(id));
    const abort = new AbortController();
    const proc = this.#vm.exec(argv, {
      cwd: opts.cwd,
      ...(opts.env === undefined ? {} : { env: { ...opts.env } }),
      stdout: "pipe",
      stderr: "pipe",
      signal: abort.signal,
    });

    const lines = new LineQueue();
    void pumpLines(proc, lines);

    const exitCode = proc.result.then(
      (result) =>
        result.signal !== undefined && result.signal > 0 ? 128 + result.signal : result.exitCode,
      (error: unknown) => {
        if (abort.signal.aborted) return KILLED_EXIT_CODE;
        throw error;
      },
    );
    // 呼び出し側が exitCode を待たなくても、未処理の拒否で落ちないようにする
    exitCode.catch(() => {});
    this.#running.set(id, { abort, exitCode });
    exitCode.finally(() => this.#running.delete(id)).catch(() => {});

    return {
      exitCode,
      [Symbol.asyncIterator]: () => lines.iterator(),
    };
  }

  async kill(): Promise<void> {
    if (this.#destroying !== null) return;
    const ids = [...this.#running.keys()];
    if (ids.length === 0) return;
    try {
      const proc = this.#vm.exec(killCommand(ids), { stdout: "ignore", stderr: "ignore" });
      await withTimeout(proc.result, KILL_SCRIPT_TIMEOUT_MS);
    } catch {
      // 箱の中で止められなくても、下で待つのをやめる
    }
    const pending = [...this.#running.values()].map((entry) => entry.exitCode);
    await withTimeout(Promise.allSettled(pending), this.#killGraceMs).catch(() => {});
    for (const entry of this.#running.values()) entry.abort.abort();
  }

  destroy(): Promise<void> {
    this.#destroying ??= (async () => {
      for (const entry of this.#running.values()) entry.abort.abort();
      try {
        await this.#vm.close();
      } finally {
        this.#proxy.revoke();
      }
    })();
    return this.#destroying;
  }
}

async function pumpLines(proc: GondolinExecProcess, lines: LineQueue): Promise<void> {
  const splitters = { stdout: new LineSplitter(), stderr: new LineSplitter() };
  try {
    for await (const chunk of proc.output()) {
      for (const line of splitters[chunk.stream].push(chunk.data)) {
        lines.push({ stream: chunk.stream, line });
      }
    }
  } catch {
    // 中断・VM の終了。終了コードは exitCode で伝わる
  } finally {
    for (const stream of ["stdout", "stderr"] as const) {
      for (const line of splitters[stream].end()) lines.push({ stream, line });
    }
    lines.end();
  }
}

/** exec の出力の行を、読み手が来るまでためておく（読まなくてもコマンドが止まらないように） */
class LineQueue {
  readonly #items: ExecLine[] = [];
  readonly #waiters: ((result: IteratorResult<ExecLine>) => void)[] = [];
  #done = false;
  #iterated = false;
  /** 読み手が途中でやめたら、もうためない */
  #discard = false;

  push(item: ExecLine): void {
    if (this.#discard) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  end(): void {
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  iterator(): AsyncIterator<ExecLine> {
    if (this.#iterated) throw new Error("exec の出力は1回だけ読めます");
    this.#iterated = true;
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: () => {
        this.#discard = true;
        this.#items.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("時間切れ")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
