/**
 * ローカルAPI の認証（9.2）：CLI の Bearer トークンと、承認アプリのセッションクッキー。
 *
 * - `Authorization` があれば Bearer として確かめる（違えばクッキーは見ずに 401）
 * - なければクッキー `aicoop_session` を確かめる（有効な端末のセッションだけ）
 * - クッキーで来たリクエストは、`Sec-Fetch-Site` があれば `same-origin`・`none` だけを受ける。
 *   状態を変えるもの（GET・HEAD 以外）は、`Origin` が `http://localhost:<port>` でなければ 403（CSRF 対策）
 * - 認証なしの道（ペアリング・ログイン）の POST も、`Origin` を同じように確かめる（`requireSameOrigin`）
 * - 道ごとに、Bearer だけ（`requireBearer`：止める・読み直す・ペアリングのコード）か、クッキーだけ
 *   （`requireCookie`：承認の署名・ログイン中の端末）かを決める。どちらも付けない道は、両方で使える
 *
 * 認証なしの道は、この確かめより前に登録する（server.ts）。道の分け方は Hono の道の一致で決まるので、
 * パスの書き方（%xx など）で、確かめと道の食い違いは起きない。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiError, ApiErrorCode } from "@aicoop/shared/api";
import type { Context, MiddlewareHandler } from "hono";
import type { ApprovalService } from "../approvals/service.ts";
import { SESSION_COOKIE } from "../approvals/sessions.ts";
import { appOrigin } from "../approvals/webauthn.ts";

const MAX_TOKEN_CHARS = 512;
/** 1つのリクエストで見るクッキー `aicoop_session` の数（ほかのポートのソフトが同じ名前を置くことがある） */
const MAX_SESSION_COOKIES = 4;

export type Caller =
  | { readonly kind: "bearer" }
  | {
      readonly kind: "cookie";
      readonly deviceId: string;
      readonly expiresAt: Date;
      readonly token: string;
    };

const callers = new WeakMap<Request, Caller>();

/** 認証の確かめを通ったリクエストの呼び手 */
export function callerOf(c: Context): Caller | undefined {
  return callers.get(c.req.raw);
}

/** 監査ログの actor：CLI なら `owner:cli`、承認アプリならログイン中の端末 `owner:<device_id>` */
export function actorOf(c: Context): `owner:${string}` {
  const caller = callerOf(c);
  return caller?.kind === "cookie" ? `owner:${caller.deviceId}` : "owner:cli";
}

function errorBody(code: ApiErrorCode, message: string): ApiError {
  return { error: code, message };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** 時間が一定の比較（長さが違っても例外にしない） */
function tokenMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

/** Cookie ヘッダーから、名前が `aicoop_session` の値をすべて取り出す */
export function sessionCookies(header: string | undefined): string[] {
  if (header === undefined) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    values.push(part.slice(eq + 1).trim());
    if (values.length >= MAX_SESSION_COOKIES) break;
  }
  return values;
}

/** `Sec-Fetch-Site` が、ほかのオリジンからのリクエストを示していないか */
function fetchSiteOk(c: Context): boolean {
  const site = c.req.header("sec-fetch-site");
  return site === undefined || site === "same-origin" || site === "none";
}

