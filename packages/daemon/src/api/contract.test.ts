import { describe, expect, it } from "vitest";
import { createRun } from "../db/runs.ts";
import { createTask, recordTaskResult, transitionTask } from "../db/tasks.ts";
import { memoryDb } from "../testing/state-db.ts";
import { toRunView, toTaskView } from "./contract.ts";

const { db } = memoryDb();

describe("9.2：state.db の行を API の形にする", () => {
  it("タスクは snake_case になり、result_files は配列、context_untrusted は真偽値", () => {
    const task = createTask(db, {
      memberId: "dev-implementer",
      groupId: "dev",
      triggerKind: "manual",
      purpose: "目的",
      doneWhen: "完了",
      context: "背景",
      contextUntrusted: true,
      timeoutMinutes: 45,
    });
    transitionTask(db, task.id, "starting");
    transitionTask(db, task.id, "running");
    const done = recordTaskResult(db, task.id, { summary: "できた", files: ["notes/a.md"] });
    const view = toTaskView(done);
    expect(view).toMatchObject({
      id: task.id,
      member_id: "dev-implementer",
      group_id: "dev",
      trigger_kind: "manual",
      thread: `task-${task.id}`,
      context_untrusted: true,
      result_summary: "できた",
      result_files: ["notes/a.md"],
      timeout_minutes: 45,
    });
    expect(Object.keys(view).every((k) => /^[a-z_]+$/.test(k))).toBe(true);
  });

  it("実行も snake_case になる", () => {
    const task = createTask(db, {
      memberId: "dev-implementer",
      groupId: "dev",
      triggerKind: "manual",
      purpose: "p",
      doneWhen: "d",
      timeoutMinutes: 10,
    });
    const run = createRun(db, {
      taskId: task.id,
      groupId: "dev",
      memberId: "dev-implementer",
      boxKind: "vm",
      gatewayPort: 50123,
      logDir: "/tmp/logs",
    });
    expect(toRunView(run)).toMatchObject({
      id: run.id,
      task_id: task.id,
      box_kind: "vm",
      gateway_port: 50123,
      end_reason: null,
    });
  });
});
