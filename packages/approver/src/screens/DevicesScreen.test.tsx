import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { createFakeApi, ok } from "../testing/fake-api.ts";
import { iso, NOW, OTHER_DEVICE, THIS_DEVICE } from "../testing/fixtures.ts";
import { renderApp } from "../testing/render.tsx";

const REVOKED = {
  ...OTHER_DEVICE,
  id: "d_01JQ0000000000000000000003",
  name: "古いPC",
  revoked_at: iso(NOW - 60_000),
};

function setup() {
  const api = createFakeApi({
    "GET /holds": ok({ holds: [] }),
    "GET /grants": ok({ grants: [] }),
    "GET /devices": ok({ devices: [THIS_DEVICE, OTHER_DEVICE, REVOKED] }),
  });
  renderApp({ api, hash: "#/devices" });
  return api;
}

describe("5.8 の4 (6) 端末：一覧・取り消し（確かめてから）・「この端末」の印", () => {
  test("一覧に「この端末」の印と、取り消し済みの端末。登録の案内（aicoop pair --local）", async () => {
    setup();
    const list = await screen.findByRole("list", { name: "端末の一覧" });
    const items = within(list).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("自宅のPC（Edge）");
    expect(items[0]?.textContent).toContain("この端末");
    expect(items[1]?.textContent).not.toContain("この端末");
    expect(items[2]?.textContent).toContain("取り消し済み");
    expect(within(items[2] as HTMLElement).queryByRole("button")).toBeNull();
    expect(screen.getByText(/aicoop pair --local/)).toBeTruthy();
  });

  test("ほかの端末を取り消す：確かめの窓 → POST /devices/{id}/revoke → 読み直す", async () => {
    const api = setup();
    api.on(`POST /devices/${OTHER_DEVICE.id}/revoke`, () => {
      api.on(
        "GET /devices",
        ok({ devices: [THIS_DEVICE, { ...OTHER_DEVICE, revoked_at: iso(NOW) }, REVOKED] }),
      );
      return ok({ device: { ...OTHER_DEVICE, revoked_at: iso(NOW) } });
    });
    fireEvent.click(await screen.findByRole("button", { name: "「仕事のノートPC」を取り消す…" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "「仕事のノートPC」を取り消しますか？",
    });
    expect(dialog.textContent).toContain("元に戻せません");
    fireEvent.click(within(dialog).getByRole("button", { name: "取り消す" }));
    await waitFor(() => expect(api.count(`POST /devices/${OTHER_DEVICE.id}/revoke`)).toBe(1));
    await waitFor(() => expect(screen.getAllByText(/取り消し済み/)).toHaveLength(2));
  });

  test("この端末を取り消すと、すぐにログアウトする（そのことを先に言う）", async () => {
    const api = setup();
    api.on(
      `POST /devices/${THIS_DEVICE.id}/revoke`,
      ok({ device: { ...THIS_DEVICE, revoked_at: iso(NOW) } }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "「自宅のPC（Edge）」を取り消す…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("この端末です。取り消すと、すぐにログアウトします");
    fireEvent.click(within(dialog).getByRole("button", { name: "取り消す" }));
    expect(await screen.findByRole("heading", { name: "パスキーでログイン" })).toBeTruthy();
    expect(screen.getByText(/この端末を取り消しました/)).toBeTruthy();
  });
});
