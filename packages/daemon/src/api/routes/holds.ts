/**
 * ローカルAPI（9.2）の保留と一時権限：`GET /holds`・`GET /holds/{id}`・`GET /grants`。
 *
 * 形は `@aicoop/shared/api` の `ListHoldsResponse`・`GetHoldResponse`・`ListGrantsResponse`。
 * 認証（Bearer・クッキー）と Host の確かめは、server.ts の前段で済んでいる。
 *
 * - 一覧は新しい順。`status=<状態,状態>` で絞る（知らない状態は 400）。なければすべての状態。`limit` は 1〜500（既定100）
 * - `GET /holds/{id}` は、保存したリクエストを展開して見せる（5.7.1 の4）：メソッド・URL・認証以外のヘッダー・
 *   本文（UTF-8 として読めればテキスト、読めなければ base64。先頭 256 KiB）・再送の結果の本文の先頭（64 KiB）
 */
import { isId } from "@aicoop/shared";
import type {
  ApiError,
  GetHoldResponse,
  ListGrantsResponse,
  ListHoldsResponse,
} from "@aicoop/shared/api";
import type { Context, Hono } from "hono";
import { GRANT_STATUSES, type GrantStatus, isGrantStatus, listGrants } from "../../db/grants.ts";
import {
  getHold,
  HOLD_STATUSES,
  type HoldStatus,
  isHoldStatus,
  listHolds,
} from "../../db/holds.ts";
import type { StateDb } from "../../db/open.ts";
import { toGrantView, toHoldDetailView, toHoldView } from "../../holds/views.ts";
import type { AicoopPaths } from "../../paths.ts";

export interface HoldRoutesDeps {
  readonly db: StateDb;
  readonly paths: AicoopPaths;
}

const fail = (c: Context, status: 400 | 404, error: ApiError) => c.json(error, status);

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function parseStatuses<S extends string>(
  value: string | undefined,
  known: readonly S[],
  is: (v: unknown) => v is S,
): Parsed<S[] | undefined> {
  if (value === undefined || value === "") return { ok: true, value: undefined };
  const values = value.split(",");
  const bad = values.filter((v) => !is(v));
  if (bad.length > 0) {
    return {
      ok: false,
      message: `知らない状態です：${bad.join("、")}（使える状態：${known.join("・")}）`,
    };
  }
  return { ok: true, value: values as S[] };
}

function parseLimit(value: string | undefined): Parsed<number> {
  if (value === undefined || value === "") return { ok: true, value: 100 };
  if (!/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > 500) {
    return { ok: false, message: "limit は 1〜500 の整数にしてください" };
  }
  return { ok: true, value: Number(value) };
}

export function registerHoldRoutes(api: Hono, deps: HoldRoutesDeps): void {
  api.get("/holds", (c) => {
    const statuses = parseStatuses<HoldStatus>(c.req.query("status"), HOLD_STATUSES, isHoldStatus);
    if (!statuses.ok) return fail(c, 400, { error: "invalid_input", message: statuses.message });
    const limit = parseLimit(c.req.query("limit"));
    if (!limit.ok) return fail(c, 400, { error: "invalid_input", message: limit.message });
    const body: ListHoldsResponse = {
      holds: listHolds(deps.db, {
        ...(statuses.value !== undefined && { statuses: statuses.value }),
        limit: limit.value,
      }).map(toHoldView),
    };
    return c.json(body);
  });

  api.get("/holds/:id", (c) => {
    const id = c.req.param("id");
    const hold = isId(id, "hold") ? getHold(deps.db, id) : undefined;
    if (hold === undefined) {
      return fail(c, 404, { error: "not_found", message: "その保留はありません" });
    }
    const body: GetHoldResponse = { hold: toHoldDetailView(hold, deps.paths) };
    return c.json(body);
  });

  api.get("/grants", (c) => {
    const statuses = parseStatuses<GrantStatus>(
      c.req.query("status"),
      GRANT_STATUSES,
      isGrantStatus,
    );
    if (!statuses.ok) return fail(c, 400, { error: "invalid_input", message: statuses.message });
    const limit = parseLimit(c.req.query("limit"));
    if (!limit.ok) return fail(c, 400, { error: "invalid_input", message: limit.message });
    const body: ListGrantsResponse = {
      grants: listGrants(deps.db, {
        ...(statuses.value !== undefined && { statuses: statuses.value }),
        limit: limit.value,
      }).map(toGrantView),
    };
    return c.json(body);
  });
}
