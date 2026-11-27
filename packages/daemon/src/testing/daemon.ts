/**
 * テスト用：一時ディレクトリに雛形から会社を作り、偽の実行で daemon を起動する。
 */
import type { BoxDriver } from "@aicoop/shared";
import { type DaemonHandle, type StartDaemonOptions, startDaemon } from "../daemon/start.ts";
import type { StartRun } from "../run/types.ts";
import { createTestCompany, type TestCompany } from "./company.ts";
import { type FakeStartRun, fakeStartRun } from "./fake-start-run.ts";
import { apiRequest, type TestRequest, type TestResponse } from "./http.ts";
import { type TempDir, tempDir } from "./state-db.ts";

/** 箱を起こさない vm のドライバー（偽の実行は使わない） */
export const unusedVmDriver: BoxDriver = {
  kind: "vm",
  create: () => Promise.reject(new Error("テストでは箱を起こしません")),
};

export interface TestDaemon {
  readonly dir: TempDir;
  readonly company: TestCompany;
  readonly fake: FakeStartRun;
  readonly daemon: DaemonHandle;
  /** トークンつきで API を呼ぶ */
  api(req: TestRequest): Promise<TestResponse>;
  /** daemon を止めて、一時ディレクトリを消す */
  cleanup(): Promise<void>;
}

export interface TestDaemonOptions {
  readonly company?: Parameters<typeof createTestCompany>[1];
  readonly fake?: FakeStartRun;
  readonly startRun?: StartRun;
  readonly daemon?: Partial<StartDaemonOptions>;
  /** すでに作った会社を使う */
  readonly existing?: { readonly dir: TempDir; readonly company: TestCompany };
}

export async function startTestDaemon(opts: TestDaemonOptions = {}): Promise<TestDaemon> {
  const dir = opts.existing?.dir ?? tempDir();
  const company = opts.existing?.company ?? createTestCompany(dir.path, opts.company);
  const fake = opts.fake ?? fakeStartRun({ auto: true });
  let daemon: DaemonHandle;
  try {
    daemon = await startDaemon({
      home: company.home,
      startRun: opts.startRun ?? fake.startRun,
      drivers: { vm: unusedVmDriver },
      port: 0,
      ...opts.daemon,
    });
  } catch (e) {
    if (opts.existing === undefined) dir.cleanup();
    throw e;
  }
  return {
    dir,
    company,
    fake,
    daemon,
    api: (req) => apiRequest(daemon.port, { token: daemon.token, ...req }),
    async cleanup() {
      await daemon.stop();
      dir.cleanup();
    },
  };
}
