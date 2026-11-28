/**
 * 本物の世界（process の標準入出力・環境変数・シグナル・子プロセス）を CliContext にして、run に渡す。
 */
import { spawn } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";
import { loadDaemonEntry } from "./commands/daemon-entry.ts";
import type { CliContext, CliDeps, InputStream, OutputStream } from "./context.ts";

/** bin/aicoop.ts（aicoop start が、裏で aicoop daemon を起こすのに使う） */
export const BIN_PATH = fileURLToPath(new URL("../bin/aicoop.ts", import.meta.url));

function outputOf(stream: NodeJS.WriteStream): OutputStream {
  return {
    write: (text) => {
      stream.write(text);
    },
    isTTY: stream.isTTY === true,
    get columns() {
      return stream.isTTY ? stream.columns : undefined;
    },
  };
}

function stdinOf(stream: NodeJS.ReadStream): InputStream {
  const isTTY = stream.isTTY === true;
  return {
    isTTY,
    ...(isTTY && { setRawMode: (mode: boolean) => void stream.setRawMode(mode) }),
    subscribe(onData, onEnd) {
      const data = (chunk: Buffer | string) =>
        onData(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      stream.on("data", data);
      stream.on("end", onEnd);
      stream.resume();
      return () => {
        stream.off("data", data);
        stream.off("end", onEnd);
        stream.pause();
      };
    },
  };
}

function which(command: string): string | null {
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())]
      : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, command + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // 次の候補へ
      }
    }
  }
  return null;
}

export const realDeps: CliDeps = {
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onInterrupt: (handler) => {
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    return () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    };
  },
  loadDaemonEntry,
  createDrivers: async (home, platform) => {
    // Gondolin（vm）は Linux・macOS でしか動かない（4.3 の4、11.1）
    if (platform === "win32") return {};
    const { createGondolinDriver, imageDir } = await import("@aicoop/box-gondolin");
    const base = imageDir(home);
    return { vm: createGondolinDriver(existsSync(base) ? { defaultImage: base } : {}) };
  },
  buildImage: async (options) => {
    const { buildImage } = await import("@aicoop/box-gondolin");
    return buildImage(options);
  },
  spawnDaemon: (home, logFile) => {
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a", 0o600);
    try {
      const child = spawn(process.execPath, [BIN_PATH, "daemon", "--background", "--home", home], {
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        env: process.env,
      });
      const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
        child.once("error", () => resolve(null));
      });
      child.unref();
      return { pid: child.pid ?? -1, exited };
    } finally {
      closeSync(fd);
    }
  },
  isProcessAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  which,
  runInTerminal: (argv) =>
    new Promise((resolve) => {
      const [command, ...args] = argv;
      const chunks: Buffer[] = [];
      const child = spawn(command as string, args, {
        stdio: ["inherit", "pipe", "inherit"],
        env: process.env,
      });
      child.stdout.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk);
        chunks.push(chunk);
      });
      let settled = false;
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        const output = Buffer.concat(chunks);
        resolve({ exitCode, output: output.toString("utf8") });
        // 記録（トークンを含む）のバッファは0で埋める（返した文字列の写しは、GC まで残る）
        output.fill(0);
        for (const c of chunks) c.fill(0);
      };
      child.once("error", () => finish(null));
      child.once("close", (code) => finish(code));
    }),
  canAccess: (path) => {
    try {
      accessSync(path, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

export function realContext(argv: readonly string[]): CliContext {
  return {
    argv,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    arch: process.arch,
    userHome: homedir(),
    stdout: outputOf(process.stdout),
    stderr: outputOf(process.stderr),
    stdin: stdinOf(process.stdin),
    deps: realDeps,
  };
}

/** `aicoop <argv>` を実行して、終了コードを返す */
export function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return run(realContext(argv));
}
