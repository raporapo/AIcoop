import type { ConfigFileView, CreateConfigChangeResponse } from "@aicoop/shared/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { createFakeApi, fail, ok } from "../testing/fake-api.ts";
import { iso, NOW } from "../testing/fixtures.ts";
import { assertOk, fakeIntent } from "../testing/intent.ts";
import { renderApp } from "../testing/render.tsx";
import { installFakeWebAuthn } from "../testing/webauthn.ts";

const GROUPS = "groups:\n  dev:\n    name: 開発部\n";
const GROUPS_SHA = "a".repeat(64);
const CHANGE_ID = "x_01JQ0000000000000000000009";

const FILES: ConfigFileView[] = [
  { path: "aicoop.yaml", size: 120, sha256: "b".repeat(64), modified_at: iso(NOW) },
  { path: "groups.yaml", size: GROUPS.length, sha256: GROUPS_SHA, modified_at: iso(NOW) },
  { path: "prompts/company.md", size: 10, sha256: "c".repeat(64), modified_at: iso(NOW) },
];

const CHANGE: CreateConfigChangeResponse = {
  id: CHANGE_ID,
  summary: {
    files: [
      {
        path: "groups.yaml",
        before_sha256: GROUPS_SHA,
        after_sha256: "d".repeat(64),
        diff: "--- a/groups.yaml\n+++ b/groups.yaml\n@@ -3 +3 @@\n-    name: 開発部\n+    name: 開発本部\n",
      },
    ],
  },
  warnings: [{ code: "W-001", message: "役職の allow に、部署の ceiling にない操作があります" }],
  expires_at: iso(NOW + 10 * 60_000),
};

function setup(options: { summarySha?: string } = {}) {
  const webauthn = installFakeWebAuthn();
  const api = createFakeApi({
    "GET /holds": ok({ holds: [] }),
    "GET /grants": ok({ grants: [] }),
    "GET /config/files": ok({ files: FILES }),
    "GET /config/files/groups.yaml": ok({
      path: "groups.yaml",
      content: GROUPS,
      sha256: GROUPS_SHA,
    }),
    "POST /config/changes": { status: 201, body: CHANGE },
  });
  fakeIntent(api, {
    summaryOf: () => CHANGE.summary,
    ...(options.summarySha !== undefined && { summarySha: options.summarySha }),
  });
  renderApp({ api, hash: "#/settings" });
  return { api, webauthn };
}

async function openGroups() {
  fireEvent.click(await screen.findByRole("button", { name: "groups.yaml" }));
  return (await screen.findByRole("textbox", {
    name: /groups\.yaml の中身/,
  })) as HTMLTextAreaElement;
}

async function editAndCheck() {
  const box = await openGroups();
  fireEvent.change(box, { target: { value: GROUPS.replace("開発部", "開発本部") } });
  fireEvent.click(screen.getByRole("button", { name: "確かめる" }));
}

