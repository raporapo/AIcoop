/**
 * 準備の画面の Claude へのログイン（5.14 の3の2、5.4.1 の1、CL-24）。
 *
 * 1. `start`：ホストで `claude setup-token` を擬似端末（`script`）の中で動かし、画面に出たログイン用の URL を
 *    読み取って返す。同時に1つだけ。始めてから10分で取り消す（プロセスを止める）
 * 2. `submitCode`：準備の画面に貼られたコードの形を確かめ（制御文字・空白・長すぎるものは拒む）、
 *    setup-token の入力に渡す。setup-token が0で終わり、画面からトークンを読み取れたら、資格 `anthropic`
 *    （`anthropic_oauth`）の変更（署名を待つ。`Settings.proposeSecretChange`）を作り、その ID と要約だけを返す
 * 3. 0以外で終わった・トークンを読み取れない・時間切れなら失敗とし、何も作らない
 *
 * 守ること：
 * - トークン・コード・画面の記録を、応答・ログ・エラーに出さない（11.5）。画面の記録はメモリにだけ持ち、
 *   終わったら捨てる（バッファは0で埋める）
 * - setup-token が自分でブラウザを開かないようにする（`BROWSER=true`）。URL は準備の画面に出す
 */

import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { extractLoginUrl, extractSetupToken, setupTokenArgv } from "@aicoop/shared";
import {
  CLAUDE_LOGIN_TTL_MS,
  type ClaudeLoginState,
  type ClaudeLoginView,
  type CreateSecretChangeResponse,
  MAX_LOGIN_CODE_CHARS,
} from "@aicoop/shared/api";
import type { Logger } from "pino";
import { ApprovalFailure, invalidInput } from "../approvals/errors.ts";
import type { TimerHandle, Timers } from "../timers.ts";
import { type PtyProcess, type SpawnPty, spawnPty } from "./pty.ts";

/** 擬似端末の幅。URL とトークンが折り返されないよう広くする */
export const LOGIN_TERMINAL_COLUMNS = 2000;
/** URL が出るまで待つ長さ */
const URL_TIMEOUT_MS = 60 * 1000;
/** コードを渡してから、setup-token が終わるまで待つ長さ */
const EXCHANGE_TIMEOUT_MS = 60 * 1000;
/** 画面の記録の上限（超えたら古いものから捨てる。URL は先に読み取っている） */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** 終わったログインの状態を覚えておく長さ（準備の画面に結果を出すため。記録は持たない） */
const KEEP_FINISHED_MS = 30 * 60 * 1000;

