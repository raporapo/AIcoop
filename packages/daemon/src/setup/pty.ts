/**
 * 準備の画面の Claude へのログイン（5.14 の3の2）で、`script … claude setup-token` を動かすプロセス。
 *
 * - シェルは通さない（argv をそのまま渡す）
 * - 標準入力は開いたまま（コードを渡す）。標準出力・標準エラーは呼ぶ側に渡す（メモリにだけ持つ）
 * - 止めるときは、プロセスのグループごと止める（script の中の claude も。Linux・macOS）。
 *   SIGTERM のあと2秒で終わらなければ SIGKILL
 */
import { spawn } from "node:child_process";

export interface PtyProcess {
  /** 標準入力に書く（終わったあとは何もしない） */
  write(data: string): void;
  /** 止める（何度呼んでもよい） */
  kill(): void;
  /** 標準出力・標準エラーに来たもの */
  onData(listener: (chunk: Buffer) => void): void;
  /** 終わったら終了コード（シグナル・起こせなかったときは null）で解決する */
  readonly exited: Promise<number | null>;
}

export type SpawnPty = (argv: readonly string[], env: NodeJS.ProcessEnv) => PtyProcess;

const KILL_GRACE_MS = 2000;

export const spawnPty: SpawnPty = (argv, env) => {
  const [command, ...args] = argv;
  if (command === undefined) throw new Error("argv が空です");
  const group = process.platform !== "win32";
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    detached: group,
    windowsHide: true,
  });
  const listeners: Array<(chunk: Buffer) => void> = [];
  const emit = (chunk: Buffer) => {
    for (const l of listeners) l(chunk);
  };
  child.stdout?.on("data", emit);
  child.stderr?.on("data", emit);
  // 終わったプロセスの標準入力に書いたときの EPIPE などで、daemon を落とさない
  child.stdin?.on("error", () => {});
  let done = false;
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => {
      done = true;
      resolve(null);
    });
    child.once("close", (code) => {
      done = true;
      resolve(code);
    });
  });

  const signal = (sig: NodeJS.Signals) => {
    if (done) return;
    try {
      if (group && child.pid !== undefined) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // もう終わっている
      }
    }
  };

  return {
    write(data) {
      if (done || child.stdin === null || child.stdin.destroyed) return;
      child.stdin.write(data);
    },
    kill() {
      if (done) return;
      signal("SIGTERM");
      const t = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
      t.unref();
      void exited.then(() => clearTimeout(t));
    },
    onData(listener) {
      listeners.push(listener);
    },
    exited,
  };
};
