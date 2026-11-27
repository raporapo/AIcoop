import { join } from "node:path";
import { isId } from "@aicoop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeClock, memoryDb } from "../testing/state-db.ts";
import type { StateDb } from "./open.ts";
import {
  createRun,
  finishRun,
  getRun,
  listOpenRuns,
  listRunsForTask,
  RunNotFoundError,
  RunStateError,
  setRunSessionId,
} from "./runs.ts";
import { createTask, TaskNotFoundError } from "./tasks.ts";

const LOG_DIR = join("home", ".aicoop", "logs", "runs");

describe("7.2：実行（runs）", () => {
  let db: StateDb;
  let clock: FakeClock;
  let taskId: string;
  beforeEach(() => {
    ({ db, clock } = memoryDb());
    taskId = createTask(db, {
      memberId: "dev-implementer",
      groupId: "dev",
      triggerKind: "manual",
      purpose: "p",
      doneWhen: "d",
      timeoutMinutes: 45,
    }).id;
  });
  afterEach(() => db.close());

  const input = () => ({
    taskId,
    groupId: "dev",
    memberId: "dev-implementer",
    boxKind: "vm" as const,
    gatewayPort: 50123,
    logDir: LOG_DIR,
  });

  it("ID（r_）・始めた時刻・記録のパス（logs/runs/<run_id>.jsonl）を付けて作る", () => {
    const run = createRun(db, input());
    expect(isId(run.id, "run")).toBe(true);
    expect(run).toMatchObject({
      taskId,
      groupId: "dev",
      memberId: "dev-implementer",
      boxKind: "vm",
      sessionId: null,
      gatewayPort: 50123,
      startedAt: "2026-11-28T00:00:00.000Z",
      endedAt: null,
      exitCode: null,
      endReason: null,
      logPath: join(LOG_DIR, `${run.id}.jsonl`),
    });
    expect(getRun(db, run.id)).toEqual(run);
  });

  it("続きから始めるときは、使うセッション ID を書ける", () => {
    expect(createRun(db, { ...input(), sessionId: "sess-1" }).sessionId).toBe("sess-1");
  });

  it("終了：終わった時刻・終了コード・終わり方を書く", () => {
    const run = createRun(db, input());
    clock.advance(60_000);
    const ended = finishRun(db, run.id, { exitCode: 0, endReason: "exited" });
    expect(ended).toMatchObject({
      endedAt: "2026-11-28T00:01:00.000Z",
      exitCode: 0,
      endReason: "exited",
    });
  });

  it("時間切れ・強制終了では終了コードがなくてもよい", () => {
    const run = createRun(db, input());
    expect(finishRun(db, run.id, { exitCode: null, endReason: "timeout" }).exitCode).toBeNull();
  });

  it("終わった実行は、もう一度終われない", () => {
    const run = createRun(db, input());
    finishRun(db, run.id, { exitCode: 0, endReason: "exited" });
    expect(() => finishRun(db, run.id, { exitCode: 1, endReason: "killed" })).toThrow(
      RunStateError,
    );
    expect(getRun(db, run.id)?.endReason).toBe("exited");
  });

  it("5.4.5 の3：最初の init イベントのセッション ID を書く", () => {
    const run = createRun(db, input());
    expect(setRunSessionId(db, run.id, "4f1c-session").sessionId).toBe("4f1c-session");
  });

  it("タスクごとの実行と、終わっていない実行の一覧", () => {
    const a = createRun(db, input());
    clock.advance(1);
    finishRun(db, a.id, { exitCode: 0, endReason: "exited" });
    const b = createRun(db, input());
    expect(listRunsForTask(db, taskId).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(listOpenRuns(db).map((r) => r.id)).toEqual([b.id]);
  });

  describe("形の違う値では作らない・書かない", () => {
    it.each([
      ["ないタスク", { taskId: "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB" }, TaskNotFoundError],
      ["タスクの ID でない", { taskId: "r_01JD6V8X3S0Q5W7KQ9M2T4R6YB" }, TypeError],
      ["ポートが0", { gatewayPort: 0 }, RangeError],
      ["ポートが65535を超える", { gatewayPort: 65536 }, RangeError],
      ["知らない箱の種類", { boxKind: "docker" }, TypeError],
      ["社員IDの形が違う", { memberId: "Dev Implementer" }, TypeError],
      ["空のセッション ID", { sessionId: "" }, TypeError],
    ] as const)("%s", (_label, patch, error) => {
      expect(() => createRun(db, { ...input(), ...patch } as never)).toThrow(error);
    });

    it("知らない終わり方", () => {
      const run = createRun(db, input());
      expect(() => finishRun(db, run.id, { exitCode: 0, endReason: "crashed" as never })).toThrow(
        TypeError,
      );
    });

    it("ない実行", () => {
      expect(() =>
        finishRun(db, "r_01JD6V8X3S0Q5W7KQ9M2T4R6YB", { exitCode: 0, endReason: "exited" }),
      ).toThrow(RunNotFoundError);
    });
  });
});
