import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { fail, ok } from "../testing/fake-api.ts";
import {
  holdView,
  MAIL_HOLD,
  MANAGER_GRANT,
  MANAGER_HOLD,
  MERGE_HOLD,
  PUSH_GRANT,
} from "../testing/fixtures.ts";
import { renderApp } from "../testing/render.tsx";

describe("5.8 の4 (1) 承認待ちの一覧", () => {
  test("あなたの承認を待っている保留と一時権限の申請を、件数と、誰が・何を・いつまでに、で並べる。期限が近いものを先に・目立たせる", async () => {
    renderApp({
      routes: {
        "GET /holds": ok({ holds: [holdView(MAIL_HOLD), holdView(MERGE_HOLD), MANAGER_HOLD] }),
        "GET /grants": ok({ grants: [PUSH_GRANT, MANAGER_GRANT] }),
      },
    });
    const owner = await screen.findByRole("region", {
      name: /あなたの承認を待っているもの（3件）/,
    });
    const items = within(owner).getAllByRole("link");
    expect(items).toHaveLength(3);
    // 期限が30分後のマージが先頭。「⚠」と文で期限の近さを言う
    expect(items[0]?.getAttribute("href")).toBe(`#/pending/hold/${MERGE_HOLD.id}`);
    expect(items[0]?.textContent).toContain("PR のマージ");
    expect(items[0]?.textContent).toContain("myorg/app #12「README の誤字を直す」");
    expect(items[0]?.textContent).toContain("30分後に期限");
    expect(items[0]?.textContent).toContain("⚠");
    expect(items[0]?.textContent).toContain("dev-implementer");
    expect(items[1]?.getAttribute("href")).toBe(`#/pending/hold/${MAIL_HOLD.id}`);
    expect(items[1]?.textContent).toContain("メールの送信");
    expect(items[1]?.textContent).toContain("宛先 client@example.com・件名「お見積りの件」");
    expect(items[1]?.textContent).toContain("2日後に期限");
    expect(items[1]?.textContent).toContain("sales-writer");
    expect(items[2]?.getAttribute("href")).toBe(`#/pending/grant/${PUSH_GRANT.id}`);
    expect(items[2]?.textContent).toContain("一時権限の申請");
    expect(items[2]?.textContent).toContain("github.git.push");
    expect(items[2]?.textContent).toContain("repo=myorg/new");
    expect(items[2]?.textContent).toContain("24時間");
  });

  test("部長のレビュー待ちは別に、押せない形で出す", async () => {
    renderApp({
      routes: {
        "GET /holds": ok({ holds: [MANAGER_HOLD] }),
        "GET /grants": ok({ grants: [MANAGER_GRANT] }),
      },
    });
    const manager = await screen.findByRole("region", { name: /部長のレビュー待ち（2件）/ });
    expect(within(manager).queryAllByRole("link")).toHaveLength(0);
    expect(within(manager).queryAllByRole("button")).toHaveLength(0);
    expect(manager.textContent).toContain("件名「ご挨拶」");
    expect(manager.textContent).toContain("ここからは承認できません");
    const owner = screen.getByRole("region", { name: /あなたの承認を待っているもの（0件）/ });
    expect(owner.textContent).toContain("いま、あなたの承認を待っているものはありません");
  });

  test("一時権限の申請を読めなくても、保留は出す（読めなかったことを言う）", async () => {
    renderApp({
      routes: {
        "GET /holds": ok({ holds: [holdView(MAIL_HOLD)] }),
        "GET /grants": fail(500, "internal", "制御サーバーの中でエラーが起きました"),
      },
    });
    expect(await screen.findByText(/宛先 client@example.com/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("一時権限の申請を読み込めませんでした");
    expect(screen.getByRole("alert").textContent).toContain("制御サーバーの中でエラーが起きました");
  });

  test("一覧の要約の見えない文字は印にする", async () => {
    renderApp({
      routes: {
        "GET /holds": ok({
          holds: [
            holdView({
              ...MAIL_HOLD,
              summary: { ...(MAIL_HOLD.summary as object), subject: "請求\u{202E}書" },
            }),
          ],
        }),
        "GET /grants": ok({ grants: [] }),
      },
    });
    expect(await screen.findByText(/件名「請求\[U\+202E\]書」/)).toBeTruthy();
  });
});
