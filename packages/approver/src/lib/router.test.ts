import { describe, expect, test } from "vitest";
import { hrefOf, parseRoute } from "./router.ts";

const H = "h_01JQ0000000000000000000001";
const G = "g_01JQ0000000000000000000002";
const T = "t_01JQ0000000000000000000003";

describe("ハッシュのルーター（サーバーのルートに依存しない。`#/pending` など）", () => {
  test("何もなければ承認待ちの一覧", () => {
    expect(parseRoute("")).toEqual({ name: "pending" });
    expect(parseRoute("#")).toEqual({ name: "pending" });
    expect(parseRoute("#/")).toEqual({ name: "pending" });
    expect(parseRoute("#/pending")).toEqual({ name: "pending" });
  });

  test("画面ごとの道", () => {
    expect(parseRoute(`#/pending/hold/${H}`)).toEqual({ name: "hold", id: H });
    expect(parseRoute(`#/pending/grant/${G}`)).toEqual({ name: "grant", id: G });
    expect(parseRoute("#/status")).toEqual({ name: "status" });
    expect(parseRoute(`#/tasks/${T}`)).toEqual({ name: "task", id: T });
    expect(parseRoute("#/tasks/new")).toEqual({ name: "new-task" });
    expect(parseRoute("#/usage")).toEqual({ name: "usage" });
    expect(parseRoute("#/audit")).toEqual({ name: "audit" });
    expect(parseRoute("#/devices")).toEqual({ name: "devices" });
    expect(parseRoute("#/host-tools")).toEqual({ name: "host-tools" });
    expect(parseRoute("#/ceo")).toEqual({ name: "ceo" });
    // 5.8 の4 (10)(11)・5.14 の4・5
    expect(parseRoute("#/settings")).toEqual({ name: "settings" });
    expect(parseRoute("#/secrets")).toEqual({ name: "secrets" });
    expect(parseRoute("#/settings/groups.yaml")).toMatchObject({ name: "not-found" });
    expect(parseRoute("#/pair")).toEqual({ name: "pair", code: null });
    expect(parseRoute("#/pair?code=AB12-CD34")).toEqual({ name: "pair", code: "AB12-CD34" });
  });

  test("ID の形でないもの・種類の違う ID は、見つからない画面（API に渡さない）", () => {
    expect(parseRoute("#/pending/hold/..%2F..%2Fstatus")).toMatchObject({ name: "not-found" });
    expect(parseRoute(`#/pending/hold/${G}`)).toMatchObject({ name: "not-found" });
    expect(parseRoute(`#/pending/hold/${H.toLowerCase()}`)).toMatchObject({ name: "not-found" });
    expect(parseRoute(`#/tasks/${T}/extra`)).toMatchObject({ name: "not-found" });
    expect(parseRoute("#/nothing")).toMatchObject({ name: "not-found" });
  });

  test("道を作る", () => {
    expect(hrefOf({ name: "hold", id: H })).toBe(`#/pending/hold/${H}`);
    expect(hrefOf({ name: "grant", id: G })).toBe(`#/pending/grant/${G}`);
    expect(hrefOf({ name: "task", id: T })).toBe(`#/tasks/${T}`);
    expect(hrefOf({ name: "pending" })).toBe("#/pending");
    expect(hrefOf({ name: "pair", code: null })).toBe("#/pair");
  });
});
