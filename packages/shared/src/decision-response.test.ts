import { describe, expect, it } from "vitest";
import {
  AICOOP_DECISION_HEADER,
  denyResponse,
  denyResponseFor,
  HOLD_MESSAGE,
  holdResponse,
} from "./decision-response.ts";
import { newId } from "./ids.ts";
import { effectivePermissions, evaluateRequest } from "./permission.ts";
import { createServiceCatalog } from "./service.ts";
import { loadBuiltinServices } from "./testing/builtin-services.ts";

const HOLD_ID = "h_01JD6V8X3S0Q5W7KQ9M2T4R6YB";

// 5.2.5：拒否と保留の返し方
describe("5.2.5：拒否の応答", () => {
  it("403、X-Aicoop-Decision: deny、本文は表のとおりの JSON", () => {
    const r = denyResponse("github.git.push", "not_allowed");
    expect(r).toEqual({
      action: "respond",
      status: 403,
      headers: {
        "X-Aicoop-Decision": "deny",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: '{"aicoop":"deny","operation":"github.git.push","reason":"not_allowed"}',
    });
    expect(AICOOP_DECISION_HEADER).toBe("X-Aicoop-Decision");
  });

  it("操作が決まらないときは operation が null（JSON の null）", () => {
    const r = denyResponse(null, "no_operation");
    expect(r.body).toBe('{"aicoop":"deny","operation":null,"reason":"no_operation"}');
    expect(JSON.parse(r.body)).toEqual({ aicoop: "deny", operation: null, reason: "no_operation" });
  });

  it("5.2.6 の1：保留できない大きさの本文は too_large_to_hold で拒否する", () => {
    const r = denyResponse("gmail.message.send", "too_large_to_hold");
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({
      aicoop: "deny",
      operation: "gmail.message.send",
      reason: "too_large_to_hold",
    });
  });

  it("5.7.1 の2：保留の中身（下書き・PR）を確かめられないときは hold_failed で拒否する", () => {
    const r = denyResponse("gmail.message.send", "hold_failed");
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body)).toEqual({
      aicoop: "deny",
      operation: "gmail.message.send",
      reason: "hold_failed",
    });
  });

  it("ルールの判定（5.2.4）の deny から作れる", () => {
    const catalog = createServiceCatalog(loadBuiltinServices());
    const effective = effectivePermissions({
      allow: [{ op: "github.git.push", params: { repo: ["myorg/app"] } }],
      ceiling: [{ op: "github.git.push" }],
      now: new Date("2026-11-28T00:00:00.000Z"),
    });
    const notAllowed = evaluateRequest(catalog, effective, {
      method: "POST",
      host: "github.com",
      path: "/myorg/other.git/git-receive-pack",
    });
    const noOperation = evaluateRequest(catalog, effective, {
      method: "DELETE",
      host: "api.github.com",
      path: "/repos/myorg/app",
    });
    if (notAllowed.decision !== "deny" || noOperation.decision !== "deny") {
      throw new Error("deny になるはず");
    }
    expect(denyResponseFor(notAllowed).body).toBe(
      '{"aicoop":"deny","operation":"github.git.push","reason":"not_allowed"}',
    );
    expect(denyResponseFor(noOperation).body).toBe(
      '{"aicoop":"deny","operation":null,"reason":"no_operation"}',
    );
  });

  describe("形の違う値で応答を作らない（AI社員に誤った意味を伝えない）", () => {
    it.each([
      ["区切りのない操作", "github"],
      ["引用符を含む操作", 'github.git.push","reason":"x'],
      ["改行を含む操作", "github.git.push\n"],
      ["空の操作", ""],
    ])("%s", (_label, op) => {
      expect(() => denyResponse(op, "not_allowed")).toThrow(TypeError);
    });

    it("知らない理由", () => {
      expect(() => denyResponse(null, "because" as never)).toThrow(TypeError);
    });
  });
});

describe("5.2.5：保留の応答", () => {
  it("428、X-Aicoop-Decision: hold、本文は表のとおりの JSON と文言", () => {
    const r = holdResponse(HOLD_ID);
    expect(r).toEqual({
      action: "respond",
      status: 428,
      headers: {
        "X-Aicoop-Decision": "hold",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: `{"aicoop":"hold","hold_id":"${HOLD_ID}","message":"承認待ちです。結果は後で届きます。同じ操作を繰り返さないでください。"}`,
    });
    expect(HOLD_MESSAGE).toBe(
      "承認待ちです。結果は後で届きます。同じ操作を繰り返さないでください。",
    );
  });

  it("新しく作った保留 ID で作れる", () => {
    const id = newId("hold");
    expect(JSON.parse(holdResponse(id).body).hold_id).toBe(id);
  });

  it.each([
    ["一時権限の ID", "g_01JD6V8X3S0Q5W7KQ9M2T4R6YB"],
    ["壊れた ID", "h_123"],
    ["本文を壊す文字列", 'h_1","message":"送信しました'],
    ["空", ""],
  ])("保留の ID でないもの（%s）では作らない", (_label, id) => {
    expect(() => holdResponse(id)).toThrow(TypeError);
  });
});
