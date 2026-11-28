import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ok } from "../testing/fake-api.ts";
import { id, status, task } from "../testing/fixtures.ts";
import { renderApp } from "../testing/render.tsx";

const PENDING = { "GET /holds": ok({ holds: [] }), "GET /grants": ok({ grants: [] }) };

describe("5.8 の4 (3) 稼働状況：箱・タスクの一覧", () => {
  test("箱（動いているもの・上限）とタスクの数、トリガー、警告", async () => {
    renderApp({
      hash: "#/status",
      routes: {
        ...PENDING,
        "GET /status": ok(
          status({
            warnings: [
              { code: "W-002", message: "開発部は web.read で持ち出せます", source: "groups.yaml" },
            ],
          }),
        ),
        "GET /tasks": ok({ tasks: [] }),
      },
    });
    const boxes = await screen.findByRole("region", { name: /箱/ });
    expect(boxes.textContent).toContain("動いている箱：1 / 上限 3");
    expect(boxes.textContent).toContain("dev-implementer");
    expect(
      within(boxes)
        .getByRole("link", { name: id("t", 20) })
        .getAttribute("href"),
    ).toBe(`#/tasks/${id("t", 20)}`);
    const counts = screen.getByRole("region", { name: "状態ごとのタスクの数" });
    expect(counts.textContent).toContain("順番待ち2");
    expect(counts.textContent).toContain("完了5");
    expect(screen.getByRole("region", { name: "設定の警告" }).textContent).toContain(
      "W-002：開発部は web.read で持ち出せます",
    );
    expect(screen.getByText("morning-research")).toBeTruthy();
  });

  test("タスクの一覧：状態（記号と文）・社員・目的・報告の要約・ファイル。詳細へのリンク", async () => {
    renderApp({
      hash: "#/status",
      routes: {
        ...PENDING,
        "GET /status": ok(status()),
        "GET /tasks": ok({
          tasks: [task(), task({ id: id("t", 11), status: "failed", error: "start_failed" })],
        }),
      },
    });
    const list = await screen.findByRole("region", { name: /タスクの一覧/ });
    await waitFor(() => expect(within(list).getAllByRole("link")).toHaveLength(2));
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first?.textContent).toContain("✓ 完了");
    expect(first?.textContent).toContain("README の誤字を直す");
    expect(first?.textContent).toContain("PR #12 を出しました。");
    expect(first?.textContent).toContain("notes/readme.md");
    expect(second?.textContent).toContain("✕ 失敗");
    expect(within(list).getAllByRole("link")[0]?.getAttribute("href")).toBe(
      `#/tasks/${id("t", 10)}`,
    );
    expect(screen.getByRole("link", { name: "手動のタスクを作る" }).getAttribute("href")).toBe(
      "#/tasks/new",
    );
  });

  test("状態で絞ると、その状態だけを読み直す", async () => {
    const { api } = renderApp({
      hash: "#/status",
      routes: { ...PENDING, "GET /status": ok(status()), "GET /tasks": ok({ tasks: [task()] }) },
    });
    const select = (await screen.findByLabelText("状態で絞る")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "running" } });
    await waitFor(() =>
      expect(
        api.calls.some((c) => c.path === "/tasks" && c.query.get("status") === "running"),
      ).toBe(true),
    );
  });
});
