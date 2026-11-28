import type { CreateSecretChangeResponse, SecretView } from "@aicoop/shared/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { createFakeApi, ok } from "../testing/fake-api.ts";
import { iso, NOW } from "../testing/fixtures.ts";
import { assertOk, fakeIntent } from "../testing/intent.ts";
import { renderApp } from "../testing/render.tsx";
import { installFakeWebAuthn } from "../testing/webauthn.ts";

const TOKEN = "ghp_APPROVER_SCREEN_REAL_TOKEN_9876543210";
const CHANGE_ID = "x_01JQ0000000000000000000008";
const SECRETS: SecretView[] = [
  { id: "anthropic", kind: "anthropic_oauth", updated_at: iso(NOW - 3600_000) },
  { id: "github", kind: "static_token", updated_at: iso(NOW) },
];

function changeOf(summary: CreateSecretChangeResponse["summary"]): CreateSecretChangeResponse {
  return { id: CHANGE_ID, summary, expires_at: iso(NOW + 10 * 60_000) };
}

function setup(options: { summarySha?: string } = {}) {
  const webauthn = installFakeWebAuthn();
  let last: CreateSecretChangeResponse | null = null;
  const api = createFakeApi({
    "GET /holds": ok({ holds: [] }),
    "GET /grants": ok({ grants: [] }),
    "GET /secrets": ok({ secrets: SECRETS }),
  });
  api.on("POST /secrets/changes", (req) => {
    const body = req.body as { id: string; kind?: string; delete?: true };
    const existing = SECRETS.find((s) => s.id === body.id);
    last = changeOf(
      body.delete
        ? { id: body.id, kind: existing?.kind ?? "static_token", action: "delete" }
        : {
            id: body.id,
            kind: body.kind as SecretView["kind"],
            action: existing ? "replace" : "create",
          },
    );
    return { status: 201, body: last };
  });
  fakeIntent(api, {
    summaryOf: () => last?.summary,
    ...(options.summarySha !== undefined && { summarySha: options.summarySha }),
  });
  const view = renderApp({ api, hash: "#/secrets" });
  return { api, webauthn, container: view.container };
}

const lastBody = (api: ReturnType<typeof setup>["api"]) =>
  [...api.calls].reverse().find((c) => c.path === "/secrets/changes")?.body;

describe("5.8 の4 (11)・5.14 の5：資格の画面", () => {
  test("資格の ID・種類・更新日時を一覧する（中身は出さない）", async () => {
    setup();
    expect(await screen.findByRole("heading", { level: 1, name: "資格" })).toBeTruthy();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("github")).toBeTruthy();
    expect(within(table).getByText(/static_token/)).toBeTruthy();
    expect(within(table).getByText("anthropic")).toBeTruthy();
  });

  test("登録：貼り付け欄は type=password。変更を作ったら値を画面に残さず、要約は ID・種類・登録か置き換えかだけ", async () => {
    const { api, webauthn, container } = setup();
    api.on("POST /approvals/assert", assertOk("secret_change", CHANGE_ID, "approve", "applied"));
    fireEvent.change(await screen.findByRole("textbox", { name: "資格の ID" }), {
      target: { value: "github" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "種類" }), {
      target: { value: "static_token" },
    });
    const token = screen.getByLabelText("トークン") as HTMLInputElement;
    expect(token.type).toBe("password");
    expect(token.autocomplete).toBe("off");
    fireEvent.change(token, { target: { value: `  ${TOKEN}  ` } });
    fireEvent.click(screen.getByRole("button", { name: "変更を作る" }));

    expect(await screen.findByText(/置き換えます/)).toBeTruthy();
    expect(lastBody(api)).toEqual({ id: "github", kind: "static_token", value: { token: TOKEN } });
    // 値は画面に残さない
    expect(container.innerHTML).not.toContain(TOKEN);
    for (const input of Array.from(container.querySelectorAll("input"))) {
      expect(input.value).not.toContain(TOKEN);
    }

    fireEvent.click(screen.getByRole("button", { name: /保存する…/ }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "この資格の変更を保存しますか？",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /パスキーで署名して保存する/ }));
    expect(await screen.findByText("保存しました。")).toBeTruthy();
    expect(api.calls.find((c) => c.path === "/approvals/intent")?.body).toEqual({
      type: "secret_change",
      id: CHANGE_ID,
      decision: "approve",
    });
    expect(webauthn.getCalls).toHaveLength(1);
    expect(container.innerHTML).not.toContain(TOKEN);
    await waitFor(() => expect(api.count("GET /secrets")).toBeGreaterThanOrEqual(2));
  });

  test("GitHub App：秘密鍵も type=password で受け、改行のない貼り付けを PEM の形に直して送る", async () => {
    const { api, container } = setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "資格の ID" }), {
      target: { value: "github-app" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "種類" }), {
      target: { value: "github_app" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "App ID" }), { target: { value: "123" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Installation ID" }), {
      target: { value: "456" },
    });
    const key = screen.getByLabelText("秘密鍵（.pem の中身）") as HTMLInputElement;
    expect(key.type).toBe("password");
    const body = "A".repeat(70);
    // 1行の入力欄は改行を落とすので、改行のない PEM が来る
    fireEvent.change(key, {
      target: { value: `-----BEGIN RSA PRIVATE KEY-----${body}-----END RSA PRIVATE KEY-----` },
    });
    fireEvent.click(screen.getByRole("button", { name: "変更を作る" }));
    await screen.findByText(/登録します/);
    expect(lastBody(api)).toEqual({
      id: "github-app",
      kind: "github_app",
      value: {
        app_id: "123",
        installation_id: "456",
        private_key: `-----BEGIN RSA PRIVATE KEY-----\n${"A".repeat(64)}\n${"A".repeat(6)}\n-----END RSA PRIVATE KEY-----\n`,
      },
    });
    expect(container.innerHTML).not.toContain(body);
  });

  test("削除も、パスキーで署名してから", async () => {
    const { api } = setup();
    api.on("POST /approvals/assert", assertOk("secret_change", CHANGE_ID, "approve", "applied"));
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "github を消す…" }));
    expect(await screen.findByText(/消します/)).toBeTruthy();
    expect(lastBody(api)).toEqual({ id: "github", delete: true });
    fireEvent.click(screen.getByRole("button", { name: /保存する…/ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: /パスキーで署名して保存する/,
      }),
    );
    expect(await screen.findByText("保存しました。")).toBeTruthy();
  });

  test("置き換え：一覧の行から、ID と種類を入れる", async () => {
    setup();
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "anthropic を置き換える" }));
    expect((screen.getByRole("textbox", { name: "資格の ID" }) as HTMLInputElement).value).toBe(
      "anthropic",
    );
    expect((screen.getByRole("combobox", { name: "種類" }) as HTMLSelectElement).value).toBe(
      "anthropic_oauth",
    );
  });

  test("拒否側：payload の summary_sha256 が、表示している要約と違えば署名しない", async () => {
    const { api, webauthn } = setup({ summarySha: "0".repeat(64) });
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByRole("button", { name: "github を消す…" }));
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

  test("ID の形が違えば、送らない（値も残さない）", async () => {
    const { api, container } = setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "資格の ID" }), {
      target: { value: "GitHub Token" },
    });
    fireEvent.change(screen.getByLabelText("トークン"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "変更を作る" }));
    expect(await screen.findByText(/英小文字・数字・ハイフン/)).toBeTruthy();
    expect(api.count("POST /secrets/changes")).toBe(0);
    expect(container.innerHTML).not.toContain(TOKEN);
  });
});
