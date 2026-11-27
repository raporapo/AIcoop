import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CompanyConfig, newId, type ProxiedRequest, type ProxyDecision } from "@aicoop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAuditLog, verifyAuditLog } from "../db/audit.ts";
import { getHold } from "../db/holds.ts";
import type { StateDb } from "../db/open.ts";
import { grants } from "../db/schema.ts";
import { type AicoopPaths, aicoopPaths } from "../paths.ts";
import {
  type CompanyFiles,
  DEFAULT_GROUPS,
  DEFAULT_MEMBERS,
  DEFAULT_ROLES,
  loadTestCompany,
} from "../testing/company-config.ts";
import { type FakeClock, memoryDb, type TempDir, tempDir } from "../testing/state-db.ts";
import { createProxyHandler, MAX_HOLD_BODY_BYTES, readHoldFile } from "./decide.ts";

let tmp: TempDir;
let paths: AicoopPaths;
let db: StateDb;
let clock: FakeClock;

beforeEach(() => {
  tmp = tempDir();
  paths = aicoopPaths(join(tmp.path, ".aicoop"));
  ({ db, clock } = memoryDb());
});
afterEach(() => tmp.cleanup());

function request(over: Partial<ProxiedRequest> = {}): ProxiedRequest {
  return {
    method: "GET",
    protocol: "https",
    host: "api.github.com",
    port: 443,
    path: "/",
    headers: {},
    bodyBytes: null,
    readBody: async () => new Uint8Array(),
    ...over,
  };
}

function handlerFor(config: CompanyConfig, memberId: string) {
  return createProxyHandler({
    db,
    paths,
    config,
    runId: newId("run"),
    taskId: newId("task"),
    memberId,
    thread: "task-x",
  });
}

function bodyOf(decision: ProxyDecision): Record<string, unknown> {
  if (decision.action !== "respond") throw new Error("respond ではない");
  return JSON.parse(decision.body);
}

function decisions() {
  return listAuditLog(db)
    .filter((r) => r.kind === "proxy.decision")
    .map((r) => JSON.parse(r.data));
}

const push = (repo: string) =>
  request({
    method: "POST",
    host: "github.com",
    path: `/${repo}.git/git-receive-pack`,
    bodyBytes: 100,
  });

describe("P1 完了条件2：許可していないリポジトリへの push は 403 になる", () => {
  it("部署の上限の中でも、役職が許可していないリポジトリへの push は 403（X-Aicoop-Decision: deny）", async () => {
    const config = loadTestCompany(paths.home);
    const onRequest = handlerFor(config, "dev-implementer");

    const denied = await onRequest(push("myorg/other"));

    expect(denied).toMatchObject({
      action: "respond",
      status: 403,
      headers: { "X-Aicoop-Decision": "deny" },
    });
    expect(bodyOf(denied)).toEqual({
      aicoop: "deny",
      operation: "github.git.push",
      reason: "not_allowed",
    });
  });

  it("部署の上限の外の owner へも 403", async () => {
    const config = loadTestCompany(paths.home);
    const denied = await handlerFor(config, "dev-implementer")(push("otherorg/app"));
    expect(denied).toMatchObject({ status: 403 });
  });

  it("許可したリポジトリへの push だけが forward（仮の札はこのときだけ本物に置き換わる）", async () => {
    const config = loadTestCompany(paths.home);
    expect(await handlerFor(config, "dev-implementer")(push("myorg/app"))).toEqual({
      action: "forward",
    });
  });

  it("push を許可していない役職（reviewer）からは、同じリポジトリでも 403", async () => {
    const config = loadTestCompany(paths.home);
    expect(await handlerFor(config, "dev-reviewer")(push("myorg/app"))).toMatchObject({
      status: 403,
    });
  });
});