/** `Origin` が承認アプリのオリジン（http://localhost:<port>）か */
export function sameOrigin(c: Context, port: number): boolean {
  return c.req.header("origin") === appOrigin(port) && fetchSiteOk(c);
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

const forbiddenOrigin = (port: number) =>
  errorBody(
    "forbidden_origin",
    `このリクエストは受け付けません（承認アプリ http://localhost:${port}/app/ の画面からだけ使えます）`,
  );

export interface AuthOptions {
  readonly token: string;
  readonly port: () => number;
  readonly approvals: ApprovalService;
}

/** Bearer トークンか、セッションクッキーで認証する（認証なしの道より後ろに置く） */
export function authenticate(options: AuthOptions): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization");
    if (header !== undefined) {
      const m = /^bearer ([A-Za-z0-9_-]+)$/i.exec(header);
      const given = m?.[1];
      if (
        given === undefined ||
        given.length > MAX_TOKEN_CHARS ||
        !tokenMatches(given, options.token)
      ) {
        return c.json(
          errorBody(
            "unauthorized",
            "トークンが違います（runtime/api_token のトークンを Authorization: Bearer で送ってください。daemon を起動するたびに作り直されます）",
          ),
          401,
        );
      }
      callers.set(c.req.raw, { kind: "bearer" });
      return next();
    }

    for (const value of sessionCookies(c.req.header("cookie"))) {
      const session = options.approvals.sessionFor(value);
      if (session === undefined) continue;
      const port = options.port();
      if (!fetchSiteOk(c)) return c.json(forbiddenOrigin(port), 403);
      if (!SAFE_METHODS.has(c.req.method) && !sameOrigin(c, port)) {
        return c.json(forbiddenOrigin(port), 403);
      }
      callers.set(c.req.raw, {
        kind: "cookie",
        deviceId: session.device.id,
        expiresAt: session.expiresAt,
        token: value,
      });
      return next();
    }

    return c.json(
      errorBody(
        "unauthorized",
        "トークンがないか、違います（CLI は runtime/api_token のトークンを Authorization: Bearer で送ってください。daemon を起動するたびに作り直されます。承認アプリは、パスキーでログインし直してください）",
      ),
      401,
    );
  };
}

/** この道は CLI（Bearer）だけ */
export const requireBearer: MiddlewareHandler = async (c, next) => {
  if (callerOf(c)?.kind !== "bearer") {
    return c.json(
      errorBody("unauthorized", "この操作は、PC の CLI（aicoop コマンド）からだけできます"),
      401,
    );
  }
  return next();
};

/** この道は承認アプリ（パスキーでログインしたセッション）だけ */
export const requireCookie: MiddlewareHandler = async (c, next) => {
  if (callerOf(c)?.kind !== "cookie") {
    return c.json(
      errorBody(
        "unauthorized",
        "この操作は、承認アプリでパスキーでログインしてからだけできます（承認をするコマンドはありません）",
      ),
      401,
    );
  }
  return next();
};

/**
 * この道は、PC のブラウザの承認アプリのセッション（`localhost` のクッキー）だけ（5.14 の6、D-27、T-15）。
 * 準備・設定・資格・イメージの道に付ける。
 *
 * - CLI の Bearer トークンからは受けない（401。CLI には同じことをするコマンドがある）
 * - クッキーの確かめ（Host が `127.0.0.1`・`localhost`、POST の `Origin` が `http://localhost:<port>`）は
 *   `authenticate` で済んでいる
 * - **P3 の中継の `rpc_request`（9.4）から来た要求は、ここで弾く場所**：中継から来たものは、道がないもの
 *   （404 `not_found`）として扱う。中継の呼び手（Caller の新しい種類）を足すときは、ここで 404 を返すこと
 */
export const requireLocalSession: MiddlewareHandler = async (c, next) => {
  const caller = callerOf(c);
  if (caller?.kind === "cookie") return next();
  if (caller?.kind === "bearer") {
    return c.json(
      errorBody(
        "unauthorized",
        "この操作は、PC のブラウザの承認アプリ（パスキーでログインしたもの）からだけできます。CLI では aicoop secret・設定のファイルの編集と aicoop reload を使ってください",
      ),
      401,
    );
  }
  // 中継などの、ほかの呼び手（P3）：道がないものとして扱う（D-27）
  return c.json(errorBody("not_found", "その道はありません"), 404);
};

/** 認証なしの道の POST：`Origin` が承認アプリのオリジンでなければ 403 */
export function requireSameOrigin(port: () => number): MiddlewareHandler {
  return async (c, next) => {
    if (!sameOrigin(c, port())) return c.json(forbiddenOrigin(port()), 403);
    return next();
  };
}
