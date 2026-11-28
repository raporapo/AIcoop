import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDaemon, startFakeDaemon } from "../testing/fake-daemon.ts";
import {
  GRANT_ID,
  grantView,
  HOLD_ID,
  holdDetail,
  holdView,
  statusResponse,
} from "../testing/fixtures.ts";
import { createTestCli, type TestCli } from "../testing/harness.ts";
import { displayWidth } from "../ui/text.ts";

let cli: TestCli;
let daemon: FakeDaemon;
beforeEach(async () => {
  cli = createTestCli();
  await cli.run(["init"]);
  daemon = await startFakeDaemon(cli.home);
});
afterEach(async () => {
  await daemon.close();
  cli.cleanup();
});

const MERGE_ID = "h_01JD6V8X3S0Q5W7KQ9M2T4R6YC";
const merge = holdView({
  id: MERGE_ID,
  member_id: "dev-implementer",
  group_id: "dev",
  operation: "github.pr.merge",
  status: "replayed",
  summary: {
    kind: "github_pr_merge",
    operation: "github.pr.merge",
    member_id: "dev-implementer",
    repo: "myorg/app",
    number: 42,
    title: "README の誤字を直す",
    changed_files: 1,
    head_sha: "a".repeat(40),
    head_ref: "fix-typo",
    base_ref: "main",
    merge_method: null,
    warnings: [],
    manager_comment: "差分は1行だけです",
  },
});

/** 承認アプリの URL（承認・却下はここでだけ。9.1・P-4） */
const appUrl = () => `http://localhost:${daemon.port}/app/`;

