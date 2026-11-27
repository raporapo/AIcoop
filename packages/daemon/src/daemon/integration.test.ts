import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CreateTaskResponse,
  DaemonInfo,
  GetTaskResponse,
  ListAuditResponse,
  StatusResponse,
} from "../api/contract.ts";
import { verifyAuditLog } from "../db/audit.ts";
import { openStateDb } from "../db/open.ts";
import { aicoopPaths } from "../paths.ts";
import { createTestCompany } from "../testing/company.ts";
import { unusedVmDriver } from "../testing/daemon.ts";
import { fakeStartRun, flushMicrotasks } from "../testing/fake-start-run.ts";
import { apiRequest } from "../testing/http.ts";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import { startDaemon } from "./start.ts";

let dir: TempDir | undefined;
afterEach(() => {
  dir?.cleanup();
  dir = undefined;
});

describe("結合：雛形の会社で daemon を動かす", () => {
  it("aicoop init の雛形から作った会社で起動し、CLI と同じく daemon.json・api_token で API を使い、手動タスクが偽の実行で done になる", async () => {
    dir = tempDir();
    const company = createTestCompany(dir.path);
    const paths = aicoopPaths(company.home);
    const fake = fakeStartRun();
    const daemon = await startDaemon({
      home: company.home,
      startRun: fake.startRun,
      drivers: { vm: unusedVmDriver },
      port: 0,
    });

    // CLI がするように、runtime/ のファイルから daemon を見つける
    const info = JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo;
    const token = readFileSync(paths.apiToken, "utf8").trim();
    const api = (req: Parameters<typeof apiRequest>[1]) => apiRequest(info.port, { token, ...req });

    const created = await api({
      method: "POST",
      path: "/tasks",
      body: {
        member: "dev-implementer",
        purpose: "README の誤字を直す",
        done_when: "直した PR の URL を report_result で報告した",
      },
    });
    expect(created.status).toBe(201);
    const { task } = created.json as CreateTaskResponse;
    expect(task.status).toBe("queued");

    await flushMicrotasks();
    const running = (await api({ path: `/tasks/${task.id}` })).json as GetTaskResponse;
    expect(running.task.status).toBe("running");
    const status = (await api({ path: "/status" })).json as StatusResponse;
    expect(status.boxes.running.map((b) => b.task_id)).toEqual([task.id]);
    expect(status.company.id).toBe(company.companyId);

    // 偽の実行が report_result を書いて終わる
    await fake.finish(task.id);
    const done = (await api({ path: `/tasks/${task.id}` })).json as GetTaskResponse;
    expect(done.task).toMatchObject({
      id: task.id,
      status: "done",
      result_summary: "できました",
      result_files: [],
    });
    expect(done.task.ended_at).not.toBeNull();
    const after = (await api({ path: "/status" })).json as StatusResponse;
    expect(after.tasks.done).toBe(1);
    expect(after.boxes.running).toEqual([]);

    // 監査ログに状態の変化が残る
    const audit = (await api({ path: "/audit?limit=1000" })).json as ListAuditResponse;
    expect(
      audit.entries
        .filter((e) => e.kind === "task.state" && e.subject === task.id)
        .map((e) => (e.data as { to: string }).to),
    ).toEqual(["queued", "starting", "running", "done"]);

    // aicoop stop と同じく API で止める
    expect((await api({ method: "POST", path: "/shutdown" })).status).toBe(200);
    await daemon.stopped;

    // P1 完了条件5：監査ログのつながりが確かめられる
    const db = openStateDb(paths.stateDb);
    expect(verifyAuditLog(db)).toMatchObject({ ok: true });
    db.close();
  });
});