describe("5.8 の4 (10)・5.14 の4：設定の画面", () => {
  test("5.14 の4の1：設定のファイルを一覧する（パス・大きさ・更新日時）", async () => {
    setup();
    expect(await screen.findByRole("heading", { level: 1, name: "設定" })).toBeTruthy();
    for (const f of FILES) expect(await screen.findByRole("button", { name: f.path })).toBeTruthy();
    expect(screen.queryByText("secrets.json")).toBeNull();
  });

  test("ナビに「設定」「資格」がある", async () => {
    setup();
    const nav = await screen.findByRole("navigation", { name: "画面" });
    expect(within(nav).getByRole("link", { name: "設定" }).getAttribute("href")).toBe("#/settings");
    expect(within(nav).getByRole("link", { name: "資格" }).getAttribute("href")).toBe("#/secrets");
  });

  test("中身をテキストで編集し、「確かめる」で変更を作る（もとにした SHA-256 を送る）", async () => {
    const { api } = setup();
    const box = await openGroups();
    expect(box.value).toBe(GROUPS);
    const check = screen.getByRole("button", { name: "確かめる" }) as HTMLButtonElement;
    expect(check.disabled).toBe(true); // 変えていないうちは押せない
    fireEvent.change(box, { target: { value: GROUPS.replace("開発部", "開発本部") } });
    fireEvent.click(check);
    expect(await screen.findByText(/差分/)).toBeTruthy();
    expect(api.calls.find((c) => c.path === "/config/changes")?.body).toEqual({
      files: [
        {
          path: "groups.yaml",
          content: GROUPS.replace("開発部", "開発本部"),
          base_sha256: GROUPS_SHA,
        },
      ],
    });
  });

  test("5.14 の4の2：検証のエラーを見せ、保存のボタンは出さない", async () => {
    const { api } = setup();
    api.on("POST /config/changes", {
      status: 422,
      body: {
        error: "config_invalid",
        message: "設定にエラーがあるので、保存できません（1件）",
        issues: [
          {
            code: "E-001",
            message: "存在しない役職 nobody を参照しています",
            source: "members.yaml",
            path: "members.dev-implementer.role",
          },
        ],
      },
    });
    await editAndCheck();
    const alert = await screen.findByText(/存在しない役職 nobody/);
    expect(alert).toBeTruthy();
    expect(screen.getByText("E-001")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /保存する…/ })).toBeNull();
  });

  test("5.14 の4の3：差分と警告を見せ、パスキーで署名して保存する（type は config_change）", async () => {
    const { api, webauthn } = setup();
    api.on("POST /approvals/assert", assertOk("config_change", CHANGE_ID, "approve", "applied"));
    await editAndCheck();
    const diff = await screen.findByLabelText("groups.yaml の差分");
    expect(diff.textContent).toContain("+    name: 開発本部");
    expect(diff.textContent).toContain("-    name: 開発部");
    expect(screen.getByText(/W-001/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /保存する…/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "この変更を保存しますか？" });
    expect(dialog.textContent).toContain("groups.yaml");
    fireEvent.click(within(dialog).getByRole("button", { name: /パスキーで署名して保存する/ }));
    expect(await screen.findByText("保存しました。")).toBeTruthy();
    expect(api.calls.find((c) => c.path === "/approvals/intent")?.body).toEqual({
      type: "config_change",
      id: CHANGE_ID,
      decision: "approve",
    });
    expect(webauthn.getCalls).toHaveLength(1);
    // 保存したら一覧を読み直す
    await waitFor(() => expect(api.count("GET /config/files")).toBeGreaterThanOrEqual(2));
  });

  test("拒否側：payload の summary_sha256 が、表示している差分の要約と違えば署名しない", async () => {
    const { api, webauthn } = setup({ summarySha: "0".repeat(64) });
    await editAndCheck();
    fireEvent.click(await screen.findByRole("button", { name: /保存する…/ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: /パスキーで署名して保存する/,
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "いま画面に表示している要約と一致しません",
    );
    expect(webauthn.getCalls).toHaveLength(0);
    expect(api.count("POST /approvals/assert")).toBe(0);
  });

  test("5.14 の4の4：作ったあとでファイルが書き換えられていたら、書かなかったと言い、やり直しは出さない", async () => {
    const { api } = setup();
    api.on(
      "POST /approvals/assert",
      fail(
        409,
        "conflict",
        "変更を作ったあとで groups.yaml が書き換えられたので、書きませんでした",
      ),
    );
    await editAndCheck();
    fireEvent.click(await screen.findByRole("button", { name: /保存する…/ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: /パスキーで署名して保存する/,
      }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("書き換えられたので、書きませんでした");
    expect(alert.textContent).toContain("読み直してから");
    expect(screen.queryByRole("button", { name: /もう一度やり直す/ })).toBeNull();
  });

  test("取り消す（reject）こともできる", async () => {
    const { api } = setup();
    api.on("POST /approvals/assert", assertOk("config_change", CHANGE_ID, "reject", "cancelled"));
    await editAndCheck();
    fireEvent.click(await screen.findByRole("button", { name: /取り消す…/ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: /パスキーで署名して取り消す/,
      }),
    );
    expect(await screen.findByText("取り消しました。")).toBeTruthy();
  });

  test("新しいファイル：扱えないパスは API に送らない", async () => {
    const { api } = setup();
    const input = (await screen.findByRole("textbox", {
      name: "新しいファイルのパス",
    })) as HTMLInputElement;
    for (const bad of ["secrets.json", "../x.yaml", "prompts/%2e%2e/x.md", "prompts/x.txt"]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.click(screen.getByRole("button", { name: "新しいファイルを作る" }));
      expect(await screen.findByText(/設定の画面では作れません/)).toBeTruthy();
    }
    expect(api.calls.some((c) => c.path.startsWith("/config/files/"))).toBe(false);

    fireEvent.change(input, { target: { value: "prompts/members/dev-implementer.md" } });
    fireEvent.click(screen.getByRole("button", { name: "新しいファイルを作る" }));
    const box = (await screen.findByRole("textbox", {
      name: /prompts\/members\/dev-implementer\.md の中身/,
    })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "# 個人への調整\n" } });
    fireEvent.click(screen.getByRole("button", { name: "確かめる" }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.path === "/config/changes")?.body).toEqual({
        files: [
          {
            path: "prompts/members/dev-implementer.md",
            content: "# 個人への調整\n",
            base_sha256: null,
          },
        ],
      }),
    );
  });
});
