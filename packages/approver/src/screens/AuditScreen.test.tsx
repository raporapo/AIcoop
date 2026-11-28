import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { createFakeApi, ok } from "../testing/fake-api.ts";
import { auditEntry } from "../testing/fixtures.ts";
import { renderApp } from "../testing/render.tsx";
import { findLastSeq } from "./AuditScreen.tsx";

/** 監査ログ（seq は 1〜n。`after` より大きいものを古い順に `limit` 件。9.2） */
function auditLog(n: number, kindOf: (seq: number) => string = () => "task.state") {
  const entries = Array.from({ length: n }, (_, i) => auditEntry(i + 1, { kind: kindOf(i + 1) }));
  return (after: number, limit: number) => entries.filter((e) => e.seq > after).slice(0, limit);
}

describe("5.8 の4 (5) 記録（監査ログ：新しいものから、種類で絞る、after で続きを読む）", () => {
  test("いちばん新しい seq を、after の問い合わせを数十回までで見つける", async () => {
    for (const n of [0, 1, 2, 199, 1024, 1025, 70_000]) {
      const log = auditLog(n);
      let probes = 0;
      const last = await findLastSeq(async (after) => {
        probes++;
        return log(after, 1)[0]?.seq ?? null;
      });
      expect(last).toBe(n);
      expect(probes).toBeLessThan(45);
    }
  });

  test("新しいものから並べ、「さらに古い記録」で続きを読む", async () => {
    const log = auditLog(450, (s) => (s % 10 === 0 ? "approval" : "task.state"));
    const api = createFakeApi({
      "GET /holds": ok({ holds: [] }),
      "GET /grants": ok({ grants: [] }),
    });
    api.on("GET /audit", (req) =>
      ok({
        entries: log(Number(req.query.get("after") ?? 0), Number(req.query.get("limit") ?? 200)),
      }),
    );
    renderApp({ api, hash: "#/audit" });
    const list = await screen.findByRole("list", { name: "記録" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(200));
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("#450");
    expect(items[199]?.textContent).toContain("#251");
    expect(items[0]?.textContent).toContain("承認・却下の署名");

    fireEvent.click(screen.getByRole("button", { name: "さらに古い記録を読む" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(400));
    fireEvent.click(screen.getByRole("button", { name: "さらに古い記録を読む" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(450));
    expect(within(list).getAllByRole("listitem")[449]?.textContent).toContain("#1");
    expect(await screen.findByText("これより古い記録はありません。")).toBeTruthy();

    // 種類で絞る
    fireEvent.change(screen.getByLabelText("種類で絞る"), { target: { value: "approval" } });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(45));
  });

  test("中身（data）は開いて見られ、見えない文字は印にする", async () => {
    const api = createFakeApi({
      "GET /holds": ok({ holds: [] }),
      "GET /grants": ok({ grants: [] }),
    });
    const entries = [
      auditEntry(1, { kind: "gateway.call", data: { tool: "report_result\u{202E}" } }),
    ];
    api.on("GET /audit", (req) =>
      ok({ entries: entries.filter((e) => e.seq > Number(req.query.get("after"))) }),
    );
    renderApp({ api, hash: "#/audit" });
    expect(await screen.findByText("道具の呼び出し", { selector: "strong" })).toBeTruthy();
    const data = document.querySelector("pre.data")?.textContent ?? "";
    expect(data).toContain("report_result[U+202E]");
    expect(data).not.toContain("\u{202E}");
  });
});
