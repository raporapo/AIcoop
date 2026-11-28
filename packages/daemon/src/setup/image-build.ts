/**
 * 準備の画面の「箱のイメージ」（5.14 の3の4、5.1.8）：`aicoop image build` と同じことを daemon から行う。
 *
 * - Gondolin を daemon から直接呼ばない（4.4 の境界）。作る部品（`ImageBuildRunner`）は CLI が差し込む
 *   （`aicoop daemon` が、`aicoop image build` を子のプロセスで動かすものを渡す）
 * - 同時に1つだけ。進み具合（段階と、ログの最後の行）をメモリにだけ持つ
 * - Windows（win32）では作れない（Gondolin は Linux・macOS だけ）
 * - 監査ログには書かない（`aicoop image build` も書かない。5.10 の表にない）。daemon のログに始めと終わりを書く
 */
import { randomUUID } from "node:crypto";
import { visibleText } from "@aicoop/shared";
import {
  type ImageBuildView,
  MAX_IMAGE_BUILD_LINE_CHARS,
  MAX_IMAGE_BUILD_LINES,
} from "@aicoop/shared/api";
import type { Logger } from "pino";
import { ApprovalFailure } from "../approvals/errors.ts";

/**
 * `aicoop image build`（--group なし：ベースと、packages を書いた vm の部署のもの）を動かす。
 * 出力を1行ずつ `onLine` に渡し、終わったら終了コードで解決する。`signal` が来たら止める
 */
export type ImageBuildRunner = (input: {
  readonly home: string;
  readonly onLine: (line: string) => void;
  readonly signal: AbortSignal;
}) => Promise<{ readonly exitCode: number | null }>;

export interface ImageBuildsDeps {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly runner?: ImageBuildRunner;
  now(): Date;
  readonly logger: Logger;
}

export interface ImageBuilds {
  /** 作り始める（202）。作っているあいだは 409 */
  start(): ImageBuildView;
  current(): ImageBuildView | null;
  /** daemon を止めるとき：作っているものを止めて待つ */
  stop(): Promise<void>;
}

/** `aicoop image build` が出す段階の行：`[1/2] ベースのイメージを作っています…` */
const STAGE = /^\[(\d{1,3})\/(\d{1,3})\]\s*(.+?)(?:….*)?$/;
// 表示に使わない文字（制御文字・書式文字）
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

interface Build {
  readonly id: string;
  state: ImageBuildView["state"];
  stage: ImageBuildView["stage"];
  lines: string[];
  readonly startedAt: string;
  finishedAt: string | null;
  message: string | null;
  readonly abort: AbortController;
  done: Promise<void>;
}

export function createImageBuilds(deps: ImageBuildsDeps): ImageBuilds {
  const { logger, now } = deps;
  let build: Build | undefined;

  const view = (b: Build): ImageBuildView => ({
    id: b.id,
    state: b.state,
    stage: b.stage,
    lines: [...b.lines],
    started_at: b.startedAt,
    finished_at: b.finishedAt,
    message: b.message,
  });

  const unavailable = (message: string) => new ApprovalFailure(409, "unavailable", message);

  const addLine = (b: Build, raw: string) => {
    if (b.state !== "running") return;
    const line = visibleText(raw).replace(UNPRINTABLE, "").trimEnd();
    if (line.trim() === "") return;
    const m = STAGE.exec(line.trim());
    if (m) b.stage = { index: Number(m[1]), total: Number(m[2]), label: (m[3] ?? "").trim() };
    b.lines.push(
      line.length > MAX_IMAGE_BUILD_LINE_CHARS
        ? `${line.slice(0, MAX_IMAGE_BUILD_LINE_CHARS)}…`
        : line,
    );
    if (b.lines.length > MAX_IMAGE_BUILD_LINES)
      b.lines.splice(0, b.lines.length - MAX_IMAGE_BUILD_LINES);
  };

  return {
    start() {
      if (build?.state === "running") {
        throw new ApprovalFailure(
          409,
          "invalid_state",
          "箱のイメージは、いま作っています（同時に1つだけです）。終わるまで待ってください",
        );
      }
      if (deps.platform === "win32") {
        throw unavailable(
          "Windows では vm の箱のイメージを作れません（Gondolin は Linux・macOS で動きます）。WSL2 の中で制御サーバーを動かしてください（設計書 4.3）",
        );
      }
      const runner = deps.runner;
      if (runner === undefined) {
        throw unavailable(
          "この制御サーバーは、イメージを作れません（aicoop daemon・aicoop start で起動したものだけが作れます）。ターミナルで aicoop image build を実行してください",
        );
      }
      const b: Build = {
        id: randomUUID(),
        state: "running",
        stage: null,
        lines: [],
        startedAt: now().toISOString(),
        finishedAt: null,
        message: null,
        abort: new AbortController(),
        done: Promise.resolve(),
      };
      build = b;
      logger.info(
        { build_id: b.id },
        "箱のイメージを作り始めました（準備の画面。aicoop image build）",
      );
      const end = (state: "succeeded" | "failed", message: string) => {
        if (b.state !== "running") return;
        b.state = state;
        b.message = message;
        b.finishedAt = now().toISOString();
      };
      b.done = (async () => {
        try {
          const { exitCode } = await runner({
            home: deps.home,
            onLine: (line) => addLine(b, line),
            signal: b.abort.signal,
          });
          if (b.abort.signal.aborted) {
            end("failed", "制御サーバーを止めたので、イメージを作るのを止めました");
          } else if (exitCode === 0) {
            end("succeeded", "箱のイメージを作りました。次の実行から使います");
          } else {
            end(
              "failed",
              `イメージを作れませんでした（終了コード ${exitCode ?? "なし"}）。ログの最後の行を見てください`,
            );
          }
        } catch (error) {
          logger.error(
            { err: error, build_id: b.id },
            "箱のイメージを作る途中でエラーが起きました",
          );
          end("failed", "イメージを作る途中でエラーが起きました。daemon のログを見てください");
        }
        logger.info(
          { build_id: b.id, state: b.state },
          b.state === "succeeded" ? "箱のイメージを作りました" : "箱のイメージを作れませんでした",
        );
      })();
      return view(b);
    },

    current: () => (build === undefined ? null : view(build)),

    async stop() {
      if (build?.state !== "running") return;
      build.abort.abort();
      await build.done;
    },
  };
}
