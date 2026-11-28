/**
 * テスト用：保留・一時権限の仕事（`holds/`）を動かす環境。
 *
 * - 一時ディレクトリの `~/.aicoop`（P2 の会社 `P2_FILES`）と、メモリの中の state.db・進められる時計
 * - 偽の Gmail・GitHub（`fakeServices`）と、登録済みの資格（gmail は google_oauth、github は static_token）
 * - `HoldDeps`（canRun は常に true。onTaskCreated の回数を数える）
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CompanyConfig, newId } from "@aicoop/shared";
import pino from "pino";
import { createHold, type Hold, type NewHoldInput } from "../db/holds.ts";
import type { StateDb } from "../db/open.ts";
import type { HoldDeps } from "../holds/deps.ts";
import { encodeHoldFile, type SavedHoldRequest } from "../holds/hold-file.ts";
import { type AicoopPaths, aicoopPaths } from "../paths.ts";
import { setSecret } from "../secrets/store.ts";
import { type CompanyFiles, loadTestCompany, P2_FILES } from "./company-config.ts";
import { type FakeServices, fakeServices } from "./fake-services.ts";
import { type FakeClock, memoryDb, type TempDir, tempDir } from "./state-db.ts";

export interface HoldTestEnv {
  readonly tmp: TempDir;
  readonly paths: AicoopPaths;
  readonly db: StateDb;
  readonly clock: FakeClock;
  config: CompanyConfig;
  readonly services: FakeServices;
  readonly deps: HoldDeps;
  readonly logs: string[];
  /** onTaskCreated が呼ばれた回数 */
  kicks: number;
  /** 保留を、保存したリクエストのファイルごと作る */
  hold(over?: Partial<NewHoldInput> & { readonly request?: Partial<SavedHoldRequest> }): Hold;
  reload(files: CompanyFiles): CompanyConfig;
  cleanup(): void;
}

export function createHoldTestEnv(files: CompanyFiles = P2_FILES): HoldTestEnv {
  const tmp = tempDir();
  const paths = aicoopPaths(join(tmp.path, ".aicoop"));
  const { db, clock } = memoryDb();
  const services = fakeServices();
  const logs: string[] = [];
  const logger = pino({ level: "debug", base: null }, { write: (l: string) => void logs.push(l) });
  setSecret(paths.secrets, "gmail", "google_oauth", {
    client_id: "cid",
    client_secret: "csecret",
    refresh_token: "1//refresh-REAL",
  });
  setSecret(paths.secrets, "github", "static_token", { token: "github_pat_REALTOKEN0123" });

  const env: HoldTestEnv = {
    tmp,
    paths,
    db,
    clock,
    config: loadTestCompany(paths.home, files),
    services,
    logs,
    kicks: 0,
    deps: {
      db,
      paths,
      config: () => env.config,
      fetch: services.fetch,
      now: db.now,
      logger,
      onTaskCreated: () => {
        env.kicks += 1;
      },
      canRun: () => true,
    },
    hold(over = {}) {
      const { request, ...input } = over;
      const id = input.id ?? newId("hold", db.now().getTime());
      const saved: SavedHoldRequest = {
        method: "POST",
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode('{"raw":"VG86IGFAZXhhbXBsZS5jb20NCg0KaGk"}'),
        auth: { header: "authorization", template: "Bearer GONDOLIN_SECRET_****" },
        ...request,
      };
      mkdirSync(paths.holdsDir, { recursive: true });
      writeFileSync(paths.holdFile(id), encodeHoldFile(saved), { mode: 0o600 });
      return createHold(db, {
        id,
        runId: newId("run"),
        taskId: newId("task"),
        memberId: "sales-mailer",
        groupId: "sales",
        thread: "mail-thread",
        service: "gmail",
        operation: "message.send",
        params: {},
        requestPath: paths.holdFile(id),
        requestBytes: saved.body.byteLength,
        summary: { kind: "default", operation: "gmail.message.send", member_id: "sales-mailer" },
        status: "pending_manager",
        expiresAt: new Date(db.now().getTime() + 72 * 3600_000).toISOString(),
        ...input,
      });
    },
    reload(next) {
      env.config = loadTestCompany(paths.home, next);
      return env.config;
    },
    cleanup() {
      db.close();
      tmp.cleanup();
    },
  };
  return env;
}
