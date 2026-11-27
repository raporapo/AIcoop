import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { canonicalJson, newId } from "@aicoop/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAuditLog } from "../db/audit.ts";
import type { StateDb } from "../db/open.ts";
import { memoryDb, type TempDir, tempDir } from "../testing/state-db.ts";
import { type Gateway, openGateway, ReportRejectedError, type ReportResult } from "./server.ts";

let tmp: TempDir;
let db: StateDb;
let work: string;
let gateway: Gateway;
let reports: ReportResult[];
let reject: Error | null;
const taskId = newId("task");

beforeEach(async () => {
  tmp = tempDir();
  db = memoryDb().db;
  work = join(tmp.path, "work");
  mkdirSync(join(work, "reports"), { recursive: true });
  writeFileSync(join(work, "reports", "today.md"), "今日の報告");
  writeFileSync(join(work, "a.txt"), "a");
  reports = [];
  reject = null;
  gateway = await openGateway({
    db,
    memberId: "dev-implementer",
    taskId,
    workDir: work,
    onReport: (r) => {
      if (reject) throw reject;
      reports.push(r);
    },
  });
});

afterEach(async () => {
  await gateway.close();
  tmp.cleanup();
});

async function connect(): Promise<Client> {
  const client = new Client({ name: "fake-claude", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gateway.port}/mcp`)),
  );
  return client;
}

async function call(args: Record<string, unknown>, name = "report_result") {
  const client = await connect();
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

function errorOf(result: Awaited<ReturnType<typeof call>>): { error: string; message: string } {
  expect(result.isError).toBe(true);
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]?.text ?? "null");
}

/** Host ヘッダーを決めて生の HTTP を送る（fetch は Host を変えられない） */
function rawPost(host: string, path = "/mcp"): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "0" },
      },
    });
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: gateway.port,
        path,
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("5.3.1：道具ゲート（MCP、Streamable HTTP）", () => {
  it("127.0.0.1 の空いているポートで、パス /mcp で待ち受ける", async () => {
    expect(gateway.port).toBeGreaterThan(0);
    const client = await connect();
    await client.close();
  });

  it("5.3.1 の受け入れ条件：P1 の道具は report_result だけで、ほかの道具は一覧に出ない", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();
    expect(tools.map((t) => t.name)).toEqual(["report_result"]);
    expect(tools[0]?.inputSchema).toMatchObject({
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" }, files: { type: "array" } },
    });
  });

  it("一覧にない道具は呼べない（not_allowed）", async () => {
    expect(errorOf(await call({}, "request_access")).error).toBe("not_allowed");
    expect(reports).toEqual([]);
  });

  it("5.3.1 の2：Host が aicoop.internal（箱の中から）でも受け付ける。ほかの Host は 403", async () => {
    expect(await rawPost("aicoop.internal")).toBe(200);
    expect(await rawPost("aicoop.internal:80")).toBe(200);
    expect(await rawPost("evil.example.com")).toBe(403);
    expect(await rawPost(`localhost:${gateway.port}`)).toBe(403);
  });

  it("/mcp 以外のパスは 404", async () => {
    expect(await rawPost("aicoop.internal", "/other")).toBe(404);
  });

  it("閉じたら、もうつながらない（実行が終わったらポートを閉じる）", async () => {
    await gateway.close();
    await expect(connect()).rejects.toThrow();
  });
});

describe("5.3.3：report_result の入力の検証（9.3 の invalid_input）", () => {
  it("summary と files（/work/... と相対パス）を受け付け、作業フォルダからの相対パスにそろえて渡す", async () => {
    const result = await call({
      summary: "やりました",
      files: ["/work/reports/today.md", "a.txt", "./reports/today.md"],
    });
    expect(result.isError).toBeFalsy();
    expect(reports).toEqual([{ summary: "やりました", files: ["reports/today.md", "a.txt"] }]);
  });

  it("files は書かなくてもよい", async () => {
    await call({ summary: "報告だけ" });
    expect(reports).toEqual([{ summary: "報告だけ", files: [] }]);
  });

  it("summary がない・空・4000文字を超える・文字列でないなら invalid_input", async () => {
    for (const args of [{}, { summary: "  " }, { summary: "あ".repeat(4001) }, { summary: 1 }]) {
      expect(errorOf(await call(args)).error).toBe("invalid_input");
    }
    expect((await call({ summary: "あ".repeat(4000) })).isError).toBeFalsy();
  });

  it("files が51個以上・文字列の配列でないなら invalid_input", async () => {
    const many = Array.from({ length: 51 }, () => "a.txt");
    expect(errorOf(await call({ summary: "s", files: many })).error).toBe("invalid_input");
    expect(errorOf(await call({ summary: "s", files: "a.txt" })).error).toBe("invalid_input");
    expect(errorOf(await call({ summary: "s", files: [1] })).error).toBe("invalid_input");
  });

  it("作業フォルダの外に出るパス（..・ほかの絶対パス）・存在しないパスは invalid_input", async () => {
    for (const bad of [
      "../secret",
      "reports/../../x",
      "/etc/passwd",
      "/home/agent/.claude.json",
      "/work",
      "/work/../etc/passwd",
      "/workother/a.txt",
      "missing.md",
      "reports\\today.md",
      "",
    ]) {
      const error = errorOf(await call({ summary: "s", files: [bad] }));
      expect(error.error, bad).toBe("invalid_input");
    }
    expect(reports).toEqual([]);
  });

  it("抜け道：作業フォルダの中のリンク（とリンクを通ったパス）は受け付けない", async (ctx) => {
    try {
      symlinkSync(join(tmp.path, "outside.txt"), join(work, "link.txt"));
      symlinkSync(
        tmp.path,
        join(work, "dirlink"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") ctx.skip();
      throw e;
    }
    writeFileSync(join(tmp.path, "outside.txt"), "host");
    expect(errorOf(await call({ summary: "s", files: ["link.txt"] })).error).toBe("invalid_input");
    expect(errorOf(await call({ summary: "s", files: ["dirlink/outside.txt"] })).error).toBe(
      "invalid_input",
    );
  });

  it("知らない引数があれば invalid_input", async () => {
    expect(errorOf(await call({ summary: "s", status: "done" })).error).toBe("invalid_input");
  });

  it("2回呼ばれたら、あとのもので上書きする（どちらも受け付ける）", async () => {
    await call({ summary: "1回目" });
    await call({ summary: "2回目", files: ["a.txt"] });
    expect(reports.map((r) => r.summary)).toEqual(["1回目", "2回目"]);
  });

  it("タスクがもう動いていなければ（取り消しなど）、記録せずに not_allowed", async () => {
    reject = new ReportRejectedError("このタスクはもう動いていません");
    expect(errorOf(await call({ summary: "s" }))).toEqual({
      error: "not_allowed",
      message: "このタスクはもう動いていません",
    });
  });
});

describe("5.10：道具の呼び出しの監査ログ gateway.call", () => {
  it("社員・道具名・引数の正規化JSONの SHA-256・成否を書く（引数そのものは書かない）", async () => {
    const args = { summary: "秘密の要約", files: ["a.txt"] };
    await call(args);
    await call({ summary: "" });
    const rows = listAuditLog(db).filter((r) => r.kind === "gateway.call");
    const sha = (v: unknown) => createHash("sha256").update(canonicalJson(v)).digest("hex");
    expect(rows.map((r) => JSON.parse(r.data))).toEqual([
      { member: "dev-implementer", tool: "report_result", args_sha256: sha(args), ok: true },
      {
        member: "dev-implementer",
        tool: "report_result",
        args_sha256: sha({ summary: "" }),
        ok: false,
      },
    ]);
    expect(rows.every((r) => r.actor === "member:dev-implementer" && r.subject === taskId)).toBe(
      true,
    );
    expect(JSON.stringify(rows)).not.toContain("秘密の要約");
  });
});
