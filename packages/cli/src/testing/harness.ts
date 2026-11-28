/**
 * テスト用：偽の標準入出力・一時ディレクトリの home で、aicoop コマンドを動かす。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../cli.ts";
import type { CliContext, CliDeps, InputStream, OutputStream } from "../context.ts";

export class MemoryOutput implements OutputStream {
  text = "";
  readonly isTTY: boolean;
  readonly columns: number | undefined;
  constructor(isTTY = false, columns?: number) {
    this.isTTY = isTTY;
    this.columns = columns;
  }
  write(text: string): void {
    this.text += text;
  }
}

/** 標準入力の偽物。`data` を渡せばパイプ（読み終わると end）、`tty` なら端末として振る舞う */
export class FakeInput implements InputStream {
  readonly isTTY: boolean;
  rawMode = false;
  rawModeHistory: boolean[] = [];
  private listeners: { data: (chunk: Buffer) => void; end: () => void }[] = [];
  private pending: (Buffer | "end")[] = [];

  /** `open` なら、端末でないパイプでも終わらせずに開いたままにする（ランチャーの標準入力） */
  constructor(
    options: {
      readonly tty?: boolean;
      readonly data?: string | Buffer;
      readonly open?: boolean;
    } = {},
  ) {
    this.isTTY = options.tty === true;
    if (options.data !== undefined) {
      this.pending.push(Buffer.from(options.data), "end");
    } else if (!this.isTTY && options.open !== true) {
      this.pending.push("end");
    }
  }

  setRawMode(mode: boolean): void {
    this.rawMode = mode;
    this.rawModeHistory.push(mode);
  }

  subscribe(onData: (chunk: Buffer) => void, onEnd: () => void): () => void {
    const entry = { data: onData, end: onEnd };
    this.listeners.push(entry);
    queueMicrotask(() => this.flush());
    return () => {
      this.listeners = this.listeners.filter((l) => l !== entry);
    };
  }

  /** 端末に打ち込む（1文字ずつでも、まとめてでも） */
  type(text: string): void {
    this.pending.push(Buffer.from(text));
    this.flush();
  }

  end(): void {
    this.pending.push("end");
    this.flush();
  }

  private flush(): void {
    while (this.listeners.length > 0 && this.pending.length > 0) {
      const next = this.pending.shift() as Buffer | "end";
      for (const l of [...this.listeners]) {
        if (next === "end") l.end();
        else l.data(next);
      }
    }
  }
}

export interface Interrupts {
  /** Ctrl+C を押したことにする */
  fire(): void;
  readonly count: number;
}

export function createInterrupts(): Interrupts & { readonly on: CliDeps["onInterrupt"] } {
  let handlers: (() => void)[] = [];
  return {
    get count() {
      return handlers.length;
    },
    fire() {
      for (const h of [...handlers]) h();
    },
    on(handler) {
      handlers.push(handler);
      return () => {
        handlers = handlers.filter((h) => h !== handler);
      };
    },
  };
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TestCliOptions {
  readonly deps?: Partial<CliDeps>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export interface RunOptions {
  readonly stdin?: FakeInput;
  readonly tty?: boolean;
  readonly columns?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface TestCli {
  /** OS のホームの代わり */
  readonly userHome: string;
  /** `--home` を付けなかったときの設定の置き場所（AICOOP_HOME） */
  readonly home: string;
  readonly interrupts: Interrupts;
  run(args: readonly string[], options?: RunOptions): Promise<RunResult>;
  /** 走らせながら、途中で入力や Ctrl+C を送るとき */
  start(
    args: readonly string[],
    options?: RunOptions,
  ): {
    readonly stdout: MemoryOutput;
    readonly stderr: MemoryOutput;
    readonly done: Promise<RunResult>;
  };
  cleanup(): void;
}

export function createTestCli(options: TestCliOptions = {}): TestCli {
  const userHome = mkdtempSync(join(tmpdir(), "aicoop-cli-"));
  const home = join(userHome, ".aicoop");
  const interrupts = createInterrupts();
  const deps: CliDeps = {
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    onInterrupt: interrupts.on,
    loadDaemonEntry: async () => null,
    createDrivers: async () => ({}),
    buildImage: async () => {
      throw new Error("テストでは buildImage を差し込んでください");
    },
    spawnDaemon: () => {
      throw new Error("テストでは spawnDaemon を差し込んでください");
    },
    isProcessAlive: () => false,
    which: () => null,
    canAccess: () => false,
    launchDetached: async () => false,
    isWsl: () => false,
    runInTerminal: async () => {
      throw new Error("テストでは runInTerminal を差し込んでください");
    },
    ...options.deps,
  };

  const start = (args: readonly string[], runOptions: RunOptions = {}) => {
    const stdout = new MemoryOutput(runOptions.tty ?? false, runOptions.columns);
    const stderr = new MemoryOutput(runOptions.tty ?? false, runOptions.columns);
    const ctx: CliContext = {
      argv: args,
      env: { AICOOP_HOME: home, ...options.env, ...runOptions.env },
      cwd: userHome,
      platform: options.platform ?? "linux",
      arch: "x64",
      userHome,
      stdout,
      stderr,
      stdin: runOptions.stdin ?? new FakeInput(),
      deps,
    };
    const done = run(ctx).then((code) => ({ code, stdout: stdout.text, stderr: stderr.text }));
    return { stdout, stderr, done };
  };

  return {
    userHome,
    home,
    interrupts,
    start,
    run: (args, runOptions) => start(args, runOptions).done,
    cleanup: () => rmSync(userHome, { recursive: true, force: true }),
  };
}
