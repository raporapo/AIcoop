import type {
  ClaudeLoginView,
  CreateConfigChangeResponse,
  CreateSecretChangeResponse,
  ImageBuildView,
  SetupResponse,
  SetupStepId,
} from "@aicoop/shared/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { createFakeApi, type FakeApi, fail, ok } from "../testing/fake-api.ts";
import { iso, NOW } from "../testing/fixtures.ts";
import { assertOk, fakeIntent } from "../testing/intent.ts";
import { renderApp } from "../testing/render.tsx";
import { installFakeWebAuthn } from "../testing/webauthn.ts";

const URL = "https://claude.ai/oauth/authorize?IMeNLHJMkrH2UN_V5CAd50YPtDYRKh0F903qpeiMx3cE";
const CODE = "AbCdEf0123456789_-AbCdEf0123456789#state_0123456789";
const GITHUB_TOKEN = "github_pat_APPROVER_SETUP_SCREEN_TOKEN_0123456789";
const LOGIN_ID = "6f0e2f6e-1d2a-4b9b-8f53-2a0f8d5c1e77";
const CONFIG_CHANGE = "x_01JQ0000000000000000000011";
const SECRET_CHANGE = "x_01JQ0000000000000000000012";

function setupResponse(
  over: Partial<SetupResponse> = {},
  done: readonly SetupStepId[] = [],
): SetupResponse {
  const item = (id: string, step: SetupStepId, message: string) => ({
    id,
    ok: done.includes(step),
    message,
  });
  const steps = (
    [
      [
        "company",
        [item("company:name", "company", "会社の名前が、雛形の「わたしの会社」のままです")],
      ],
      [
        "claude",
        [item("secret:anthropic", "claude", "Claude（Anthropic）の資格が登録されていません")],
      ],
      [
        "github",
        [
          item(
            "secret:github",
            "github",
            "GitHub の資格（github、github_app）が登録されていません",
          ),
          item("placeholder:your-org", "github", "雛形の「your-org」が残っています"),
        ],
      ],
      ["image", [item("image:base", "image", "vm の箱のイメージがありません")]],
    ] as const
  ).map(([id, items]) => ({ id, ok: done.includes(id), items }));
  return {
    ready: done.length === 4,
    steps,
    others: [],
    company: { name: "わたしの会社" },
    github: { secret_id: "github", secret_kind: null, repositories: [], placeholder: true },
    claude_login: null,
    image_build: null,
    ...over,
  };
}

function configChange(path: string): CreateConfigChangeResponse {
  return {
    id: CONFIG_CHANGE,
    summary: {
      files: [
        {
          path,
          before_sha256: "a".repeat(64),
          after_sha256: "b".repeat(64),
          diff: `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+y\n`,
        },
      ],
    },
    warnings: [],
    expires_at: iso(NOW + 10 * 60_000),
  };
}

const SECRET: CreateSecretChangeResponse = {
  id: SECRET_CHANGE,
  summary: { id: "anthropic", kind: "anthropic_oauth", action: "create" },
  expires_at: iso(NOW + 10 * 60_000),
};

function loginView(over: Partial<ClaudeLoginView> = {}): ClaudeLoginView {
  return {
    id: LOGIN_ID,
    state: "waiting_code",
    url: URL,
    started_at: iso(NOW),
    expires_at: iso(NOW + 10 * 60_000),
    message: null,
    change: null,
    ...over,
  };
}

function setup(
  options: { setup?: SetupResponse; hash?: string; summaries?: Record<string, unknown> } = {},
) {
  const webauthn = installFakeWebAuthn();
  const api = createFakeApi({
    "GET /holds": ok({ holds: [] }),
    "GET /grants": ok({ grants: [] }),
    "GET /setup": ok(options.setup ?? setupResponse()),
  });
  const summaries: Record<string, unknown> = { ...options.summaries };
  fakeIntent(api, { summaryOf: (id) => summaries[id] });
  const view = renderApp({ api, hash: options.hash ?? "#/setup" });
  return { api, webauthn, summaries, container: view.container };
}

const lastBody = (api: FakeApi, path: string) =>
  [...api.calls].reverse().find((c) => c.path === path)?.body;

async function sign(api: FakeApi, type: "config_change" | "secret_change", id: string) {
  api.on("POST /approvals/assert", assertOk(type, id, "approve", "applied"));
  fireEvent.click(await screen.findByRole("button", { name: /保存する…/ }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: /パスキーで署名して保存する/ }));
  expect(await screen.findByText("保存しました。")).toBeTruthy();
}

