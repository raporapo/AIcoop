import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { createFakeApi, fail, memoryStorage, ok } from "./testing/fake-api.ts";
import { holdView, MAIL_HOLD, MERGE_HOLD, NOW, PUSH_GRANT } from "./testing/fixtures.ts";
import { go, renderApp } from "./testing/render.tsx";

const PENDING = {
  "GET /holds": ok({ holds: [holdView(MAIL_HOLD), holdView(MERGE_HOLD)] }),
  "GET /grants": ok({ grants: [PUSH_GRANT] }),
};

describe("承認アプリの外枠（5.8）", () => {
  test("ログインしていなければ、ログインの画面だけ（承認待ちは読まない）", async () => {
    const { api } = renderApp({ me: null, routes: PENDING });
    expect(await screen.findByRole("heading", { name: "パスキーでログイン" })).toBeTruthy();
    expect(api.count("GET /holds")).toBe(0);
    expect(screen.queryByRole("navigation", { name: "画面" })).toBeNull();
  });

  test("ログインしていれば、承認待ちの一覧。ナビゲーションに、あなたの承認を待っている件数", async () => {
    renderApp({ routes: PENDING });
    expect(await screen.findByRole("heading", { level: 1, name: /承認待ち/ })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "画面" });
    const link = within(nav).getByRole("link", { name: /承認待ち/ });
    await waitFor(() => expect(link.textContent).toBe("承認待ち3件"));
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(document.title).toBe("（3）AIcoop 承認");
    expect(screen.getByText(/ログイン中：/).textContent).toContain("自宅のPC（Edge）");
  });

  test("ナビゲーションで画面を切り替える。いまの画面には aria-current", async () => {
    renderApp({ routes: PENDING });
    await screen.findByRole("heading", { level: 1, name: /承認待ち/ });
    await go("#/ceo");
    const nav = screen.getByRole("navigation", { name: "画面" });
    expect(within(nav).getByRole("link", { name: "CEO に頼む" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("CEO");
  });

  test("途中で 401 が返ったら、ログインの画面に戻して理由を言う", async () => {
    renderApp({
      routes: { ...PENDING, "GET /holds": fail(401, "unauthorized", "ログインしてください") },
    });
    expect(await screen.findByRole("heading", { name: "パスキーでログイン" })).toBeTruthy();
    expect(screen.getByText(/ログインの期限が切れたか、この端末が取り消されました/)).toBeTruthy();
  });

  test("5.8 の6：届かなくなったら「制御サーバーに届いていません」と、最後に受け取った状態を出す", async () => {
    const api = createFakeApi(PENDING);
    renderApp({ api, pollMs: 30 });
    expect(await screen.findByText(/宛先 client@example.com/)).toBeTruthy();
    api.offline = true;
    expect(await screen.findByText("制御サーバーに届いていません。")).toBeTruthy();
    // 前に読めた一覧はそのまま
    expect(screen.getByText(/宛先 client@example.com/)).toBeTruthy();
    api.offline = false;
    await waitFor(() => expect(screen.queryByText("制御サーバーに届いていません。")).toBeNull());
  });

  test("届かない状態で開いたら、端末に残した控え（件数・期限。要約の中身は残さない）を出す", async () => {
    const storage = memoryStorage();
    const first = renderApp({ routes: PENDING, storage });
    await screen.findByText(/宛先 client@example.com/);
    expect(
      JSON.stringify(
        [...Array(storage.length).keys()].map((i) => storage.getItem(storage.key(i) ?? "")),
      ),
    ).not.toContain("client@example.com");
    first.unmount();

    const api = createFakeApi(PENDING);
    api.offline = true;
    renderApp({ api, storage });
    expect(await screen.findByText("制御サーバーに届いていません。")).toBeTruthy();
    expect(await screen.findByText(/の時点で受け取った状態を表示しています/)).toBeTruthy();
    expect(screen.getAllByText(/sales-writer/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/client@example.com/)).toBeNull();
  });

  test("ログアウトしたら、端末の控えを消す", async () => {
    const storage = memoryStorage();
    renderApp({ routes: { ...PENDING, "POST /auth/logout": ok({ ok: true }) }, storage });
    await screen.findByText(/宛先 client@example.com/);
    expect(storage.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    expect(await screen.findByRole("heading", { name: "パスキーでログイン" })).toBeTruthy();
    expect(screen.getByText("ログアウトしました")).toBeTruthy();
    expect(storage.length).toBe(0);
  });

  test("知らない道は「その画面はありません」", async () => {
    renderApp({ routes: PENDING, hash: "#/nothing" });
    expect(await screen.findByRole("heading", { name: "その画面はありません" })).toBeTruthy();
  });

  test("端末の登録（#/pair）は、ログインしていなくても開ける", async () => {
    renderApp({ me: null, hash: "#/pair" });
    expect(
      await screen.findByRole("heading", { level: 1, name: "この端末を登録する" }),
    ).toBeTruthy();
  });

  test("daemon が承認アプリに対応していない（/auth/me がない）ときは、そう言う", async () => {
    renderApp({ routes: { "GET /auth/me": fail(404, "not_found", "その道はありません") } });
    expect(await screen.findByRole("heading", { name: "承認アプリを始められません" })).toBeTruthy();
    expect(screen.getByText("その道はありません")).toBeTruthy();
    expect(NOW).toBeGreaterThan(0);
  });
});