describe("aicoop holds：保留の一覧（GET /holds。新しい順）", () => {
  it("1件を2行で：ID・状態・操作・期限の表と、その下に社員と要約。時刻は timezone（Asia/Tokyo）", async () => {
    daemon.on("GET /holds", { body: { holds: [holdView(), merge] } });
    const r = await cli.run(["holds"]);
    expect(r.code, r.stderr).toBe(0);
    const lines = r.stdout.split("\n");
    const at = lines.findIndex((l) => l.startsWith(HOLD_ID));
    expect(lines[at]).toContain("承認待ち");
    expect(lines[at]).toContain("gmail.message.send");
    expect(lines[at + 1]).toMatch(
      /^ {4}sales-mailer：宛先 yamada@customer\.example・件名 新サービスのご案内/,
    );
    const m = lines.findIndex((l) => l.startsWith(MERGE_ID));
    expect(lines[m]).toContain("送信済み");
    expect(lines[m + 1]).toContain("dev-implementer：myorg/app #42「README の誤字を直す」");
    // 期限 2026-11-30T23:30Z は JST の 12-01 08:30
    expect(lines[at]).toContain("12-01 08:30");
    expect(r.stdout).not.toContain("\u001b[");
  });

  it("オーナーの承認待ちがあれば、承認アプリの URL で決めるよう案内する（承認・却下のコマンドはない）", async () => {
    daemon.on("GET /holds", { body: { holds: [holdView(), merge] } });
    const r = await cli.run(["holds"]);
    expect(r.stdout).toContain(`承認アプリ（${appUrl()}）で決めてください`);
    daemon.on("GET /holds", { body: { holds: [merge] } });
    expect((await cli.run(["holds"])).stdout).not.toContain("承認アプリ");
  });

  it("--status（, で区切って複数。日本語の呼び名も）と --limit を送る", async () => {
    daemon.on("GET /holds", { body: { holds: [] } });
    await cli.run(["holds", "--status", "pending_owner,replayed", "--limit", "5"]);
    expect(daemon.requests.at(-1)?.query.get("status")).toBe("pending_owner,replayed");
    expect(daemon.requests.at(-1)?.query.get("limit")).toBe("5");
    await cli.run(["holds", "--status", "オーナーの承認待ち"]);
    expect(daemon.requests.at(-1)?.query.get("status")).toBe("pending_owner");
  });

  it("知らない状態・範囲の外の --limit は、送る前に止める（終了コード 2）", async () => {
    const r = await cli.run(["holds", "--status", "pending_ownr"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("もしかして pending_owner");
    expect((await cli.run(["holds", "--status", "active"])).code).toBe(2);
    expect((await cli.run(["holds", "--limit", "0"])).code).toBe(2);
    expect((await cli.run(["holds", "--limit", "501"])).code).toBe(2);
    expect(daemon.requests).toHaveLength(0);
  });

  it("--json は応答をそのまま出す。1件もなければ、そう伝える", async () => {
    daemon.on("GET /holds", { body: { holds: [holdView()] } });
    const json = await cli.run(["holds", "--json"]);
    expect(JSON.parse(json.stdout).holds[0].id).toBe(HOLD_ID);
    daemon.on("GET /holds", { body: { holds: [] } });
    expect((await cli.run(["holds"])).stdout).toContain("保留はありません");
  });

  it("端末の幅に収める", async () => {
    daemon.on("GET /holds", { body: { holds: [holdView(), merge] } });
    const r = await cli.run(["holds"], { tty: true, columns: 80 });
    for (const line of r.stdout.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  it("CL-20：要約（外から来た文章・AI の書いた文章）の端末の制御符号・向きを変える文字は、そのまま出さない", async () => {
    const evil = holdView({
      summary: {
        ...(holdView().summary as Record<string, unknown>),
        subject: ["a\u001b]0;pwned\u0007\u001b[2Jb\u202e"],
        to: ["x\u001b[31m@example.com"],
      },
    });
    daemon.on("GET /holds", { body: { holds: [evil] } });
    const r = await cli.run(["holds"], { tty: true });
    expect(r.stdout).not.toContain("\u001b]0;");
    expect(r.stdout).not.toContain("\u001b[2J");
    expect(r.stdout).not.toContain("\u001b[31m@");
    expect(r.stdout).not.toContain("\u202e");
  });

  it("daemon が動いていなければ 3", async () => {
    await daemon.close();
    expect((await cli.run(["holds"])).code).toBe(3);
  });
});

describe("aicoop holds <hold_id>：保留の詳細（GET /holds/{id}）", () => {
  it("要約（宛先・件名・本文）・部長のコメント・状態・期限・元のリクエスト（メソッド・URL・ヘッダー・本文）を出す", async () => {
    daemon.on(`GET /holds/${HOLD_ID}`, { body: { hold: holdDetail() } });
    const r = await cli.run(["holds", HOLD_ID]);
    expect(r.code, r.stderr).toBe(0);
    for (const text of [
      HOLD_ID,
      "オーナーの承認待ち",
      "gmail.message.send",
      "sales-mailer",
      "prospect-1",
      "yamada@customer.example",
      "新サービスのご案内",
      "山田様",
      "新しいサービスのご案内です。",
      "宛先・中身に問題はありません",
      "2026-12-01 08:30",
      "POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      "content-type: application/json",
      '{"raw":"VG86IHlhbWFkYUBjdXN0b21lci5leGFtcGxl"}',
      `承認アプリ（${appUrl()}）で決めてください`,
    ]) {
      expect(r.stdout, text).toContain(text);
    }
  });

  it("元のリクエストの本文は、テキストなら先頭だけ。--full で全部を出す", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`);
    daemon.on(`GET /holds/${HOLD_ID}`, {
      body: {
        hold: holdDetail({
          request: { ...holdDetail().request, body_text: lines.join("\n"), body_bytes: 600 },
        }),
      },
    });
    const head = await cli.run(["holds", HOLD_ID]);
    expect(head.stdout).toContain("line-1\n");
    expect(head.stdout).not.toContain("line-60");
    expect(head.stdout).toContain("--full");
    const full = await cli.run(["holds", HOLD_ID, "--full"]);
    expect(full.stdout).toContain("line-60");
  });

  it("1行の長い本文も先頭だけ。テキストでない本文は、--full のときだけ base64 で出す", async () => {
    daemon.on(`GET /holds/${HOLD_ID}`, {
      body: {
        hold: holdDetail({
          request: { ...holdDetail().request, body_text: "x".repeat(5000), body_bytes: 5000 },
        }),
      },
    });
    const head = await cli.run(["holds", HOLD_ID]);
    expect(head.stdout).not.toContain("x".repeat(3000));
    expect((await cli.run(["holds", HOLD_ID, "--full"])).stdout).toContain("x".repeat(5000));

    daemon.on(`GET /holds/${HOLD_ID}`, {
      body: {
        hold: holdDetail({
          request: {
            ...holdDetail().request,
            body_text: null,
            body_base64: "AAEC/w==",
            body_bytes: 4,
          },
        }),
      },
    });
    const binary = await cli.run(["holds", HOLD_ID]);
    expect(binary.stdout).toContain("テキストではありません");
    expect(binary.stdout).not.toContain("AAEC/w==");
    expect((await cli.run(["holds", HOLD_ID, "--full"])).stdout).toContain("AAEC/w==");
  });

  it("再送したものは、結果（ステータス・本文の先頭）と、決めた者・時刻を出す。承認アプリの案内は出さない", async () => {
    daemon.on(`GET /holds/${MERGE_ID}`, {
      body: {
        hold: holdDetail({
          ...merge,
          service: "github",
          params: { repo: "myorg/app" },
          manager_comment: "差分は1行だけです",
          decided_at: "2026-11-28T00:00:00.000Z",
          decided_by: "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
          response_status: 200,
          response_text: '{"merged":true}',
          request: {
            ...holdDetail().request,
            url: "https://api.github.com/repos/myorg/app/pulls/42/merge",
            method: "PUT",
          },
        }),
      },
    });
    const r = await cli.run(["holds", MERGE_ID]);
    expect(r.code, r.stderr).toBe(0);
    for (const text of [
      "送信済み",
      "myorg/app",
      "#42",
      "README の誤字を直す",
      "fix-typo",
      "差分は1行だけです",
      "owner:d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
      "HTTP 200",
      '{"merged":true}',
    ]) {
      expect(r.stdout, text).toContain(text);
    }
    expect(r.stdout).not.toContain("承認アプリ");
  });

  it("保存したリクエストが残っていない（決まってから30日を過ぎて消した）ときは、そう伝える", async () => {
    daemon.on(`GET /holds/${HOLD_ID}`, {
      body: {
        hold: holdDetail({
          status: "rejected",
          request: {
            method: "",
            url: "",
            headers: {},
            body_bytes: 48,
            body_text: null,
            body_base64: null,
            truncated: false,
          },
        }),
      },
    });
    const r = await cli.run(["holds", HOLD_ID]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("保存したリクエストは残っていません");
  });

  it("CL-20：本文・ヘッダー・部長のコメント・再送の結果の制御符号は、そのまま出さない", async () => {
    daemon.on(`GET /holds/${HOLD_ID}`, {
      body: {
        hold: holdDetail({
          manager_comment: "ok\u001b]0;pwned\u0007",
          response_text: "r\u001b[2J",
          response_status: 200,
          request: {
            ...holdDetail().request,
            headers: { "x-evil": "v\u001b[31m" },
            body_text: "b\u001b[2Kc\u202e",
          },
        }),
      },
    });
    const r = await cli.run(["holds", HOLD_ID, "--full"], { tty: true });
    expect(r.stdout).not.toContain("\u001b]0;");
    expect(r.stdout).not.toContain("\u001b[2J");
    expect(r.stdout).not.toContain("\u001b[2K");
    expect(r.stdout).not.toContain("v\u001b[31m");
    expect(r.stdout).not.toContain("\u202e");
  });

  it("--json は応答をそのまま出す", async () => {
    daemon.on(`GET /holds/${HOLD_ID}`, { body: { hold: holdDetail() } });
    const r = await cli.run(["holds", HOLD_ID, "--json"]);
    expect(JSON.parse(r.stdout).hold.id).toBe(HOLD_ID);
  });

  it("保留の ID の形でなければ送らずに 2。ない保留は 1", async () => {
    for (const id of ["h_123", "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB", "../status"]) {
      expect((await cli.run(["holds", id])).code, id).toBe(2);
    }
    expect(daemon.requests).toHaveLength(0);
    const r = await cli.run(["holds", HOLD_ID]);
    expect(r.code).toBe(1);
  });
});

describe("aicoop grants：一時権限の一覧（GET /grants）", () => {
  it("ID・状態・操作・時間・期限と、その下に社員・範囲・理由・部長のコメントを出し、オーナーの承認待ちがあれば承認アプリを案内する", async () => {
    const active = grantView({
      id: "g_01JD6V8X3S0Q5W7KQ9M2T4R6YC",
      status: "active",
      starts_at: "2026-11-28T00:00:00.000Z",
      expires_at: "2026-11-29T00:00:00.000Z",
    });
    daemon.on("GET /grants", { body: { grants: [grantView(), active] } });
    const r = await cli.run(["grants"]);
    expect(r.code, r.stderr).toBe(0);
    for (const text of [
      GRANT_ID,
      "承認待ち",
      "有効",
      "仕事に要る範囲です",
      "dev-implementer",
      "github.git.push",
      "repo=myorg/new",
      "24時間",
      "11-29 09:00",
      "Issue #12 の実装を myorg/new に push するため",
      `承認アプリ（${appUrl()}）で決めてください`,
    ]) {
      expect(r.stdout, text).toContain(text);
    }
  });

  it("--status を送る。知らない状態は 2（保留の状態 replayed も一時権限にはない）", async () => {
    daemon.on("GET /grants", { body: { grants: [] } });
    await cli.run(["grants", "--status", "active"]);
    expect(daemon.requests.at(-1)?.query.get("status")).toBe("active");
    expect((await cli.run(["grants", "--status", "replayed"])).code).toBe(2);
    expect((await cli.run(["grants"])).stdout).toContain("一時権限はありません");
  });

  it("--json。理由（AI の書いた文章）の制御符号は、そのまま出さない", async () => {
    daemon.on("GET /grants", {
      body: { grants: [grantView({ reason: "push\u001b]0;pwned\u0007\u202e" })] },
    });
    expect(JSON.parse((await cli.run(["grants", "--json"])).stdout).grants).toHaveLength(1);
    const r = await cli.run(["grants"], { tty: true });
    expect(r.stdout).not.toContain("\u001b]0;");
    expect(r.stdout).not.toContain("\u202e");
  });
});

describe("9.1・P-4：承認・却下のコマンドはない", () => {
  it("aicoop holds approve <id>・grants reject <id> などは、承認アプリのパスキーで決めると案内して 2（何も送らない）", async () => {
    for (const args of [
      ["holds", "approve", HOLD_ID],
      ["holds", "reject", HOLD_ID],
      ["holds", "pass", HOLD_ID],
      ["grants", "approve", GRANT_ID],
      ["grants", "reject", GRANT_ID],
    ]) {
      const r = await cli.run(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toContain("承認アプリ");
      expect(r.stderr, args.join(" ")).toContain("パスキー");
    }
    expect(daemon.requests).toHaveLength(0);
  });
});

describe("9.1 aicoop status：オーナーの承認待ちの件数と、承認アプリの案内", () => {
  it("オーナーの承認待ち（保留・一時権限）の件数と、部長のレビュー中の件数を出し、承認アプリの URL を案内する", async () => {
    daemon.on("GET /status", { body: statusResponse({ holds: { pending: 3 } }) });
    daemon.on("GET /holds", (req) => ({
      body: {
        holds:
          req.query.get("status") === "pending_manager,pending_owner"
            ? [holdView(), holdView({ id: MERGE_ID, status: "pending_manager" })]
            : [],
      },
    }));
    daemon.on("GET /grants", (req) => ({
      body: {
        grants: req.query.get("status") === "pending_manager,pending_owner" ? [grantView()] : [],
      },
    }));
    const r = await cli.run(["status"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("オーナーの承認待ち 2件（保留 1・一時権限 1）");
    expect(r.stdout).toContain("部長のレビュー中 1件");
    expect(r.stdout).toContain(`承認アプリ（http://localhost:7070/app/）で決めてください`);
  });

  it("承認待ちがなければ案内しない。古い daemon（/holds がない）でも status は出せる", async () => {
    daemon.on("GET /status", { body: statusResponse() });
    daemon.on("GET /holds", { body: { holds: [] } });
    daemon.on("GET /grants", { body: { grants: [] } });
    const none = await cli.run(["status"]);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("承認待ち");
    expect(none.stdout).not.toContain("承認アプリ");

    const old = await startFakeDaemon(cli.home);
    try {
      old.on("GET /status", { body: statusResponse({ holds: { pending: 2 } }) });
      const r = await cli.run(["status"]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("承認待ち 2件");
    } finally {
      await old.close();
    }
  });
});
