import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { fail, ok } from "../testing/fake-api.ts";
import { id, status, task } from "../testing/fixtures.ts";
import { renderApp } from "../testing/render.tsx";
import { taskFormProblems } from "./NewTaskScreen.tsx";

const BASE = {
  "GET /holds": ok({ holds: [] }),
  "GET /grants": ok({ grants: [] }),
  "GET /status": ok(status()),
};

function set(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("5.8 の4 (3) 手動のタスクを作る（POST /tasks。トリガー manual）", () => {
  test("社員・目的・完了の条件・背景・スレッドを送り、作ったタスクの画面へ移る", async () => {
    const created = task({ id: id("t", 99), status: "queued" });
    const { api } = renderApp({
      hash: "#/tasks/new",
      routes: {
        ...BASE,
        "POST /tasks": { status: 201, body: { task: created } },
        [`GET /tasks/${created.id}`]: ok({ task: created, runs: [] }),
      },
    });
    await screen.findByRole("heading", { level: 1, name: "手動のタスクを作る" });
    set("社員", "dev-implementer");
    set(/目的/, "README の誤字を直す");
    set(/完了の条件/, "PR を出して URL を報告した");
    set(/背景/, "typo は 3 か所");
    set(/スレッド/, "readme-typo");
    set(/時間制限/, "30");
    fireEvent.click(screen.getByRole("button", { name: "タスクを作る" }));
    await waitFor(() => expect(window.location.hash).toBe(`#/tasks/${created.id}`));
    expect(api.calls.find((c) => c.method === "POST" && c.path === "/tasks")?.body).toEqual({
      member: "dev-implementer",
      purpose: "README の誤字を直す",
      done_when: "PR を出して URL を報告した",
      context: "typo は 3 か所",
      thread: "readme-typo",
      timeout_minutes: 30,
    });
  });

  test("書いていない項目は送らない（背景・スレッド・時間制限は任意）", async () => {
    const created = task({ id: id("t", 98), status: "queued" });
    const { api } = renderApp({
      hash: "#/tasks/new",
      routes: { ...BASE, "POST /tasks": { status: 201, body: { task: created } } },
    });
    await screen.findByRole("heading", { level: 1, name: "手動のタスクを作る" });
    set("社員", "dev-implementer");
    set(/目的/, "直す");
    set(/完了の条件/, "報告した");
    fireEvent.click(screen.getByRole("button", { name: "タスクを作る" }));
    await waitFor(() => expect(api.count("POST /tasks")).toBe(1));
    expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({
      member: "dev-implementer",
      purpose: "直す",
      done_when: "報告した",
    });
  });

  test("拒否側：足りない・長すぎる・制御文字のある入力は送らない", async () => {
    expect(
      taskFormProblems({
        member: "",
        purpose: "",
        done_when: "",
        context: "",
        thread: "",
        timeout: "",
      }),
    ).toEqual(["社員を入れてください", "目的を入れてください", "完了の条件を入れてください"]);
    expect(
      taskFormProblems({
        member: "a",
        purpose: "x".repeat(2001),
        done_when: "ok\u{0007}",
        context: "",
        thread: "a\nb",
        timeout: "56",
      }),
    ).toEqual([
      "目的は2000文字までにしてください",
      "完了の条件に、改行・タブ以外の制御文字は使えません",
      "スレッドに、改行・制御文字・見えない文字は使えません",
      "時間制限は1〜55分の整数にしてください",
    ]);

    const { api } = renderApp({ hash: "#/tasks/new", routes: BASE });
    await screen.findByRole("heading", { level: 1, name: "手動のタスクを作る" });
    fireEvent.click(screen.getByRole("button", { name: "タスクを作る" }));
    expect((await screen.findByRole("alert")).textContent).toContain("社員を入れてください");
    expect(api.count("POST /tasks")).toBe(0);
  });

  test("知らない社員など、作れなければ制御サーバーの日本語のメッセージ", async () => {
    renderApp({
      hash: "#/tasks/new",
      routes: {
        ...BASE,
        "POST /tasks": fail(422, "unknown_member", "社員 nobody は設定にいません"),
      },
    });
    await screen.findByRole("heading", { level: 1, name: "手動のタスクを作る" });
    set("社員", "nobody");
    set(/目的/, "a");
    set(/完了の条件/, "b");
    fireEvent.click(screen.getByRole("button", { name: "タスクを作る" }));
    expect(await screen.findByText("社員 nobody は設定にいません")).toBeTruthy();
  });
});
