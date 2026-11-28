import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { ok } from "../testing/fake-api.ts";
import { status, USAGE } from "../testing/fixtures.ts";
import { renderApp } from "../testing/render.tsx";

const PENDING = { "GET /holds": ok({ holds: [] }), "GET /grants": ok({ grants: [] }) };

describe("5.8 の4 (4) 利用枠（5.4.6 の4：状態・再開予定時刻・使用率は取れたときだけ）", () => {
  test("状態（記号と文）・枠の種類・再開予定時刻・使用率", async () => {
    renderApp({
      hash: "#/usage",
      routes: { ...PENDING, "GET /usage": ok({ usage: USAGE }), "GET /status": ok(status()) },
    });
    expect(await screen.findByText("残り少ない")).toBeTruthy();
    expect(screen.getByText("▲")).toBeTruthy();
    expect(screen.getByText("5時間の枠")).toBeTruthy();
    expect(screen.getByText(/2時間後/)).toBeTruthy();
    expect(screen.getByText("83%")).toBeTruthy();
    expect(screen.getByRole("meter")).toBeTruthy();
  });

  test("止まっている：新しい実行を始めないこと・自動で再開することを言う。使用率がなければ出さない", async () => {
    renderApp({
      hash: "#/usage",
      routes: {
        ...PENDING,
        "GET /usage": ok({ usage: { ...USAGE, status: "rejected", utilization: null } }),
        "GET /status": ok(status({ tasks: { ...status().tasks, waiting_limit: 2 } })),
      },
    });
    expect(await screen.findByText(/止まっている/)).toBeTruthy();
    expect(screen.getByText(/新しい実行は始めません/)).toBeTruthy();
    expect(screen.getByText(/利用枠を待っているタスク：2件/)).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByText(/使用率は取れていません/)).toBeTruthy();
  });

  test("まだ情報がないとき", async () => {
    renderApp({
      hash: "#/usage",
      routes: {
        ...PENDING,
        "GET /usage": ok({ usage: null }),
        "GET /status": ok(status({ usage: null })),
      },
    });
    expect(await screen.findByText(/まだ利用枠の情報がありません/)).toBeTruthy();
  });
});
