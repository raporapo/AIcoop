/**
 * 1つのタスクを1回実行する部品（実行）と、順番待ち・トリガー・API（制御サーバー）の境界。
 *
 * 制御サーバーは、順番が来たタスク（5.5.4）ごとに `StartRun` を呼び、返ってきた `RunHandle` を
 * 「動いている箱」として数える。実行の側は、箱を起こしてから壊すまで（8.1）と、
 * タスクの状態の変化（starting → running → 終わりの状態。5.5.3）を受け持つ。
 */
import type { BoxDriver, BoxKind, CompanyConfig, TaskStatus } from "@aicoop/shared";
import type { Logger } from "pino";
import type { StateDb } from "../db/open.ts";
import type { AicoopPaths } from "../paths.ts";

/** 箱の種類ごとのドライバー。無い種類の部署のタスクは、分かりやすい理由で failed にする */
export type BoxDrivers = Partial<Record<BoxKind, BoxDriver>>;

/** daemon が起動してから止まるまで変わらないもの */
export interface RunEnvironment {
  readonly db: StateDb;
  readonly paths: AicoopPaths;
  readonly drivers: BoxDrivers;
  readonly logger: Logger;
  /** 外への HTTP（資格の発行など）。テストで差し替える */
  readonly fetch?: typeof fetch;
  /** 時刻の元。なければ `db.now` */
  readonly now?: () => Date;
}

export interface RunRequest {
  /** queued のタスク */
  readonly taskId: string;
  /**
   * このタスクに使う設定。タスクが始まったときのものを最後まで使う
   * （6.1：実行中のタスクは、始まったときの設定のまま最後まで動く）
   */
  readonly config: CompanyConfig;
}

export interface RunOutcome {
  readonly taskId: string;
  /** 実行が終わったあとのタスクの状態（done・failed・timeout・waiting_limit など） */
  readonly status: TaskStatus;
  /** 箱を起こす前に失敗したときは null */
  readonly runId: string | null;
}

export type CancelReason =
  /** オーナーが取り消した（aicoop cancel）→ タスクは cancelled */
  | "cancelled"
  /** daemon を止める（aicoop stop）→ タスクは failed（error: daemon_stopped） */
  | "daemon_stop";

export interface RunHandle {
  readonly taskId: string;
  readonly groupId: string;
  readonly memberId: string;
  readonly boxKind: BoxKind;
  /** 順番が来た時刻 */
  readonly startedAt: string;
  /** 実行の ID（箱を起こす前は null） */
  runId(): string | null;
  /** 実行が終わったら解決する。拒否はしない（失敗もタスクの状態として返す） */
  readonly done: Promise<RunOutcome>;
  /** Claude Code を止め、箱を壊して、タスクを理由に合った状態にする。`done` が解決するまで待つ */
  cancel(reason: CancelReason): Promise<void>;
}

/** 順番が来た queued のタスクを1つ実行し始める。すぐに返る（箱の起動などは裏で進む） */
export type StartRun = (env: RunEnvironment, request: RunRequest) => RunHandle;
