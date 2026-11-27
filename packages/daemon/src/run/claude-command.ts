/**
 * 箱の中の Claude Code の起動のしかた（5.4.2。vm の箱）。
 *
 * ```sh
 * claude -p "<タスク本文>" --output-format stream-json --verbose --model <model> \
 *   --max-turns <n> --mcp-config /etc/aicoop/mcp.json --strict-mcp-config \
 *   --dangerously-skip-permissions [--resume <session_id>]
 * ```
 *
 * `--disallowedTools WebSearch`：WebSearch は Anthropic の側で動き、資格プロキシの判定を通らないので渡さない
 * （T-3。管理設定の `permissions.deny` と重ねて止める）。
 * `--dangerously-skip-permissions` は vm と srt の箱の中でだけ付ける。CEO（none）では付けてはならない（5.11）。
 * このモジュールは vm の箱だけを扱う。
 */
import { GUEST_PATHS } from "./mounts.ts";

/** 箱の環境変数（BoxSpec.env）。本物の資格は入れない */
export const BOX_ENV: Readonly<Record<string, string>> = Object.freeze({
  HOME: GUEST_PATHS.home,
  // 5.2.7 の2
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // vm の箱の中のコマンドは root で動く。Claude Code は root では --dangerously-skip-permissions を断って
  // すぐに終わるので、箱（サンドボックス）の中であることを伝える（箱が安全の境界。5.4.2）
  IS_SANDBOX: "1",
});

export interface ClaudeCommandInput {
  /** タスク本文（5.4.3 の3） */
  readonly prompt: string;
  /** 役職の model（5.4.7） */
  readonly model: string;
  /** 役職の max_turns */
  readonly maxTurns: number;
  /** 続きから始めるセッションID（5.4.5 の4）。なければ null */
  readonly resume: string | null;
}

/** セッションID：UUID などの英数字・`-`・`_`（先頭は英数字）、128文字まで */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;

/** 箱の中から来たセッションIDを、記録して `--resume` に渡してよいか */
export function isSafeSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

export function claudeArgv(input: ClaudeCommandInput): string[] {
  if (!MODEL.test(input.model)) throw new TypeError("モデルの名前が不正です");
  if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1) {
    throw new RangeError("max_turns は1以上の整数にしてください");
  }
  if (input.resume !== null && !isSafeSessionId(input.resume)) {
    throw new TypeError("セッションIDの形が不正です");
  }
  return [
    "claude",
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    input.model,
    "--max-turns",
    String(input.maxTurns),
    "--mcp-config",
    GUEST_PATHS.mcpConfig,
    "--strict-mcp-config",
    "--disallowedTools",
    "WebSearch",
    "--dangerously-skip-permissions",
    ...(input.resume === null ? [] : ["--resume", input.resume]),
  ];
}

/**
 * `claude` の実行に渡す環境変数。Claude のログインのトークンは、P-2 の唯一の例外として本物を渡す（5.4.1 の2）。
 * 箱全体の環境変数ではなく、この実行にだけ渡す。
 */
export function claudeExecEnv(anthropicToken: string): Record<string, string> {
  return { ...BOX_ENV, CLAUDE_CODE_OAUTH_TOKEN: anthropicToken };
}