describe("5.2.4・5.10：判定と監査ログ proxy.decision", () => {
  it("判定ごとに、社員・操作・ホスト・パス（クエリを除く）・判定・理由・本文のバイト数を書く。本文は書かない", async () => {
    const config = loadTestCompany(paths.home);
    const onRequest = handlerFor(config, "dev-implementer");
    await onRequest(
      request({ path: "/repos/myorg/app/contents/README.md?ref=main&token=SECRET", bodyBytes: 0 }),
    );
    await onRequest(push("myorg/other"));

    expect(decisions()).toEqual([
      {
        member: "dev-implementer",
        operation: "github.repo.read",
        host: "api.github.com",
        path: "/repos/myorg/app/contents/README.md",
        decision: "allow",
        reason: null,
        body_bytes: 0,
      },
      {
        member: "dev-implementer",
        operation: "github.git.push",
        host: "github.com",
        path: "/myorg/other.git/git-receive-pack",
        decision: "deny",
        reason: "not_allowed",
        body_bytes: 100,
      },
    ]);
    const rows = listAuditLog(db).filter((r) => r.kind === "proxy.decision");
    expect(rows.every((r) => r.actor === "member:dev-implementer")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("SECRET");
    expect(verifyAuditLog(db).ok).toBe(true);
  });

  it("どの操作にも当たらない宛先は no_operation、操作はあるが許可にないものは not_allowed", async () => {
    const config = loadTestCompany(paths.home);
    const onRequest = handlerFor(config, "dev-implementer");
    expect(bodyOf(await onRequest(request({ path: "/user" })))).toEqual({
      aicoop: "deny",
      operation: null,
      reason: "no_operation",
    });
    expect(bodyOf(await onRequest(request({ host: "example.com", path: "/" })))).toEqual({
      aicoop: "deny",
      operation: "web.read",
      reason: "not_allowed",
    });
  });

  it("既定でないポートと、資格を使うサービスへの http は、どの操作にも当てない（no_operation）", async () => {
    const config = loadTestCompany(paths.home);
    const onRequest = handlerFor(config, "dev-implementer");
    const read = { path: "/repos/myorg/app" };
    expect(bodyOf(await onRequest(request({ ...read, port: 8443 })))).toMatchObject({
      reason: "no_operation",
    });
    expect(bodyOf(await onRequest(request({ ...read, protocol: "http", port: 80 })))).toMatchObject(
      { reason: "no_operation" },
    );
    // 資格を使わない web.read は http でもよい
    const sales = handlerFor(config, "sales-researcher");
    expect(await sales(request({ protocol: "http", port: 80, host: "example.com" }))).toEqual({
      action: "forward",
    });
    expect(
      bodyOf(await sales(request({ protocol: "http", port: 8080, host: "example.com" }))),
    ).toMatchObject({ reason: "no_operation" });
  });

  it("5.2.4 の受け入れ条件：一時権限（grants の active）は、部署の上限にある操作だけを足す", async () => {
    const withComment: CompanyFiles = {
      groups: {
        ...DEFAULT_GROUPS,
        dev: {
          ...(DEFAULT_GROUPS.dev as object),
          ceiling: [
            ...((DEFAULT_GROUPS.dev as { ceiling: unknown[] }).ceiling ?? []),
            { op: "github.issue.comment", params: { repo: ["myorg/*"] } },
          ],
        },
      },
    };
    const comment = request({ method: "POST", path: "/repos/myorg/app/issues/1/comments" });
    const grant = () =>
      db.orm
        .insert(grants)
        .values({
          id: newId("grant"),
          memberId: "dev-implementer",
          service: "github",
          operation: "issue.comment",
          params: JSON.stringify({ repo: ["myorg/app"] }),
          mode: "allow",
          reason: "r",
          durationHours: 24,
          status: "active",
          createdAt: "2026-11-27T00:00:00.000Z",
          startsAt: "2026-11-27T00:00:00.000Z",
          expiresAt: "2026-11-29T00:00:00.000Z",
          decidedBy: null,
        })
        .run();

    // 上限にない操作：一時権限があっても deny
    const narrow = loadTestCompany(paths.home);
    grant();
    expect(await handlerFor(narrow, "dev-implementer")(comment)).toMatchObject({ status: 403 });

    // 上限にある操作：一時権限で allow になる。期限が切れたら deny
    const wide = loadTestCompany(paths.home, withComment);
    const onRequest = handlerFor(wide, "dev-implementer");
    expect(await onRequest(comment)).toEqual({ action: "forward" });
    clock.set("2026-11-29T00:00:00.000Z");
    expect(await onRequest(comment)).toMatchObject({ status: 403 });
  });

  it("11.2：1回のルールの判定（監査ログの書き込みを含む）は5ミリ秒以内", async () => {
    const config = loadTestCompany(paths.home);
    const onRequest = handlerFor(config, "dev-implementer");
    for (let i = 0; i < 20; i++) await onRequest(push("myorg/app"));
    const n = 200;
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const started = performance.now();
      await onRequest(i % 2 === 0 ? push("myorg/app") : push("myorg/other"));
      times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(n / 2)] as number;
    const p95 = times[Math.floor(n * 0.95)] as number;
    expect(median).toBeLessThan(5);
    expect(p95).toBeLessThan(5);
  });
});

