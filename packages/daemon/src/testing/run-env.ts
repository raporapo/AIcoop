/**
 * テスト用：1件の実行（startRun）を動かすための環境をまとめて作る。
 *
 * - 一時ディレクトリの `~/.aicoop`（設定ファイル・prompts・secrets.json）
 * - メモリの中の state.db と、進められる時計
 * - 偽の箱のドライバー（FakeBoxDriver）
 * - ログを配列にためる pino
 *
 * ```ts
 * const t = createTestRunEnv({ claude: async (c) => { await c.reportResult("済"); return 0; } });
 * const task = t.queueTask({ memberId: "dev-implementer" });
 * const outcome = await startRun(t.env, { taskId: task.id, config: t.config }).done;
 * t.cleanup();
 * ```
 */
import { join } from "node:path";
import type { CompanyConfig } from "@aicoop/shared";
import pino from "pino";
import type { StateDb } from "../db/open.ts";
import { createTask, type NewTaskInput, type Task } from "../db/tasks.ts";
import { type AicoopPaths, aicoopPaths } from "../paths.ts";
import type { RunEnvironment } from "../run/types.ts";
import { setSecret } from "../secrets/store.ts";
import { type CompanyFiles, loadTestCompany } from "./company-config.ts";
import { FakeBoxDriver, type FakeClaude } from "./fake-box.ts";
import { type FakeClock, memoryDb, type TempDir, tempDir } from "./state-db.ts";

/** テストで使う Claude のログインのトークン（本物ではない） */
export const TEST_ANTHROPIC_TOKEN = "sk-ant-oat01-TESTTOKEN0123456789abcdefghijklmnop";

export interface TestRunEnvOptions {
  readonly files?: CompanyFiles;
  readonly claude?: FakeClaude;
  /** 登録する Claude のトークン。null なら登録しない */
  readonly anthropicToken?: string | null;
  readonly fetch?: typeof fetch;
}

export interface TestRunEnv {
  readonly tmp: TempDir;
  readonly paths: AicoopPaths;
  readonly db: StateDb;
  readonly clock: FakeClock;
  config: CompanyConfig;
  readonly driver: FakeBoxDriver;
  /** pino が書いたログ（JSON の行） */
  readonly logs: string[];
  /** startRun に渡す環境（テストで drivers などを替えてよい） */
  env: RunEnvironment;
  /** 順番待ち（queued）のタスクを作る */
  queueTask(input: Partial<NewTaskInput> & { readonly memberId: string }): Task;
  /** 設定ファイルを書き直して読み直す */
  reloadConfig(files: CompanyFiles): CompanyConfig;
  /** 資格を登録する */
  setSecret(id: string, kind: Parameters<typeof setSecret>[2], value: unknown): void;
  cleanup(): void;
}

export function createTestRunEnv(options: TestRunEnvOptions = {}): TestRunEnv {
  const tmp = tempDir();
  const paths = aicoopPaths(join(tmp.path, ".aicoop"));
  const { db, clock } = memoryDb();
  const config = loadTestCompany(paths.home, options.files);
  const driver = new FakeBoxDriver(options.claude);
  const logs: string[] = [];
  const logger = pino(
    { level: "debug", base: null },
    { write: (line: string) => void logs.push(line) },
  );
  if (options.anthropicToken !== null) {
    setSecret(paths.secrets, "anthropic", "anthropic_oauth", {
      token: options.anthropicToken ?? TEST_ANTHROPIC_TOKEN,
    });
  }
  const env: RunEnvironment = {
    db,
    paths,
    drivers: { vm: driver },
    logger,
    fetch:
      options.fetch ??
      (async () => {
        throw new Error("テストでは外へ通信しない");
      }),
  };

  const t: TestRunEnv = {
    tmp,
    paths,
    db,
    clock,
    config,
    driver,
    logs,
    env,
    queueTask(input) {
      const groupId =
        input.groupId ??
        ((t.config.members[input.memberId] as { group?: string } | undefined)?.group as string);
      return createTask(db, {
        triggerKind: "manual",
        purpose: "テストの仕事をする",
        doneWhen: "report_result で報告した",
        timeoutMinutes: 45,
        ...input,
        groupId,
      });
    },
    reloadConfig(files) {
      t.config = loadTestCompany(paths.home, files);
      return t.config;
    },
    setSecret(id, kind, value) {
      setSecret(paths.secrets, id, kind, value);
    },
    cleanup() {
      db.close();
      tmp.cleanup();
    },
  };
  return t;
}
