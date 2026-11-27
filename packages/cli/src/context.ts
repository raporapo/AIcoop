/**
 * コマンドが外の世界に触れるところ（標準入出力・環境変数・時計・HTTP・プロセス）。
 * テストでは偽物を差し込む（`src/testing/harness.ts`）。
 */
import type { BuildImageOptions, BuildImageResult } from "@aicoop/box-gondolin";
import type { BoxDrivers } from "@aicoop/daemon";
import type { DaemonEntry } from "./commands/daemon-entry.ts";

export interface OutputStream {
  write(text: string): void;
  readonly isTTY: boolean;
  /** 端末の幅（分からなければ undefined） */
  readonly columns?: number | undefined;
}

/** 標準入力。端末なら setRawMode で、打った文字を画面に出さずに読める */
export interface InputStream {
  readonly isTTY: boolean;
  setRawMode?(mode: boolean): void;
  /** 届いた分を渡す。戻り値で受け取りをやめる */
  subscribe(onData: (chunk: Buffer) => void, onEnd: () => void): () => void;
}

/** `aicoop start` が裏で起こした daemon */
export interface SpawnedDaemon {
  readonly pid: number;
  /** 終わったら終了コード（シグナルなら null）で解決する */
  readonly exited: Promise<number | null>;
}

export interface CliDeps {
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  /** Ctrl+C（SIGINT・SIGTERM）を受けたら呼ぶ。戻り値で登録を外す */
  readonly onInterrupt: (handler: () => void) => () => void;
  /** 制御サーバーの本体（`@aicoop/daemon` の startDaemon と、実行の startRun） */
  readonly loadDaemonEntry: () => Promise<DaemonEntry | null>;
  /** 箱のドライバー（vm は Gondolin） */
  readonly createDrivers: (home: string, platform: NodeJS.Platform) => Promise<BoxDrivers>;
  readonly buildImage: (options: BuildImageOptions) => Promise<BuildImageResult>;
  /** `aicoop daemon --background --home <home>` を裏で起こす。標準出力・標準エラーは logFile へ */
  readonly spawnDaemon: (home: string, logFile: string) => SpawnedDaemon;
  readonly isProcessAlive: (pid: number) => boolean;
  /** PATH から実行ファイルを探す（見つからなければ null） */
  readonly which: (command: string) => string | null;
  /** ファイルが読み書きできるか（/dev/kvm の確認） */
  readonly canAccess: (path: string) => boolean;
}

export interface CliContext {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** OS のホームディレクトリ（`~` の展開に使う） */
  readonly userHome: string;
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly stdin: InputStream;
  readonly deps: CliDeps;
}
