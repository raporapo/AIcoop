import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDaemon, startFakeDaemon } from "../testing/fake-daemon.ts";
import { createTestCli, FakeInput, type TestCli } from "../testing/harness.ts";

const CODE = "ABCDE-FGHJK";
const DEVICE = {
  id: "d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
  name: "仕事のPC",
  kind: "pc",
  created_at: "2026-11-28T00:01:00.000Z",
  revoked_at: null,
};

let cli: TestCli;
let daemon: FakeDaemon;
beforeEach(async () => {
  cli = createTestCli();
  await cli.run(["init"]);
  daemon = await startFakeDaemon(cli.home);
  daemon.on("POST /pairing/local", {
    status: 201,
    body: {
      code: CODE,
      expires_at: "2026-11-28T00:10:00.000Z",
      url: `http://localhost:${daemon.port}/app/#/pair`,
    },
  });
  daemon.on(`POST /pairing/local/${CODE}/activate`, { body: { device: DEVICE } });
  daemon.on(`POST /pairing/local/${CODE}/cancel`, { body: { ok: true } });
});
afterEach(async () => {
  await daemon.close();
  cli.cleanup();
});

/** 何回目かの GET で返す状態を決める */
function statuses(...list: Array<Record<string, unknown>>) {
  let i = 0;
  daemon.on(`GET /pairing/local/${CODE}`, () => {
    const s = list[Math.min(i, list.length - 1)] as Record<string, unknown>;
    i++;
    return {
      body: {
        expires_at: "2026-11-28T00:10:00.000Z",
        device_name: null,
        confirm_code: null,
        cancel_reason: null,
        ...s,
      },
    };
  });
}

const registered = { status: "registered", device_name: "仕事のPC", confirm_code: "042195" };

async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`待っても来ません：${label}`);
}

const paths = () => daemon.requests.map((r) => `${r.method} ${r.path}`);

describe("9.1 aicoop pair --local：PC のブラウザを承認アプリの端末として登録する（5.8 の2）", () => {
  it("コードと URL を出し、登録を待ち、確認コードと端末の名前を出して y で有効にする", async () => {
    statuses({ status: "waiting" }, { status: "waiting" }, registered);
    const stdin = new FakeInput({ tty: true });
    const run = cli.start(["pair", "--local"], { stdin, tty: true });
    await until(() => run.stderr.text.includes("[y/N]"), "確かめの問い");
    const shown = run.stdout.text;
    expect(shown).toContain(`http://localhost:${daemon.port}/app/#/pair`);
    expect(shown).toContain(CODE);
    expect(shown).toContain("042195");
    expect(shown).toContain("仕事のPC");
    // y を押すまで有効にしない
    expect(paths()).not.toContain(`POST /pairing/local/${CODE}/activate`);
    stdin.type("y\n");
    const r = await run.done;
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("✓");
    expect(r.stdout).toContain(DEVICE.id);
    expect(paths()).toContain(`POST /pairing/local/${CODE}/activate`);
    expect(paths()).not.toContain(`POST /pairing/local/${CODE}/cancel`);
  });

  it("確認コードが違うなどで N（Enter だけも）を押すと、取り消して終了コード 1", async () => {
    for (const answer of ["n\n", "\n", "yes please\n"]) {
      daemon.requests.length = 0;
      statuses(registered);
      const stdin = new FakeInput({ tty: true });
      const run = cli.start(["pair", "--local"], { stdin, tty: true });
      await until(() => run.stderr.text.includes("[y/N]"), "確かめの問い");
      stdin.type(answer);
      const r = await run.done;
      expect(r.code, JSON.stringify(answer)).toBe(1);
      expect(r.stderr).toContain("取りやめました");
      expect(paths()).toContain(`POST /pairing/local/${CODE}/cancel`);
      expect(paths()).not.toContain(`POST /pairing/local/${CODE}/activate`);
    }
  });

  it("登録を待つあいだに Ctrl+C を押すと、コードを取り消して終了コード 130", async () => {
    statuses({ status: "waiting" });
    const run = cli.start(["pair", "--local"], { stdin: new FakeInput({ tty: true }), tty: true });
    await until(() => paths().includes(`GET /pairing/local/${CODE}`), "待ち");
    cli.interrupts.fire();
    const r = await run.done;
    expect(r.code).toBe(130);
    expect(paths()).toContain(`POST /pairing/local/${CODE}/cancel`);
  });

  it("y/N を聞いているときに Ctrl+C を押しても、取り消して 130", async () => {
    statuses(registered);
    const run = cli.start(["pair", "--local"], { stdin: new FakeInput({ tty: true }), tty: true });
    await until(() => run.stderr.text.includes("[y/N]"), "確かめの問い");
    cli.interrupts.fire();
    const r = await run.done;
    expect(r.code).toBe(130);
    expect(paths()).toContain(`POST /pairing/local/${CODE}/cancel`);
    expect(paths()).not.toContain(`POST /pairing/local/${CODE}/activate`);
  });

  it("期限切れ・ほかの pair --local・違うコードが何度も来た、で終わったら、理由を出して 1", async () => {
    for (const [state, text] of [
      [{ status: "expired" }, "期限"],
      [{ status: "cancelled", cancel_reason: "superseded" }, "aicoop pair --local が始まった"],
      [{ status: "cancelled", cancel_reason: "too_many_attempts" }, "違うコード"],
    ] as const) {
      statuses(state);
      const r = await cli.run(["pair", "--local"], {
        stdin: new FakeInput({ tty: true }),
        tty: true,
      });
      expect(r.code, text).toBe(1);
      expect(r.stderr, text).toContain(text);
    }
  });

  it("y を押したあとに期限が切れていたら、有効にならなかったことを出して 1", async () => {
    statuses(registered);
    daemon.on(`POST /pairing/local/${CODE}/activate`, {
      status: 404,
      body: { error: "pairing_invalid", message: "ペアリングのコードが違うか、期限が切れています" },
    });
    const stdin = new FakeInput({ tty: true });
    const run = cli.start(["pair", "--local"], { stdin, tty: true });
    await until(() => run.stderr.text.includes("[y/N]"), "確かめの問い");
    stdin.type("y\n");
    const r = await run.done;
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("登録していません");
  });

  it("端末の名前に入った制御文字・色の符号は、そのまま画面に出さない", async () => {
    statuses({ ...registered, device_name: "悪い\u001b[31m名前\u0007" });
    const stdin = new FakeInput({ tty: true });
    const run = cli.start(["pair", "--local"], { stdin, tty: false });
    await until(() => run.stderr.text.includes("[y/N]"), "確かめの問い");
    stdin.type("n\n");
    const r = await run.done;
    expect(r.stdout).not.toContain("\u001b");
    expect(r.stdout).not.toContain("\u0007");
  });

  it("拒否：--local なしは、スマホの登録が P3 からだと案内する（終了コード 2、daemon に何も送らない）", async () => {
    const r = await cli.run(["pair"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("P3（中継）");
    expect(r.stderr).toContain("aicoop pair --local");
    expect(daemon.requests).toHaveLength(0);
  });

  it("拒否：端末からでなければ始めない（確認コードを見比べて y を押す必要がある）", async () => {
    const r = await cli.run(["pair", "--local"], { stdin: new FakeInput({ data: "y\n" }) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("端末から");
    expect(daemon.requests).toHaveLength(0);
  });

  it("daemon が動いていなければ 3", async () => {
    await daemon.close();
    const r = await cli.run(["pair", "--local"], {
      stdin: new FakeInput({ tty: true }),
      tty: true,
    });
    expect(r.code).toBe(3);
  });
});
