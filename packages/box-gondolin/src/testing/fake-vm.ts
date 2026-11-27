import type { ExecOptions, VMOptions } from "@earendil-works/gondolin";
import type { GondolinExecProcess, GondolinVm } from "../driver.ts";

/** 単体テスト用の Gondolin の VM の代わり。渡された VMOptions と exec の呼び出しを記録する */
export interface FakeExecScript {
  readonly chunks?: readonly { readonly stream: "stdout" | "stderr"; readonly text: string }[];
  readonly exitCode?: number;
  readonly signal?: number;
  /** true なら、abort されるまで終わらない */
  readonly hang?: boolean;
}

export interface FakeExecCall {
  readonly command: readonly string[];
  readonly options: ExecOptions;
}

export class FakeVm implements GondolinVm {
  readonly options: VMOptions;
  readonly execCalls: FakeExecCall[] = [];
  started = 0;
  closed = 0;
  startError: Error | null = null;
  /** exec ごとの台本。足りなければ空の出力で 0 を返す */
  readonly scripts: FakeExecScript[] = [];
  /** 呼ばれた順に台本を選ぶ代わりに、コマンドから台本を決める */
  scriptFor: ((command: readonly string[]) => FakeExecScript | undefined) | null = null;

  constructor(options: VMOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.started += 1;
    if (this.startError) throw this.startError;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  exec(command: string[], options: ExecOptions = {}): GondolinExecProcess {
    this.execCalls.push({ command: [...command], options });
    const script = this.scriptFor?.(command) ?? this.scripts.shift() ?? {};
    const signal = options.signal;
    let rejectResult: (error: Error) => void = () => {};
    const result = new Promise<{ exitCode: number; signal?: number }>((resolve, reject) => {
      rejectResult = reject;
      if (!script.hang) {
        setTimeout(() => {
          resolve(
            script.signal === undefined
              ? { exitCode: script.exitCode ?? 0 }
              : { exitCode: script.exitCode ?? -1, signal: script.signal },
          );
        }, 1);
      }
    });
    signal?.addEventListener("abort", () => rejectResult(new Error("exec aborted")), {
      once: true,
    });
    const chunks = script.chunks ?? [];
    return {
      result,
      async *output() {
        for (const chunk of chunks) {
          yield { stream: chunk.stream, data: Buffer.from(chunk.text, "utf8") };
        }
        try {
          await result;
        } catch {
          // 中断されたら出力も終わる
        }
      },
    };
  }
}
