import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDaemon, startFakeDaemon } from "../testing/fake-daemon.ts";
import { createTestCli, FakeInput, type TestCli } from "../testing/harness.ts";

const A = {
  id: "d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
  name: "仕事のPC",
  kind: "pc",
  created_at: "2026-11-27T23:30:00.000Z",
  revoked_at: null,
};
const B = {
  id: "d_01JD6V8X3S0Q5W7KQ9M2T4R6YC",
  name: "古いPC",
  kind: "pc",
  created_at: "2026-11-20T00:00:00.000Z",
  revoked_at: "2026-11-25T00:00:00.000Z",
};

let cli: TestCli;
let daemon: FakeDaemon;
beforeEach(async () => {
  cli = createTestCli();
  await cli.run(["init"]);
  daemon = await startFakeDaemon(cli.home);
  daemon.on("GET /devices", { body: { devices: [B, A] } });
  daemon.on(`POST /devices/${A.id}/revoke`, {
    body: { device: { ...A, revoked_at: "2026-11-28T00:00:00.000Z" } },
  });
});
afterEach(async () => {
  await daemon.close();
  cli.cleanup();
});

const posts = () => daemon.requests.filter((r) => r.method === "POST").map((r) => r.path);

describe("9.1 aicoop devices：承認アプリの端末の一覧", () => {
  it("ID・名前・種類・登録・状態の表（時刻は timezone）。取り消したものも出す", async () => {
    const r = await cli.run(["devices"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(A.id);
    expect(r.stdout).toContain("仕事のPC");
    expect(r.stdout).toContain("有効");
    expect(r.stdout).toContain("古いPC");
    expect(r.stdout).toContain("取り消し");
    expect(r.stdout).toContain("11-28 08:30");
    expect(r.stdout).toContain("aicoop devices revoke");
  });

  it("--json はそのまま", async () => {
    const r = await cli.run(["devices", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ devices: [B, A] });
  });

  it("端末がなければ、登録のしかたを出す", async () => {
    daemon.on("GET /devices", { body: { devices: [] } });
    const r = await cli.run(["devices"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("aicoop pair --local");
  });

  it("名前の制御文字・色の符号は画面に出さない", async () => {
    daemon.on("GET /devices", { body: { devices: [{ ...A, name: "x\u001b[2Jy" }] } });
    const r = await cli.run(["devices"]);
    expect(r.stdout).not.toContain("\u001b");
  });
});

describe("9.1・T-12 aicoop devices revoke <id>：端末を取り消す", () => {
  it("端末から実行すると [y/N] で確かめ、y なら取り消す", async () => {
    const stdin = new FakeInput({ tty: true });
    const run = cli.start(["devices", "revoke", A.id], { stdin, tty: true });
    for (let i = 0; i < 400 && !run.stderr.text.includes("[y/N]"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(run.stderr.text).toContain("仕事のPC");
    expect(run.stderr.text).toContain("ログインも承認もできなくなります");
    stdin.type("y\n");
    const r = await run.done;
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("✓");
    expect(r.stdout).toContain("取り消しました");
    expect(posts()).toEqual([`/devices/${A.id}/revoke`]);
  });

  it("N なら取り消さない（終了コード 1）", async () => {
    const r = await cli.run(["devices", "revoke", A.id], {
      stdin: new FakeInput({ tty: true, data: "n\n" }),
      tty: true,
    });
    expect(r.code).toBe(1);
    expect(posts()).toEqual([]);
  });

  it("拒否：端末からでなければ --yes が要る（終了コード 2）。--yes なら確かめずに取り消す", async () => {
    const piped = await cli.run(["devices", "revoke", A.id], {
      stdin: new FakeInput({ data: "y\n" }),
    });
    expect(piped.code).toBe(2);
    expect(piped.stderr).toContain("--yes");
    expect(posts()).toEqual([]);
    const yes = await cli.run(["devices", "revoke", A.id, "--yes"]);
    expect(yes.code, yes.stderr).toBe(0);
    expect(posts()).toEqual([`/devices/${A.id}/revoke`]);
  });

  it("拒否：端末の ID の形でなければ、送る前に止める（終了コード 2）", async () => {
    for (const id of ["x", "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB", "d_01jd6v8x3s0q5w7kq9m2t4r6yb"]) {
      const r = await cli.run(["devices", "revoke", id, "--yes"]);
      expect(r.code, id).toBe(2);
      expect(r.stderr).toContain("d_");
    }
    expect(daemon.requests).toHaveLength(0);
  });

  it("拒否：ない端末・すでに取り消した端末（終了コード 1、取り消しを送らない）", async () => {
    const none = await cli.run(["devices", "revoke", "d_01JD6V8X3S0Q5W7KQ9M2T4R6YD", "--yes"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("aicoop devices");
    const done = await cli.run(["devices", "revoke", B.id, "--yes"]);
    expect(done.code).toBe(1);
    expect(done.stderr).toContain("すでに取り消されています");
    expect(posts()).toEqual([]);
  });
});

describe("11.7：端末のコマンドの「もしかして」と、承認のコマンドがないこと（9.1・P-4）", () => {
  it("devices の打ち間違い・別の言い方", async () => {
    expect((await cli.run(["devices", "rm", A.id])).stderr).toContain("aicoop devices revoke");
    expect((await cli.run(["devices", "revok", A.id])).stderr).toContain(
      "もしかして aicoop devices revoke",
    );
    expect((await cli.run(["device"])).stderr).toContain("aicoop devices");
    expect((await cli.run(["devcies"])).stderr).toContain("もしかして aicoop devices");
    for (const args of [
      ["devices", "rm", A.id],
      ["devices", "revok"],
    ]) {
      expect((await cli.run(args)).code, args.join(" ")).toBe(2);
    }
    expect(daemon.requests).toHaveLength(0);
  });

  it("承認・却下のコマンドはない。承認アプリのパスキーで行うと案内する", async () => {
    for (const word of ["approve", "reject"]) {
      const r = await cli.run([word, "h_01JD6V8X3S0Q5W7KQ9M2T4R6YB"]);
      expect(r.code, word).toBe(2);
      expect(r.stderr, word).toContain("承認アプリ");
      expect(r.stderr, word).toContain("パスキー");
    }
    expect(daemon.requests).toHaveLength(0);
  });
});