describe("5.2.5・5.2.6 の1：保留（hold）", () => {
  const salesFiles = (withManager: boolean): CompanyFiles => ({
    groups: {
      ...DEFAULT_GROUPS,
      sales: {
        name: "営業部",
        box: "vm",
        ceiling: [{ op: "gmail.draft.create" }, { op: "gmail.message.send", mode: "hold" }],
      },
      ...(withManager ? { executives: { name: "役員室", box: "vm", ceiling: [] } } : {}),
    },
    roles: {
      ...DEFAULT_ROLES,
      "mail-writer": {
        name: "メール作成担当",
        allow: [{ op: "gmail.draft.create" }, { op: "gmail.message.send" }],
      },
      ...(withManager ? { manager: { name: "部長", allow: [] } } : {}),
    },
    members: {
      ...DEFAULT_MEMBERS,
      "sales-mailer": { name: "メール作成AI", group: "sales", role: "mail-writer" },
      ...(withManager
        ? {
            "mgr-sales": {
              name: "営業部長AI",
              group: "executives",
              role: "manager",
              manages: "sales",
            },
          }
        : {}),
    },
  });

  const send = (body: Uint8Array, over: Partial<ProxiedRequest> = {}) =>
    request({
      method: "POST",
      host: "gmail.googleapis.com",
      path: "/gmail/v1/users/me/messages/send?alt=json",
      headers: {
        authorization: "Bearer GONDOLIN_SECRET_abc",
        cookie: "sid=1",
        "proxy-authorization": "Basic x",
        "content-type": "application/json",
        "x-custom": "keep",
      },
      bodyBytes: body.byteLength,
      readBody: async () => body,
      ...over,
    });

  it("428（X-Aicoop-Decision: hold）を返し、リクエスト（認証ヘッダー・cookie を除く）を state/holds/<hold_id>.bin に保存する", async () => {
    const config = loadTestCompany(paths.home, salesFiles(false));
    const body = new TextEncoder().encode('{"raw":"VG86IGFAZXhhbXBsZS5jb20="}');

    const decision = await handlerFor(config, "sales-mailer")(send(body));

    expect(decision).toMatchObject({ status: 428, headers: { "X-Aicoop-Decision": "hold" } });
    const holdId = bodyOf(decision).hold_id as string;
    expect(holdId).toMatch(/^h_/);
    const hold = getHold(db, holdId);
    expect(hold).toMatchObject({
      memberId: "sales-mailer",
      groupId: "sales",
      thread: "task-x",
      service: "gmail",
      operation: "message.send",
      status: "pending_owner",
      requestBytes: body.byteLength,
      requestPath: paths.holdFile(holdId),
      createdAt: "2026-11-28T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });

    const saved = readHoldFile(readFileSync(paths.holdFile(holdId)));
    expect(saved.method).toBe("POST");
    expect(saved.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send?alt=json");
    expect(saved.headers).toEqual({ "content-type": "application/json", "x-custom": "keep" });
    expect(new TextDecoder().decode(saved.body)).toBe('{"raw":"VG86IGFAZXhhbXBsZS5jb20="}');

    const audit = listAuditLog(db);
    expect(audit.filter((r) => r.kind === "hold.state").map((r) => JSON.parse(r.data))).toEqual([
      { from: null, to: "pending_owner", by: "system" },
    ]);
    expect(decisions().at(-1)).toMatchObject({ decision: "hold", operation: "gmail.message.send" });
  });

  it("5.7.1 の1：部署に部長がいれば pending_manager", async () => {
    const config = loadTestCompany(paths.home, salesFiles(true));
    const decision = await handlerFor(config, "sales-mailer")(send(new Uint8Array([1, 2])));
    expect(getHold(db, bodyOf(decision).hold_id as string)?.status).toBe("pending_manager");
  });

  it("本文が10 MiB を超えたら、保留にせず deny（too_large_to_hold）。ファイルも記録も作らない", async () => {
    const config = loadTestCompany(paths.home, salesFiles(false));
    const onRequest = handlerFor(config, "sales-mailer");
    let read = false;
    const tooLarge = await onRequest(
      send(new Uint8Array(), {
        bodyBytes: MAX_HOLD_BODY_BYTES + 1,
        readBody: async () => {
          read = true;
          return new Uint8Array();
        },
      }),
    );
    expect(tooLarge).toMatchObject({ status: 403 });
    expect(bodyOf(tooLarge)).toEqual({
      aicoop: "deny",
      operation: "gmail.message.send",
      reason: "too_large_to_hold",
    });
    expect(read).toBe(false);

    // 長さが分からない本文も、読んでから同じように確かめる
    const unknownLength = await onRequest(
      send(new Uint8Array(MAX_HOLD_BODY_BYTES + 1), { bodyBytes: null }),
    );
    expect(bodyOf(unknownLength)).toMatchObject({ reason: "too_large_to_hold" });

    expect(existsSync(paths.holdsDir) ? readdirSync(paths.holdsDir) : []).toEqual([]);
    expect(listAuditLog(db).filter((r) => r.kind === "hold.state")).toEqual([]);
    expect(decisions().map((d) => [d.decision, d.reason])).toEqual([
      ["deny", "too_large_to_hold"],
      ["deny", "too_large_to_hold"],
    ]);
  });
});
