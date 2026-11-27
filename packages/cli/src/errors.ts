/**
 * 利用者に見せる失敗。何が起きたか（1行目）と、どうすれば直るか（2行目から）を1〜3行で書く。
 */
import { EXIT, type ExitCode } from "./exit-codes.ts";

export class CliError extends Error {
  override name = "CliError";
  readonly exitCode: ExitCode;
  /** 何が起きたか */
  readonly headline: string;
  /** どうすれば直るか（コマンドの例など） */
  readonly hints: readonly string[];

  constructor(exitCode: ExitCode, headline: string, hints: readonly string[] = []) {
    super(headline);
    this.exitCode = exitCode;
    this.headline = headline;
    this.hints = hints;
  }
}

/** 使い方の誤り（終了コード 2）。コマンドの使い方の行を添える */
export class UsageError extends CliError {
  override name = "UsageError";
  constructor(headline: string, hints: readonly string[] = []) {
    super(EXIT.usage, headline, hints);
  }
}

/** 制御サーバーに接続できない（終了コード 3） */
export class DaemonUnavailableError extends CliError {
  override name = "DaemonUnavailableError";
  constructor(headline = "制御サーバー（daemon）が動いていません", hints?: readonly string[]) {
    super(EXIT.daemonUnavailable, headline, hints ?? ["aicoop start で起動してください"]);
  }
}
