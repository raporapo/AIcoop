/**
 * ローカルAPI の道：準備の画面（9.2、5.14 の3）。形は `@aicoop/shared/api` のとおり。
 *
 * | 道 | 中身 |
 * |---|---|
 * | `GET /setup` | 準備の確認を、4つの段階（会社の名前 → Claude → GitHub → イメージ）に分けたもの |
 * | `POST /setup/company` | `{name}`：aicoop.yaml の company.name を書き換える設定の変更（署名を待つ） |
 * | `POST /setup/github/repositories` | `{repositories}`：groups.yaml の your-org を書き換える設定の変更（署名を待つ） |
 * | `POST /setup/claude-login` | Claude へのログインを始める（URL を返す。同時に1つ、10分で取り消す） |
 * | `POST /setup/claude-login/{id}/code` | `{code}`：コードを setup-token に渡す。トークンから資格の変更（署名を待つ）を作る |
 * | `POST /setup/claude-login/{id}/cancel` | ログインを取り消す |
 * | `POST /images/build` / `GET /images/build` | 箱のイメージを作る（同時に1つ）・進み具合 |
 *
 * どれも PC のブラウザのセッションだけ（`requireLocalSession`。Bearer は 401、P3 の中継から来たものは 404）。
 * GitHub の資格は、資格の画面と同じ `POST /secrets/changes` で登録する。
 */
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Setup } from "../../setup/service.ts";
import { requireLocalSession } from "../auth.ts";
import { jsonBody, withErrors } from "./approvals.ts";

export interface SetupRoutesOptions {
  readonly setup: Setup;
  readonly logger: Logger;
}

export function setupRoutes(options: SetupRoutesOptions): Hono {
  const { setup } = options;
  const app = new Hono();
  app.use("/setup", requireLocalSession);
  app.use("/setup/*", requireLocalSession);
  app.use("/images/*", requireLocalSession);

  app.get("/setup", async (c) => c.json(await setup.status()));
  app.post("/setup/company", async (c) => c.json(setup.proposeCompanyName(await jsonBody(c)), 201));
  app.post("/setup/github/repositories", async (c) =>
    c.json(setup.proposeRepositories(await jsonBody(c)), 201),
  );

  app.post("/setup/claude-login", async (c) => c.json(await setup.login.start(), 201));
  app.post("/setup/claude-login/:id/code", async (c) => {
    const body = await jsonBody(c);
    const code =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>).code
        : undefined;
    if (typeof body === "object" && body !== null && Object.keys(body).some((k) => k !== "code")) {
      return c.json(
        {
          error: "invalid_input",
          message: "本文に書けるのは code だけです（ほかのキーの名前は表示しません）",
        },
        400,
      );
    }
    return c.json(await setup.login.submitCode(c.req.param("id"), code));
  });
  app.post("/setup/claude-login/:id/cancel", (c) => c.json(setup.login.cancel(c.req.param("id"))));

  app.post("/images/build", (c) => c.json(setup.images.start(), 202));
  app.get("/images/build", (c) => c.json({ build: setup.images.current() }));

  return withErrors(app, options.logger);
}
