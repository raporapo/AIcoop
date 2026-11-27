/**
 * state.db を開く（7.1、11.4）。
 *
 * - better-sqlite3 と Drizzle で使う。ファイルなら WAL モードにする
 * - 表が無ければ作る。版は `PRAGMA user_version` で管理し、足りない分だけを順に作る（`migrations.ts`）
 * - この aicoop より新しい版の state.db、版の記録がないのに表があるデータベースは、触らずにエラーにする
 */
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { MIGRATIONS } from "./migrations.ts";
import * as schema from "./schema.ts";

/** この aicoop が作る state.db の版 */
export const STATE_DB_VERSION = MIGRATIONS.length;

export interface StateDb {
  readonly sqlite: Database.Database;
  readonly orm: BetterSQLite3Database<typeof schema>;
  /** 時刻の元（テストで差し替える） */
  readonly now: () => Date;
  close(): void;
}

export interface OpenStateDbOptions {
  readonly now?: () => Date;
}

export function openStateDb(path: string, options: OpenStateDbOptions = {}): StateDb {
  const sqlite = new Database(path);
  try {
    sqlite.pragma("busy_timeout = 5000");
    if (path !== ":memory:" && path !== "") {
      const mode = sqlite.pragma("journal_mode = WAL", { simple: true });
      if (mode !== "wal") {
        throw new Error(`state.db を WAL モードにできませんでした（${String(mode)}）`);
      }
    }
    migrate(sqlite);
  } catch (e) {
    sqlite.close();
    throw e;
  }

  const orm = drizzle(sqlite, { schema });
  return {
    sqlite,
    orm,
    now: options.now ?? (() => new Date()),
    close: () => sqlite.close(),
  };
}

function migrate(sqlite: Database.Database): void {
  const version = sqlite.pragma("user_version", { simple: true });
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    throw new Error(`state.db の版が読めません: ${String(version)}`);
  }
  if (version > MIGRATIONS.length) {
    throw new Error(
      `state.db の版（${version}）が、この aicoop の版（${MIGRATIONS.length}）より新しいので開きません。aicoop を新しくしてください`,
    );
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v] as string;
    sqlite
      .transaction(() => {
        sqlite.exec(sql);
        sqlite.pragma(`user_version = ${v + 1}`);
      })
      .immediate();
  }
}

/**
 * 書き込みのトランザクション。最初から書き込みの鍵を取る（BEGIN IMMEDIATE）ので、
 * 読んでから書くあいだに、ほかの接続に割り込まれない。中で呼べば SAVEPOINT になる。
 */
export function writeTransaction<T>(db: StateDb, fn: () => T): T {
  return db.sqlite.transaction(fn).immediate();
}
