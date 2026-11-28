/**
 * ローカルAPI の道：端末の登録（ペアリング）・パスキーでのログイン・端末・承認の署名（9.2、5.8）。
 * 形は `@aicoop/shared/api` のとおり。
 *
 * | 道 | 認証 |
 * |---|---|
 * | `POST /pairing/options`・`POST /pairing/register` | なし（1回限りのコードが鍵）。`Origin` を確かめる |
 * | `POST /auth/login/options`・`POST /auth/login/verify` | なし。`Origin` を確かめる |
 * | `POST /pairing/local`・`GET /pairing/local/{code}`・`POST /pairing/local/{code}/activate`・`/cancel` | Bearer だけ |
 * | `GET /auth/me`・`POST /auth/logout`・`POST /approvals/intent`・`POST /approvals/assert` | クッキーだけ |
 * | `GET /devices`・`POST /devices/{id}/revoke` | Bearer・クッキー |
 *
 * セッションクッキー `aicoop_session`：HttpOnly・SameSite=Strict・Path=/api/v1・Max-Age は期限まで（8時間）。
 * `Secure` は付けない（http://localhost で配るため）。値はランダムで、サーバーはハッシュだけを持つ。
 */
import type {
  ActivatePairingResponse,
  ApiError,
  CancelPairingResponse,
  ListDevicesResponse,
  LoginVerifyResponse,
  LogoutResponse,
  MeResponse,
  RevokeDeviceResponse,
} from "@aicoop/shared/api";
import { type Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import type { Logger } from "pino";
import { toDeviceView } from "../../approvals/devices.ts";
import { ApprovalFailure } from "../../approvals/errors.ts";
import type { ApprovalService } from "../../approvals/service.ts";
import { SESSION_COOKIE, SESSION_TTL_MS } from "../../approvals/sessions.ts";
import { actorOf, callerOf, requireBearer, requireCookie, requireSameOrigin } from "../auth.ts";

const COOKIE_PATH = "/api/v1";

export interface ApprovalRoutesOptions {
  readonly approvals: ApprovalService;
  readonly logger: Logger;
  readonly port: () => number;
}

function errorBody(error: ApprovalFailure): ApiError {
  return error.issues === undefined
    ? { error: error.code, message: error.message }
    : { error: error.code, message: error.message, issues: error.issues };
}

export function withErrors(app: Hono, logger: Logger): Hono {
  app.onError((error, c) => {
    if (error instanceof ApprovalFailure) return c.json(errorBody(error), error.status);
    logger.error(
      { err: error, method: c.req.method, path: c.req.path },
      "承認まわりの API の中でエラーが起きました",
    );
    const body: ApiError = {
      error: "internal",
      message: "制御サーバーの中でエラーが起きました。daemon のログを見てください",
    };
    return c.json(body, 500);
  });
  return app;
}

/** 本文を JSON として読む（Content-Type が JSON でなければ 415、読めなければ 400） */
export async function jsonBody(c: Context): Promise<unknown> {
  const type = c.req.header("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(type)) {
    throw new ApprovalFailure(
      415,
      "invalid_input",
      "本文は JSON（Content-Type: application/json）で送ってください",
    );
  }
  try {
    return JSON.parse(await c.req.text());
  } catch {
    throw new ApprovalFailure(400, "invalid_input", "本文を JSON として読めません");
  }
}

/**
 * 認証なしの道（server.ts で、認証の確かめより前に登録する）。
 * Cache-Control: no-store・nosniff は、server.ts の決まりで付く
 */
export function publicApprovalRoutes(options: ApprovalRoutesOptions): Hono {
  const { approvals } = options;
  const app = new Hono();
  const origin = requireSameOrigin(options.port);

  app.post("/pairing/options", origin, async (c) =>
    c.json(await approvals.pairing.options(await jsonBody(c))),
  );

  app.post("/pairing/register", origin, async (c) =>
    c.json(await approvals.pairing.register(await jsonBody(c))),
  );

  app.post("/auth/login/options", origin, async (c) => c.json(await approvals.login.options()));

  app.post("/auth/login/verify", origin, async (c) => {
    const result = await approvals.login.verify(await jsonBody(c));
    // セッションは作ったばかりなので、残りは SESSION_TTL_MS
    setCookie(c, SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: "Strict",
      path: COOKIE_PATH,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
    const body: LoginVerifyResponse = {
      device: toDeviceView(result.device),
      expires_at: result.expiresAt.toISOString(),
    };
    return c.json(body);
  });

  return withErrors(app, options.logger);
}

/** 認証のあとの道（Bearer・クッキー） */
export function protectedApprovalRoutes(options: ApprovalRoutesOptions): Hono {
  const { approvals } = options;
  const app = new Hono();

  // ---- 端末の登録（CLI） ----
  app.post("/pairing/local", requireBearer, (c) => c.json(approvals.pairing.start(), 201));
  app.get("/pairing/local/:code", requireBearer, (c) =>
    c.json(approvals.pairing.status(c.req.param("code"))),
  );
  app.post("/pairing/local/:code/activate", requireBearer, (c) => {
    const body: ActivatePairingResponse = {
      device: approvals.pairing.activate(c.req.param("code")),
    };
    return c.json(body);
  });
  app.post("/pairing/local/:code/cancel", requireBearer, (c) => {
    approvals.pairing.cancel(c.req.param("code"));
    const body: CancelPairingResponse = { ok: true };
    return c.json(body);
  });

  // ---- ログイン中の端末（承認アプリ） ----
  app.get("/auth/me", requireCookie, (c) => {
    const caller = callerOf(c);
    const session = caller?.kind === "cookie" ? approvals.sessionFor(caller.token) : undefined;
    if (session === undefined) {
      throw new ApprovalFailure(401, "unauthorized", "ログインしていません");
    }
    const body: MeResponse = {
      device: toDeviceView(session.device),
      expires_at: session.expiresAt.toISOString(),
    };
    return c.json(body);
  });
  app.post("/auth/logout", requireCookie, (c) => {
    const caller = callerOf(c);
    if (caller?.kind === "cookie") approvals.logout(caller.token);
    setCookie(c, SESSION_COOKIE, "", {
      httpOnly: true,
      sameSite: "Strict",
      path: COOKIE_PATH,
      maxAge: 0,
    });
    const body: LogoutResponse = { ok: true };
    return c.json(body);
  });

  // ---- 端末（CLI・承認アプリ） ----
  app.get("/devices", (c) => {
    const body: ListDevicesResponse = { devices: approvals.listDevices() };
    return c.json(body);
  });
  app.post("/devices/:id/revoke", (c) => {
    const body: RevokeDeviceResponse = {
      device: approvals.revokeDevice(c.req.param("id"), actorOf(c)),
    };
    return c.json(body);
  });

  // ---- 承認の署名（承認アプリ。5.8 の3） ----
  app.post("/approvals/intent", requireCookie, async (c) => {
    const caller = callerOf(c);
    if (caller?.kind !== "cookie")
      throw new ApprovalFailure(401, "unauthorized", "ログインしていません");
    return c.json(await approvals.signer.intent(caller.deviceId, await jsonBody(c)));
  });
  app.post("/approvals/assert", requireCookie, async (c) => {
    const caller = callerOf(c);
    if (caller?.kind !== "cookie")
      throw new ApprovalFailure(401, "unauthorized", "ログインしていません");
    return c.json(await approvals.signer.assert(caller.deviceId, await jsonBody(c)));
  });

  return withErrors(app, options.logger);
}
