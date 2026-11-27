import { describe, expect, it } from "vitest";
import {
  canTransitionTask,
  isTaskStatus,
  isTerminalTaskStatus,
  TASK_STATUSES,
  type TaskStatus,
} from "./task-state.ts";

// 5.5.3 の図にある変化
const DIAGRAM: readonly [TaskStatus, TaskStatus][] = [
  ["queued", "starting"],
  ["starting", "running"],
  ["running", "done"],
  ["running", "done_without_report"],
  ["running", "failed"],
  ["running", "timeout"],
  ["running", "waiting_limit"],
  ["running", "blocked_host_tool"],
  ["waiting_limit", "queued"],
  ["blocked_host_tool", "queued"],
  ["queued", "cancelled"],
];

// 図にはないが、設計書のほかの節から要る変化（決定として記録する）
const EXTRA: readonly [TaskStatus, TaskStatus, string][] = [
  ["starting", "queued", "8.6 の3：制御サーバーの再起動で starting を queued に戻す"],
  ["starting", "failed", "箱の起動に失敗した"],
  ["starting", "cancelled", "9.1：aicoop cancel は「動いていれば止める」"],
  ["running", "cancelled", "9.1：aicoop cancel は「動いていれば止める」"],
  ["waiting_limit", "cancelled", "まだ終わっていないタスクは取り消せる"],
  ["blocked_host_tool", "cancelled", "まだ終わっていないタスクは取り消せる"],
];

describe("5.5.3：タスクの状態", () => {
  it("状態は 7.2 の tasks.status の10個", () => {
    expect([...TASK_STATUSES].sort()).toEqual(
      [
        "queued",
        "starting",
        "running",
        "done",
        "done_without_report",
        "failed",
        "timeout",
        "waiting_limit",
        "blocked_host_tool",
        "cancelled",
      ].sort(),
    );
  });

  it.each(DIAGRAM)("5.5.3 の図：%s → %s へ変われる", (from, to) => {
    expect(canTransitionTask(from, to)).toBe(true);
  });

  it.each(EXTRA)("%s → %s へ変われる（%s）", (from, to) => {
    expect(canTransitionTask(from, to)).toBe(true);
  });

  it("上の一覧にない変化は、すべて許さない", () => {
    const allowed = new Set([...DIAGRAM, ...EXTRA].map(([f, t]) => `${f}>${t}`));
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        if (allowed.has(`${from}>${to}`)) continue;
        expect(canTransitionTask(from, to), `${from} → ${to}`).toBe(false);
      }
    }
  });

  it.each(["done", "done_without_report", "failed", "timeout", "cancelled"] as const)(
    "終わった状態（%s）からは、どこへも変われない",
    (from) => {
      expect(isTerminalTaskStatus(from)).toBe(true);
      for (const to of TASK_STATUSES) expect(canTransitionTask(from, to)).toBe(false);
    },
  );

  it("同じ状態への変化は許さない", () => {
    for (const s of TASK_STATUSES) expect(canTransitionTask(s, s)).toBe(false);
  });

  it("知らない状態の文字列は、状態として認めない", () => {
    expect(isTaskStatus("queued")).toBe(true);
    expect(isTaskStatus("QUEUED")).toBe(false);
    expect(isTaskStatus("paused")).toBe(false);
    expect(isTaskStatus("__proto__")).toBe(false);
    expect(canTransitionTask("queued" as TaskStatus, "__proto__" as TaskStatus)).toBe(false);
    expect(canTransitionTask("__proto__" as TaskStatus, "queued")).toBe(false);
  });
});
