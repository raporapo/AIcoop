/**
 * ローカルAPI の道：設定の画面と資格の画面（9.2、5.14 の4・5）。形は `@aicoop/shared/api` のとおり。
 *
 * | 道 | 中身 |
 * |---|---|
 * | `GET /config/files` | 設定のファイルの一覧（パス・大きさ・SHA-256・更新日時） |
 * | `GET /config/files/{path}` | 中身と SHA-256 |
 * | `POST /config/changes` | 変更を作る（検証して、署名を待つ。本文は 1 MiB まで） |
 * | `GET /secrets` | 資格の一覧（ID・種類・更新日時。中身なし） |
 * | `POST /secrets/changes` | 資格の変更を作る（署名を待つ） |
 *
 * どれも PC のブラウザのセッションだけ（`requireLocalSession`。Bearer は 401、P3 の中継から来たものは 404）。
 * 保存は、`POST /approvals/intent`・`/approvals/assert`（`type: "config_change" | "secret_change"`）で署名してから。
 *
 * `{path}` は、URL のパスをデコードせずに、`CONFIG_FILE_PATH_PATTERN` と照らす。`%` を含むもの（`%2e`・`%2f`・
 * `%5c`・`%00` など）は、デコードすれば何になるかに関わらず「ない」とする（拒否側に倒す）。
 */
import { API_PREFIX, type ApiError } from "@aicoop/shared/api";
import { type Context, Hono } from "hono";
import type { Logger } from "pino";
import type { Settings } from "../../settings/service.ts";
import { requireLocalSession } from "../auth.ts";
import { jsonBody, withErrors } from "./approvals.ts";

export interface SettingsRoutesOptions {
  readonly settings: Settings;
  readonly logger: Logger;
}

const FILES_PREFIX = `${API_PREFIX}/config/files/`;

/** `/config/files/` より後ろの、デコードしていないパス。読めなければ null */
function rawFilePath(c: Context): string | null {
  let pathname: string;
  try {
    pathname = new URL(c.req.url).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(FILES_PREFIX)) return null;
  const rest = pathname.slice(FILES_PREFIX.length);
  return rest.includes("%") ? null : rest;
}

const notFound: ApiError = {
  error: "not_found",
  message:
    "そのファイルはありません（設定の画面で扱えるのは、6.1 の yaml・services/*.yaml・prompts/ の md だけです）",
};

export function settingsRoutes(options: SettingsRoutesOptions): Hono {
  const { settings } = options;
  const app = new Hono();
  app.use("/config/*", requireLocalSession);
  app.use("/secrets", requireLocalSession);
  app.use("/secrets/*", requireLocalSession);

  app.get("/config/files", (c) => c.json(settings.listFiles()));
  app.get("/config/files/*", (c) => {
    const path = rawFilePath(c);
    if (path === null) return c.json(notFound, 404);
    return c.json(settings.readFile(path));
  });
  app.post("/config/changes", async (c) =>
    c.json(settings.createConfigChange(await jsonBody(c)), 201),
  );

  app.get("/secrets", (c) => c.json(settings.listSecrets()));
  app.post("/secrets/changes", async (c) =>
    c.json(settings.createSecretChange(await jsonBody(c)), 201),
  );

  return withErrors(app, options.logger);
}