const CODE = /^[A-Za-z0-9._~#-]{8,}$/;
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const LOGIN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ACTIVE: ReadonlySet<ClaudeLoginState> = new Set(["starting", "waiting_code", "exchanging"]);

export interface ClaudeLoginDeps {
  readonly platform: NodeJS.Platform;
  /** OS のホーム（`~/.local/bin/claude` を探す） */
  readonly userHome: string;
  which(command: string): string | null;
  /** 既定は `spawnPty`（テストで差し替える） */
  readonly spawn?: SpawnPty;
  /** setup-token に渡す環境変数のもと（既定は daemon の process.env） */
  readonly env?: NodeJS.ProcessEnv;
  readonly timers: Timers;
  now(): Date;
  readonly logger: Logger;
  /** トークンから、資格 anthropic（anthropic_oauth）の署名を待つ変更を作る */
  propose(token: string): CreateSecretChangeResponse;
}

export interface ClaudeLogin {
  start(): Promise<ClaudeLoginView>;
  submitCode(id: string, code: unknown): Promise<ClaudeLoginView>;
  cancel(id: string): ClaudeLoginView;
  /** いまの（最後の）ログイン。なければ null */
  current(): ClaudeLoginView | null;
  /** いまのログインの setup-token が終わるまで待つ */
  settled(): Promise<void>;
  /** daemon を止めるとき：動いているログインを取り消す */
  stop(): void;
}

interface Session {
  readonly id: string;
  state: ClaudeLoginState;
  url: string | null;
  readonly startedAt: number;
  readonly expiresAt: number;
  message: string | null;
  change: CreateSecretChangeResponse | null;
  finishedAt: number | null;
  proc: PtyProcess;
  chunks: Buffer[];
  size: number;
  killedByUs: boolean;
  exitCode: number | null | undefined;
  ttl: TimerHandle | undefined;
  onUrl: (() => void) | undefined;
}

const unavailable = (message: string) => new ApprovalFailure(409, "unavailable", message);
const loginFailed = (message: string) => new ApprovalFailure(422, "login_failed", message);

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 貼られたコードの形を確かめる（前後の空白は除く）。中身はエラーに出さない */
export function parseLoginCode(code: unknown): string {
  if (typeof code !== "string")
    throw invalidInput("code（ブラウザに出たコード）を文字列で送ってください");
  const trimmed = code.trim();
  if (trimmed === "")
    throw invalidInput("コードが空です。ブラウザに出たコードを貼り付けてください");
  if (trimmed.length > MAX_LOGIN_CODE_CHARS) {
    throw invalidInput(`コードが長すぎます（${MAX_LOGIN_CODE_CHARS}文字まで）`);
  }
  if (CONTROL.test(trimmed)) {
    throw invalidInput(
      "コードに改行や制御文字が入っています。ブラウザに出たコードだけを貼り付けてください",
    );
  }
  if (!CODE.test(trimmed)) {
    throw invalidInput(
      "コードの形が違います（英数字と - _ . ~ # だけの文字列です）。ブラウザに出たコードをそのまま貼り付けてください",
    );
  }
  return trimmed;
}

const STATE_MESSAGE: Record<ClaudeLoginState, string> = {
  starting: "まだログイン用の URL が出ていません",
  waiting_code: "コードを待っています",
  exchanging: "コードはもう渡しました。トークンを待っています",
  done: "このログインは終わっています",
  failed: "このログインは失敗しました。もう一度始めてください",
  cancelled: "このログインは取り消しました。もう一度始めてください",
  expired: "このログインは、始めてから10分たったので取り消しました。もう一度始めてください",
};

export function createClaudeLogin(deps: ClaudeLoginDeps): ClaudeLogin {
  const { timers, now, logger } = deps;
  const spawn = deps.spawn ?? spawnPty;
  let session: Session | undefined;

  const view = (s: Session): ClaudeLoginView => ({
    id: s.id,
    state: s.state,
    url: s.state === "waiting_code" ? s.url : null,
    started_at: new Date(s.startedAt).toISOString(),
    expires_at: new Date(s.expiresAt).toISOString(),
    message: s.message,
    change: s.change,
  });

  /** 画面の記録を捨てる（バッファは0で埋める） */
  const wipe = (s: Session) => {
    for (const c of s.chunks) c.fill(0);
    s.chunks = [];
    s.size = 0;
  };

  const finish = (s: Session, state: ClaudeLoginState, message: string | null) => {
    s.state = state;
    s.message = message;
    s.url = null;
    s.finishedAt = now().getTime();
    if (s.ttl !== undefined) timers.clearTimeout(s.ttl);
    s.ttl = undefined;
    if (s.exitCode === undefined) {
      s.killedByUs = true;
      s.proc.kill();
    }
    wipe(s);
    s.onUrl?.();
  };

  const findClaude = (): string | null => {
    const found = deps.which("claude");
    if (found) return found;
    // daemon は .profile を読まずに起こされることがある（OP-3）。公式のインストーラーの置き場所も見る
    const local = join(deps.userHome, ".local", "bin", "claude");
    return isExecutable(local) ? local : null;
  };

  const waitFor = <T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> =>
    new Promise((resolve) => {
      const t = timers.setTimeout(() => resolve("timeout"), ms);
      void promise.then((v) => {
        timers.clearTimeout(t);
        resolve(v);
      });
    });

  const active = () => (session !== undefined && ACTIVE.has(session.state) ? session : undefined);

  const login: ClaudeLogin = {
    async start() {
      if (active() !== undefined) {
        throw new ApprovalFailure(
          409,
          "invalid_state",
          "Claude へのログインは、もう始まっています（同時に1つだけです）。取り消してから、もう一度始めてください",
        );
      }
      if (deps.platform === "win32") {
        throw unavailable(
          "Windows では Claude へのログインを始められません。WSL2 の中で制御サーバーを動かしてください（設計書 4.3）",
        );
      }
      const claude = findClaude();
      if (!claude) {
        throw unavailable(
          "Claude Code（claude コマンド）が見つかりません。公式のインストーラーで入れてください：curl -fsSL https://claude.ai/install.sh | bash（入れたあと、制御サーバーを起動し直してください）",
        );
      }
      const script = deps.which("script");
      if (!script) {
        throw unavailable(
          "script コマンド（擬似端末を作るのに使います）が見つかりません。Debian・Ubuntu なら：sudo apt install util-linux",
        );
      }

      const base = deps.env ?? process.env;
      const env: NodeJS.ProcessEnv = {
        ...base,
        // setup-token が自分でブラウザを開かない（URL は準備の画面に出す）
        BROWSER: "true",
        TERM: base.TERM && base.TERM !== "dumb" ? base.TERM : "xterm-256color",
      };
      const argv = setupTokenArgv(deps.platform, script, claude, LOGIN_TERMINAL_COLUMNS);
      const t = now().getTime();
      let proc: PtyProcess;
      try {
        proc = spawn(argv, env);
      } catch {
        throw loginFailed("claude setup-token を起こせませんでした。daemon のログを見てください");
      }
      const s: Session = {
        id: randomUUID(),
        state: "starting",
        url: null,
        startedAt: t,
        expiresAt: t + CLAUDE_LOGIN_TTL_MS,
        message: null,
        change: null,
        finishedAt: null,
        proc,
        chunks: [],
        size: 0,
        killedByUs: false,
        exitCode: undefined,
        ttl: undefined,
        onUrl: undefined,
      };
      session = s;
      const urlFound = new Promise<void>((resolve) => {
        s.onUrl = resolve;
      });

      proc.onData((chunk) => {
        if (!ACTIVE.has(s.state)) {
          chunk.fill(0);
          return;
        }
        s.chunks.push(Buffer.from(chunk));
        chunk.fill(0);
        s.size += chunk.length;
        while (s.size > MAX_OUTPUT_BYTES && s.chunks.length > 1) {
          const old = s.chunks.shift() as Buffer;
          s.size -= old.length;
          old.fill(0);
        }
        if (s.state === "starting") {
          const url = extractLoginUrl(Buffer.concat(s.chunks).toString("utf8"));
          if (url !== null) {
            s.url = url;
            s.state = "waiting_code";
            s.onUrl?.();
          }
        }
      });
      void proc.exited.then((code) => {
        s.exitCode = code;
        s.onUrl?.();
      });
      s.ttl = timers.setTimeout(() => {
        if (!ACTIVE.has(s.state)) return;
        logger.info(
          { login_id: s.id },
          "Claude へのログインを、始めてから10分たったので取り消しました",
        );
        finish(s, "expired", STATE_MESSAGE.expired);
      }, CLAUDE_LOGIN_TTL_MS);
      logger.info({ login_id: s.id }, "Claude へのログインを始めました（claude setup-token）");

      await waitFor(urlFound, URL_TIMEOUT_MS);
      if (s.state !== "waiting_code") {
        if (ACTIVE.has(s.state)) {
          const message =
            s.exitCode === undefined
              ? "claude setup-token がログイン用の URL を出しませんでした（時間切れ）。もう一度始めてください"
              : `claude setup-token がログイン用の URL を出す前に終わりました（終了コード ${s.exitCode ?? "なし"}）。claude が動くか、ターミナルで claude --version を確かめてください`;
          logger.warn(
            { login_id: s.id, exit_code: s.exitCode ?? null },
            "ログイン用の URL を読み取れませんでした",
          );
          finish(s, "failed", message);
          throw loginFailed(message);
        }
        throw new ApprovalFailure(409, "invalid_state", s.message ?? STATE_MESSAGE[s.state]);
      }
      return view(s);
    },

    async submitCode(id, code) {
      const s = session;
      if (s === undefined || !LOGIN_ID.test(id) || s.id !== id) {
        throw new ApprovalFailure(
          404,
          "not_found",
          "そのログインはありません（もう一度始めてください）",
        );
      }
      if (s.state !== "waiting_code") {
        throw new ApprovalFailure(409, "invalid_state", STATE_MESSAGE[s.state]);
      }
      const value = parseLoginCode(code);
      s.state = "exchanging";
      s.proc.write(`${value}\r`);
      logger.info({ login_id: s.id }, "Claude へのログインのコードを setup-token に渡しました");

      const exited = await waitFor(s.proc.exited, EXCHANGE_TIMEOUT_MS);
      if (s.state !== "exchanging") {
        // 待っているあいだに、取り消し・10分の期限が来た
        throw new ApprovalFailure(409, "invalid_state", s.message ?? STATE_MESSAGE[s.state]);
      }
      if (exited === "timeout") {
        const message =
          "コードを渡したあと、claude setup-token が終わりませんでした（コードが違うかもしれません）。何も登録していません。もう一度始めてください";
        logger.warn({ login_id: s.id }, "setup-token がコードのあとで終わらないので止めました");
        finish(s, "failed", message);
        throw loginFailed(message);
      }
      if (exited !== 0 || s.killedByUs) {
        const message = `claude setup-token が失敗しました（終了コード ${exited ?? "なし"}）。コードが違うか、期限が切れています。何も登録していません。もう一度始めてください`;
        logger.warn({ login_id: s.id, exit_code: exited }, "setup-token が0以外で終わりました");
        finish(s, "failed", message);
        throw loginFailed(message);
      }
      const record = Buffer.concat(s.chunks);
      let token: string | null;
      try {
        token = extractSetupToken(record.toString("utf8"), LOGIN_TERMINAL_COLUMNS);
      } finally {
        record.fill(0);
      }
      if (token === null) {
        const message =
          "claude setup-token の画面から、トークンを読み取れませんでした。何も登録していません。資格の画面で、トークンを貼り付けて登録することもできます（claude setup-token をターミナルで動かす）";
        logger.warn({ login_id: s.id }, "setup-token の画面からトークンを読み取れませんでした");
        finish(s, "failed", message);
        throw loginFailed(message);
      }
      let change: CreateSecretChangeResponse;
      try {
        change = deps.propose(token);
      } catch (e) {
        const message =
          e instanceof ApprovalFailure
            ? e.message
            : "資格の変更を作れませんでした（中身は表示しません）。daemon のログを見てください";
        finish(s, "failed", message);
        throw e instanceof ApprovalFailure ? e : loginFailed(message);
      } finally {
        token = null;
      }
      s.change = change;
      finish(s, "done", null);
      logger.info(
        { login_id: s.id, change_id: change.id },
        "Claude のトークンを受け取り、資格 anthropic の変更を作りました（署名を待っています。中身はログに出しません）",
      );
      return view(s);
    },

    cancel(id) {
      const s = session;
      if (s === undefined || !LOGIN_ID.test(id) || s.id !== id) {
        throw new ApprovalFailure(404, "not_found", "そのログインはありません");
      }
      if (ACTIVE.has(s.state)) {
        logger.info({ login_id: s.id }, "Claude へのログインを取り消しました");
        finish(s, "cancelled", "取り消しました。何も登録していません");
      }
      return view(s);
    },

    current() {
      const s = session;
      if (s === undefined) return null;
      if (s.finishedAt !== null && s.finishedAt + KEEP_FINISHED_MS < now().getTime()) {
        session = undefined;
        return null;
      }
      return view(s);
    },

    async settled() {
      if (session !== undefined) await session.proc.exited;
    },

    stop() {
      const s = active();
      if (s !== undefined) finish(s, "cancelled", "制御サーバーを止めたので、取り消しました");
    },
  };
  return login;
}