describe("5.14 の3：準備の画面", () => {
  test("会社の名前 → Claude → GitHub → イメージ の順に並べ、済んだものに印を付ける", async () => {
    setup({ setup: setupResponse({}, ["company", "github"]) });
    expect(await screen.findByRole("heading", { level: 1, name: "準備" })).toBeTruthy();
    const headings = (await screen.findAllByRole("heading", { level: 2 })).map(
      (h) => h.textContent ?? "",
    );
    expect(headings.slice(0, 4).map((h) => h.replace(/\s+(✓ 済み|○ まだ)$/, ""))).toEqual([
      "1. 会社の名前",
      "2. Claude へのログイン",
      "3. GitHub",
      "4. 箱のイメージ",
    ]);
    expect(headings[0]).toContain("済み");
    expect(headings[1]).toContain("まだ");
    expect(headings[2]).toContain("済み");
    expect(headings[3]).toContain("まだ");
  });

  test("ナビに「準備」がある", async () => {
    setup();
    const nav = await screen.findByRole("navigation", { name: "画面" });
    const link = within(nav).getByRole("link", { name: "準備" });
    expect(link.getAttribute("href")).toBe("#/setup");
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  test("ログインしたあと、準備が済んでいなければ準備の画面に案内する", async () => {
    setup({ hash: "#/pending" });
    await waitFor(() => expect(window.location.hash).toBe("#/setup"));
    expect(await screen.findByRole("heading", { level: 1, name: "準備" })).toBeTruthy();
  });

  test("準備が済んでいれば、案内しない", async () => {
    const { api } = setup({
      hash: "#/pending",
      setup: setupResponse({}, ["company", "claude", "github", "image"]),
    });
    await waitFor(() => expect(api.count("GET /setup")).toBe(1));
    expect(window.location.hash).toBe("#/pending");
  });

  test("ほかの画面へのリンクで開いたときは、案内しない", async () => {
    const { api } = setup({ hash: "#/audit" });
    api.on("GET /audit", ok({ entries: [], next_after: null }));
    await waitFor(() => expect(api.count("GET /setup")).toBe(1));
    expect(window.location.hash).toBe("#/audit");
  });
});

describe("5.14 の3の1：会社の名前", () => {
  test("名前を変える設定の変更を作り、パスキーで署名してから保存する", async () => {
    const change = configChange("aicoop.yaml");
    const { api } = setup({ summaries: { [CONFIG_CHANGE]: change.summary } });
    api.on("POST /setup/company", { status: 201, body: change });
    fireEvent.change(await screen.findByRole("textbox", { name: "会社の名前" }), {
      target: { value: " サンプル商会 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "名前を変える変更を作る" }));
    expect(await screen.findByRole("figure", { name: "aicoop.yaml の差分" })).toBeTruthy();
    expect(lastBody(api, "/setup/company")).toEqual({ name: "サンプル商会" });
    await sign(api, "config_change", CONFIG_CHANGE);
    await waitFor(() => expect(api.count("GET /setup")).toBeGreaterThanOrEqual(2));
  });

  test("拒否側：改行・制御文字を含む名前は送らない", async () => {
    const { api } = setup();
    fireEvent.change(await screen.findByRole("textbox", { name: "会社の名前" }), {
      target: { value: "サンプル\x1b商会" },
    });
    fireEvent.click(screen.getByRole("button", { name: "名前を変える変更を作る" }));
    expect(await screen.findByText(/改行や制御文字は使えません/)).toBeTruthy();
    expect(api.count("POST /setup/company")).toBe(0);
  });
});

describe("5.14 の3の2：Claude へのログイン", () => {
  test("始めると、ログイン用の URL を開くボタンを出す（別のタブ・opener なし）", async () => {
    const { api } = setup();
    api.on("POST /setup/claude-login", { status: 201, body: loginView() });
    fireEvent.click(await screen.findByRole("button", { name: "Claude にログインする" }));
    const link = await screen.findByRole("link", { name: "ブラウザで Claude にログインする" });
    expect(link.getAttribute("href")).toBe(URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("コードを貼ると setup-token に渡し、資格の変更（トークンは来ない）を SecretChangeReview で署名する", async () => {
    const { api, container } = setup({
      setup: setupResponse({ claude_login: loginView() }),
      summaries: { [SECRET_CHANGE]: SECRET.summary },
    });
    api.on(
      "POST /setup/claude-login/" + LOGIN_ID + "/code",
      ok(loginView({ state: "done", url: null, change: SECRET })),
    );
    const input = (await screen.findByRole("textbox", {
      name: "ブラウザに出たコード",
    })) as HTMLInputElement;
    expect(input.autocomplete).toBe("off");
    fireEvent.change(input, { target: { value: `  ${CODE}  ` } });
    fireEvent.click(screen.getByRole("button", { name: "コードを渡す" }));
    expect(await screen.findByText(/登録します/)).toBeTruthy();
    expect(lastBody(api, `/setup/claude-login/${LOGIN_ID}/code`)).toEqual({ code: CODE });
    // 貼ったコードは画面に残さない
    expect(container.innerHTML).not.toContain(CODE);
    api.on(
      "POST /approvals/assert",
      assertOk("secret_change", SECRET_CHANGE, "approve", "applied"),
    );
    fireEvent.click(await screen.findByRole("button", { name: /保存する…/ }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /パスキーで署名して保存する/ }));
    expect(await screen.findByText(/Claude のトークンを登録しました/)).toBeTruthy();
    await waitFor(() => expect(api.count("GET /setup")).toBeGreaterThanOrEqual(2));
  });

  test("拒否側：daemon が返した URL が Claude のログインの形でなければ、開くボタンを出さない", async () => {
    setup({
      setup: setupResponse({
        claude_login: loginView({ url: "https://evil.example/oauth/authorize?x" }),
      }),
    });
    expect(await screen.findByText(/URL の形が違うので、開きません/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "ブラウザで Claude にログインする" })).toBeNull();
  });

  test("拒否側：制御文字・長すぎるコードは送らない", async () => {
    const { api } = setup({ setup: setupResponse({ claude_login: loginView() }) });
    for (const value of [`${CODE}\x1b[2J`, "a".repeat(513)]) {
      fireEvent.change(await screen.findByRole("textbox", { name: "ブラウザに出たコード" }), {
        target: { value },
      });
      fireEvent.click(screen.getByRole("button", { name: "コードを渡す" }));
      expect(await screen.findByText(/コードの形が違います/)).toBeTruthy();
    }
    expect(api.count(`POST /setup/claude-login/${LOGIN_ID}/code`)).toBe(0);
  });

  test("setup-token が失敗したら、その理由を出す（何も登録していない）", async () => {
    const { api } = setup({ setup: setupResponse({ claude_login: loginView() }) });
    api.on(
      `POST /setup/claude-login/${LOGIN_ID}/code`,
      fail(
        422,
        "login_failed",
        "claude setup-token が失敗しました（終了コード 1）。何も登録していません",
      ),
    );
    fireEvent.change(await screen.findByRole("textbox", { name: "ブラウザに出たコード" }), {
      target: { value: CODE },
    });
    fireEvent.click(screen.getByRole("button", { name: "コードを渡す" }));
    expect((await screen.findByRole("alert")).textContent).toContain("何も登録していません");
  });

  test("取り消せる。終わったログイン（10分の取り消しなど）の理由を出し、もう一度始められる", async () => {
    const { api } = setup({ setup: setupResponse({ claude_login: loginView() }) });
    api.on(
      `POST /setup/claude-login/${LOGIN_ID}/cancel`,
      ok(
        loginView({
          state: "cancelled",
          url: null,
          message: "取り消しました。何も登録していません",
        }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "取り消す" }));
    expect(await screen.findByText("取り消しました。何も登録していません")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claude にログインする" })).toBeTruthy();
  });
});

describe("5.14 の3の3：GitHub", () => {
  test("資格：貼り付け欄は type=password。値を画面に残さず、資格 github の変更を作って署名する", async () => {
    const change: CreateSecretChangeResponse = {
      id: SECRET_CHANGE,
      summary: { id: "github", kind: "static_token", action: "create" },
      expires_at: iso(NOW + 10 * 60_000),
    };
    const { api, container } = setup({ summaries: { [SECRET_CHANGE]: change.summary } });
    api.on("POST /secrets/changes", { status: 201, body: change });
    const token = (await screen.findByLabelText("トークン")) as HTMLInputElement;
    expect(token.type).toBe("password");
    fireEvent.change(token, { target: { value: GITHUB_TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "GitHub の資格の変更を作る" }));
    expect(await screen.findByText(/登録します/)).toBeTruthy();
    expect(lastBody(api, "/secrets/changes")).toEqual({
      id: "github",
      kind: "static_token",
      value: { token: GITHUB_TOKEN },
    });
    expect(container.innerHTML).not.toContain(GITHUB_TOKEN);
    for (const input of Array.from(container.querySelectorAll("input"))) {
      expect(input.value).not.toContain(GITHUB_TOKEN);
    }
    await sign(api, "secret_change", SECRET_CHANGE);
  });

  test("リポジトリ：1行に1つ入れて、groups.yaml の your-org を書き換える変更を作る", async () => {
    const change = configChange("groups.yaml");
    const { api } = setup({ summaries: { [CONFIG_CHANGE]: change.summary } });
    api.on("POST /setup/github/repositories", { status: 201, body: change });
    fireEvent.change(await screen.findByRole("textbox", { name: "リポジトリ（1行に1つ）" }), {
      target: { value: "raporapo/*\n me/app \n\nme/app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "リポジトリを書き換える変更を作る" }));
    expect(await screen.findByRole("figure", { name: "groups.yaml の差分" })).toBeTruthy();
    expect(lastBody(api, "/setup/github/repositories")).toEqual({
      repositories: ["raporapo/*", "me/app"],
    });
    await sign(api, "config_change", CONFIG_CHANGE);
  });

  test.each([["*/*"], ["../x"], ["owner/re po"], ["your-org/*"], ["a/b/c"]])(
    "拒否側：リポジトリ %j は送らない",
    async (value) => {
      const { api } = setup();
      fireEvent.change(await screen.findByRole("textbox", { name: "リポジトリ（1行に1つ）" }), {
        target: { value },
      });
      fireEvent.click(screen.getByRole("button", { name: "リポジトリを書き換える変更を作る" }));
      expect(await screen.findByText(/形が違います/)).toBeTruthy();
      expect(api.count("POST /setup/github/repositories")).toBe(0);
    },
  );

  test("your-org をもう書き換えていれば、いまのリポジトリを出し、設定の画面に案内する", async () => {
    setup({
      setup: setupResponse({
        github: {
          secret_id: "github",
          secret_kind: "github_app",
          repositories: ["raporapo/*"],
          placeholder: false,
        },
      }),
    });
    expect(await screen.findByText("raporapo/*")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "リポジトリ（1行に1つ）" })).toBeNull();
    expect(screen.getByText(/もう書き換えてあります/)).toBeTruthy();
  });
});

describe("5.14 の3の4：箱のイメージ", () => {
  const running = (over: Partial<ImageBuildView> = {}): ImageBuildView => ({
    id: "b1",
    state: "running",
    stage: null,
    lines: [],
    started_at: iso(NOW),
    finished_at: null,
    message: null,
    ...over,
  });

  test("ボタンで作り始め、段階とログを出す。作っているあいだはボタンを押せない", async () => {
    const { api } = setup();
    api.on("POST /images/build", { status: 202, body: running() });
    api.on(
      "GET /images/build",
      ok({
        build: running({
          stage: { index: 1, total: 2, label: "ベースのイメージを作っています" },
          lines: ["Building guest assets for x86_64 (alpine)"],
        }),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "イメージを作る" }));
    const busy = await screen.findByRole("button", { name: "イメージを作っています…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "進み具合を読み直す" }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("段階 1/2：ベースのイメージを作っています"),
    );
    expect(screen.getByText("Building guest assets for x86_64 (alpine)")).toBeTruthy();

    api.on(
      "GET /images/build",
      ok({
        build: running({
          state: "succeeded",
          finished_at: iso(NOW),
          message: "箱のイメージを作りました。次の実行から使います",
        }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "進み具合を読み直す" }));
    expect(await screen.findByText("箱のイメージを作りました。次の実行から使います")).toBeTruthy();
    await waitFor(() => expect(api.count("GET /setup")).toBeGreaterThanOrEqual(2));
  });

  test("二重に作ろうとしたとき（409）・Windows（unavailable）は、理由を出す", async () => {
    const { api } = setup();
    api.on(
      "POST /images/build",
      fail(409, "unavailable", "Windows では vm の箱のイメージを作れません"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "イメージを作る" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Windows では");
  });
});
