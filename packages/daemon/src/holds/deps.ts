/**
 * 保留・一時権限の仕事（`holds/`）が使うもの。daemon（`daemon/start.ts`）と1件の実行（`run/execute.ts`）が渡す。
 */
import type { CompanyConfig } from "@aicoop/shared";
import type { Logger } from "pino";
import type { StateDb } from "../db/open.ts";
import type { AicoopPaths } from "../paths.ts";

export interface HoldDeps {
  readonly db: StateDb;
  readonly paths: AicoopPaths;
  /** いまの設定（daemon では読み直すと変わる。実行の中では、その実行の設定） */
  readonly config: () => CompanyConfig;
  /** 外への HTTP（再送・要約のための取得・資格の発行） */
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly logger?: Logger;
  /** タスクを作ったとき（順番待ちを見直す） */
  readonly onTaskCreated?: () => void;
  /** その社員のタスクを、この daemon で動かせるか（on_hold_resolved のタスクを作る前に確かめる） */
  readonly canRun: (config: CompanyConfig, memberId: string) => boolean;
}
