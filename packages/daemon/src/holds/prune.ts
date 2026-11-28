/**
 * 片付け：決まった保留のファイル（`state/holds/<id>.bin` と再送の結果 `<id>.response.bin`）を消す。
 * daemon の1日1回の片付け（`daemon/start.ts`）から呼ぶ。
 *
 * - 対象は、結果の出た保留（`replayed`・`replay_failed`・`rejected`・`expired`）だけ。決まった時刻
 *   （`resolved_at`、なければ `decided_at`）から `HOLD_FILE_RETENTION_DAYS` 日を過ぎたもの
 * - まだ決まっていない（`pending_manager`・`pending_owner`）・承認されて送る前か送っている途中（`approved`）の
 *   保留のファイルは、どれだけ古くても消さない（送るもの・見せるものが消えないように）
 * - state.db の行（状態・要約・部長のコメント・応答のステータス）は残す。監査ログ・API の一覧は変わらない
 *   （`GET /holds/{id}` の元のリクエストと再送の結果の本文は、読めないものとして空で返る）
 * - 行のない保留のファイル（保存してから保留を作るまでに daemon が落ちたもの）は、ファイルの時刻から同じ日数で消す
 * - 消すファイルの場所は、行に書いたパスではなく、保留の ID から決める（`paths.holdFile`）。リンクはたどらない
 */
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isId } from "@aicoop/shared";
import { HOLD_RESULT_STATUSES } from "../db/holds.ts";
import { holds } from "../db/schema.ts";
import type { HoldDeps } from "./deps.ts";

/** 決まった保留のファイルを残す日数 */
export const HOLD_FILE_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
/** `state/holds/` の中の、保留のファイルの名前 */
const HOLD_FILE_NAME = /^(h_[0-9A-Z]{26})(?:\.response)?\.bin$/;

export interface PruneHoldFilesResult {
  /** ファイルを消した保留（行のあるもの） */
  readonly holds: readonly string[];
  /** ファイルを消した、行のない保留の ID */
  readonly orphans: readonly string[];
}

/** ファイルがあれば（リンクならリンクそのものを）消して true */
function removeFile(path: string): boolean {
  try {
    lstatSync(path);
  } catch {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

export function pruneResolvedHoldFiles(
  deps: Pick<HoldDeps, "db" | "paths" | "now" | "logger">,
  opts: { readonly retentionDays?: number } = {},
): PruneHoldFilesResult {
  const cutoff = deps.now().getTime() - (opts.retentionDays ?? HOLD_FILE_RETENTION_DAYS) * DAY_MS;

  const rows = deps.db.orm
    .select({
      id: holds.id,
      status: holds.status,
      resolvedAt: holds.resolvedAt,
      decidedAt: holds.decidedAt,
    })
    .from(holds)
    .all();
  const known = new Set(rows.map((r) => r.id));

  const pruned: string[] = [];
  for (const row of rows) {
    if (!HOLD_RESULT_STATUSES.includes(row.status) || !isId(row.id, "hold")) continue;
    const at = Date.parse(row.resolvedAt ?? row.decidedAt ?? "");
    // いつ決まったか読めないものは、消さない（残す側）
    if (Number.isNaN(at) || at > cutoff) continue;
    const a = removeFile(deps.paths.holdFile(row.id));
    const b = removeFile(deps.paths.holdResponseFile(row.id));
    if (a || b) pruned.push(row.id);
  }

  const orphans = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(deps.paths.holdsDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    const id = HOLD_FILE_NAME.exec(name)?.[1];
    if (id === undefined || known.has(id) || !isId(id, "hold")) continue;
    const path = join(deps.paths.holdsDir, name);
    let mtime: number;
    try {
      mtime = lstatSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (mtime > cutoff) continue;
    if (removeFile(path)) orphans.add(id);
  }

  if (pruned.length + orphans.size > 0) {
    deps.logger?.info(
      { holds: pruned.length, orphans: orphans.size },
      `決まってから${opts.retentionDays ?? HOLD_FILE_RETENTION_DAYS}日を過ぎた保留のファイルを消しました（state.db の記録は残します）`,
    );
  }
  return { holds: pruned, orphans: [...orphans] };
}
