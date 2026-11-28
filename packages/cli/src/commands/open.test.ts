import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonInfo, StartRun } from "@aicoop/daemon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakeDaemon, startFakeDaemon } from "../testing/fake-daemon.ts";
import { statusResponse } from "../testing/fixtures.ts";
import { createTestCli, FakeInput, type TestCli, type TestCliOptions } from "../testing/harness.ts";
import type { DaemonEntry } from "./daemon-entry.ts";

const CODE = "ABCDE-FGHJK";
const DEVICE = {
  id: "d_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
  name: "仕事のPC",
  kind: "pc",
  created_at: "2026-11-28T00:01:00.000Z",
  revoked_at: null,
};
const REVOKED = {
  ...DEVICE,
  id: "d_01JD6V8X3S0Q5W7KQ9M2T4R6YC",
  revoked_at: "2026-11-28T00:02:00Z",
};
/** 表示の向きを変える文字（ソースに直接書かない） */
const RLO = String.fromCodePoint(0x202e);
const registered = { status: "registered", device_name: "仕事のPC", confirm_code: "042195" };

const entry: DaemonEntry = {
  startRun: (() => {
    throw new Error("呼ばれない");
  }) as unknown as StartRun,
  startDaemon: async (opts) => {
    const info: DaemonInfo = { pid: 1, port: 1, started_at: "", home: opts.home, version: "" };
    return {
      port: 1,
      info,
      token: "t",
      stopped: new Promise(() => undefined),
      stop: async () => undefined,
    };
  },
};

/** 偽の daemon に、open が使う道を足す */
function routes(d: FakeDaemon, devices: readonly unknown[], states: Record<string, unknown>[]) {
  d.on("GET /status", { body: statusResponse() });
  d.on("GET /devices", { body: { devices } });
  d.on("POST /pairing/local", {
    status: 201,
    body: {
      code: CODE,
      expires_at: "2026-11-28T00:10:00.000Z",
      url: `http://localhost:${d.port}/app/#/pair`,
    },
  });
  d.on(`POST /pairing/local/${CODE}/activate`, { body: { device: DEVICE } });
  d.on(`POST /pairing/local/${CODE}/cancel`, { body: { ok: true } });
  let i = 0;
  d.on(`GET /pairing/local/${CODE}`, () => {
    const s = states[Math.min(i, states.length - 1)] ?? { status: "waiting" };
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

async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`待っても来ません：${label}`);
}

/** ランチャーの出力：1行1つの JSON。読めない行があれば落とす */
function events(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("5.14 の2 aicoop open：制御サーバーが動いていて、端末がある・ない", () => {
  let cli: TestCli;
  let daemon: FakeDaemon;
  let launched: string[][];
  const paths = () => daemon.requests.map((r) => `${r.method} ${r.path}`);

  async function setup(options: TestCliOptions = {}) {
    launched = [];
    cli = createTestCli({
      ...options,
      deps: {
        launchDetached: async (argv) => {
          launched.push([...argv]);
          return true;
        },
        which: (c) => `/usr/bin/${c}`,
        ...options.deps,
      },
    });
    await cli.run(["init"]);
    daemon = await startFakeDaemon(cli.home);
  }
  afterEach(async () => {
    await daemon.close();
    cli.cleanup();
  });

  it("5.14 の2の5：有効な端末があれば /app/ を出してブラウザで開き、登録は始めない", async () => {
    await setup();
    routes(daemon, [DEVICE], []);
    const r = await cli.run(["open"]);
    expect(r.code, r.stderr).toBe(0);
    const url = `http://localhost:${daemon.port}/app/`;
    expect(r.stdout).toContain(url);
    expect(launched).toEqual([["xdg-open", url]]);
    expect(paths()).toContain("GET /devices");
    expect(paths()).not.toContain("POST /pairing/local");
  });

  it("5.14 の2の3：取り消した端末しかなければ、登録を始めて /app/#/pair?code=<コード> を開く", async () => {
    await setup();
    routes(daemon, [REVOKED], [registered]);
    const stdin = new FakeInput({ tty: true });
    const run = cli.start(["open"], { stdin, tty: true });
    await until(() => run.stderr.text.includes("[y/N]"), "確かめの問い");
    const url = `http://localhost:${daemon.port}/app/#/pair?code=${CODE}`;
    expect(run.stdout.text).toContain(url);
    expect(launched).toEqual([["xdg-open", url]]);
    stdin.type("n\n");
    await run.done;
  });

  it("5.14 の2の4：確認コードと端末の名前を出し、y を押したときだけ有効にする", async () => {
    await setup();
    routes(daemon, [], [{ status: "waiting" }, registered]);
    const stdin = new FakeInput({ tty: true });
    const run = cli.start(["open"], { stdin, tty: true });
    await until(() => run.stderr.text.includes("[y/N]"), "確かめの問い");
    expect(run.stdout.text).toContain("042195");
    expect(run.stdout.text).toContain("仕事のPC");
    expect(paths()).not.toContain(`POST /pairing/local/${CODE}/activate`);
    stdin.type("y\n");
    const r = await run.done;
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(DEVICE.id);
    expect(paths()).toContain(`POST /pairing/local/${CODE}/activate`);
  });

  it("5.14 の2の4：「いいえ」（n・Enter だけ・ほかの言葉）なら有効にせず、取り消して 1", async () => {
    await setup();
    for (const answer of ["n\n", "\n", "yes please\n"]) {
      daemon.requests.length = 0;
      routes(daemon, [], [registered]);
      const stdin = new FakeInput({ tty: true });
      const run = cli.start(["open"], { stdin, tty: true });
      await until(() => run.stderr.text.includes("[y/N]"), "確かめの問い");
      stdin.type(answer);
      const r = await run.done;
      expect(r.code, JSON.stringify(answer)).toBe(1);
      expect(paths()).toContain(`POST /pairing/local/${CODE}/cancel`);
      expect(paths()).not.toContain(`POST /pairing/local/${CODE}/activate`);
    }
  });

  it("5.14 の2の4：Ctrl+C（待つあいだ・y/N のあいだ）なら有効にせず、取り消して 130", async () => {
    await setup();
    routes(daemon, [], [{ status: "waiting" }]);
    let run = cli.start(["open"], { stdin: new FakeInput({ tty: true }), tty: true });
    await until(() => paths().includes(`GET /pairing/local/${CODE}`), "待ち");
    cli.interrupts.fire();
    expect((await run.done).code).toBe(130);
    expect(paths()).toContain(`POST /pairing/local/${CODE}/cancel`);

    daemon.requests.length = 0;
    routes(daemon, [], [registered]);
    run = cli.start(["open"], { stdin: new FakeInput({ tty: true }), tty: true });
    await until(() => run.stderr.text.includes("[y/N]"), "確かめの問い");
    cli.interrupts.fire();
    expect((await run.done).code).toBe(130);
    expect(paths()).toContain(`POST /pairing/local/${CODE}/cancel`);
    expect(paths()).not.toContain(`POST /pairing/local/${CODE}/activate`);
  });

  it("5.14 の2の4：期限切れなら、理由を出して 1（有効にしない）", async () => {
    await setup();
    routes(daemon, [], [{ status: "expired" }]);
    const r = await cli.run(["open"], { stdin: new FakeInput({ tty: true }), tty: true });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("期限");
    expect(r.stderr).toContain("aicoop open");
    expect(paths()).not.toContain(`POST /pairing/local/${CODE}/activate`);
  });

  it("拒否：端末がなく、端末（TTY）からでも --launcher でもなければ、登録を始めずに 2", async () => {
    await setup();
    routes(daemon, [], [registered]);
    const r = await cli.run(["open"], { stdin: new FakeInput({ data: "y\n" }) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--launcher");
    expect(paths()).not.toContain("POST /pairing/local");
  });

  it("5.14 の1：macOS は open、WSL は wslview で開く。WSL で wslview がなければ URL を出すだけ（失敗にしない）", async () => {
    for (const [options, expected] of [
      [{ platform: "darwin" }, ["open"]],
      [{ deps: { isWsl: () => true } }, ["wslview"]],
      [
        {
          deps: { isWsl: () => true, which: (c: string) => (c === "wslview" ? null : `/bin/${c}`) },
        },
        null,
      ],
      [{ deps: { which: () => null } }, null],
    ] as const) {
      await setup(options as TestCliOptions);
      routes(daemon, [DEVICE], []);
      const r = await cli.run(["open"]);
      const url = `http://localhost:${daemon.port}/app/`;
      expect(r.code, JSON.stringify(options)).toBe(0);
      expect(r.stdout).toContain(url);
      expect(launched).toEqual(expected === null ? [] : [[...expected, url]]);
      await daemon.close();
      cli.cleanup();
    }
    await setup();
  });

  it("5.14 の1：ブラウザを開けなくても失敗にしない（URL は出す）", async () => {
    await setup({ deps: { launchDetached: async () => false } });
    routes(daemon, [DEVICE], []);
    const r = await cli.run(["open"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`http://localhost:${daemon.port}/app/`);
  });
});

describe("5.14 の2 aicoop open --launcher：Windows のランチャー向けの、1行1つの JSON", () => {
  let cli: TestCli;
  let daemon: FakeDaemon;
  let launched: string[][];
  const paths = () => daemon.requests.map((r) => `${r.method} ${r.path}`);
  beforeEach(async () => {
    launched = [];
    cli = createTestCli({
      deps: {
        launchDetached: async (argv) => {
          launched.push([...argv]);
          return true;
        },
        which: (c) => `/usr/bin/${c}`,
      },
    });
    await cli.run(["init"]);
    daemon = await startFakeDaemon(cli.home);
  });
  afterEach(async () => {
    await daemon.close();
    cli.cleanup();
  });

  async function confirmAndAnswer(answer: string | null) {
    routes(daemon, [], [{ status: "waiting" }, registered]);
    const stdin = new FakeInput({ open: true });
    const run = cli.start(["open", "--launcher"], { stdin });
    await until(() => run.stdout.text.includes('"confirm"'), "confirm");
    expect(paths()).not.toContain(`POST /pairing/local/${CODE}/activate`);
    if (answer !== null) stdin.type(answer);
    // 改行で終わらない答えは、そのまま入力を閉じる（ランチャーが落ちた）
    if (answer === null || !answer.endsWith("\n")) stdin.end();
    const r = await run.done;
    return { r, ev: events(r.stdout) };
  }

  it("端末があれば open（/app/）と done だけ。ブラウザはランチャーが開く（ここでは開かない）", async () => {
    routes(daemon, [DEVICE], []);
    const r = await cli.run(["open", "--launcher"]);
    expect(r.code, r.stderr).toBe(0);
    const url = `http://localhost:${daemon.port}/app/`;
    const ev = events(r.stdout).filter((e) => e.event !== "progress");
    expect(ev).toEqual([
      { v: 1, event: "open", url },
      { v: 1, event: "done", url, device: null },
    ]);
    expect(launched).toEqual([]);
  });

  it("5.14 の2の3・4：open（コードつきの URL）→ confirm（確認コード・端末の名前）→ yes で有効にして done", async () => {
    const { r, ev } = await confirmAndAnswer("yes\n");
    expect(r.code, r.stderr).toBe(0);
    const app = `http://localhost:${daemon.port}/app/`;
    expect(ev.filter((e) => e.event !== "progress")).toEqual([
      { v: 1, event: "open", url: `${app}#/pair?code=${CODE}` },
      { v: 1, event: "confirm", code: "042195", device_name: "仕事のPC" },
      { v: 1, event: "done", url: app, device: { id: DEVICE.id, name: DEVICE.name } },
    ]);
    expect(paths()).toContain(`POST /pairing/local/${CODE}/activate`);
  });

  it("5.14 の受け入れ条件1：ランチャーの確かめの窓で「いいえ」（no）なら、端末は有効にならない", async () => {
    const { r, ev } = await confirmAndAnswer("no\n");
    expect(r.code).toBe(1);
    expect(ev.at(-1)).toMatchObject({ event: "cancelled" });
    expect(paths()).toContain(`POST /pairing/local/${CODE}/cancel`);
    expect(paths()).not.toContain(`POST /pairing/local/${CODE}/activate`);
  });

  it("拒否：yes 以外の答え（YES please・y・空行・改行のない yes で終わり・入力の終わり）では有効にしない", async () => {
    for (const answer of ["YES please\n", "y\n", "\n", "はい\n", "yes", null]) {
      daemon.requests.length = 0;
      const { r, ev } = await confirmAndAnswer(answer);
      expect(r.code, JSON.stringify(answer)).not.toBe(0);
      expect(ev.at(-1)?.event, JSON.stringify(answer)).toBe("cancelled");
      expect(paths(), JSON.stringify(answer)).not.toContain(`POST /pairing/local/${CODE}/activate`);
      expect(paths()).toContain(`POST /pairing/local/${CODE}/cancel`);
    }
  });

  it("中断（ランチャーを閉じた・SIGTERM）なら取り消して 130", async () => {
    routes(daemon, [], [{ status: "waiting" }]);
    const run = cli.start(["open", "--launcher"], { stdin: new FakeInput({ open: true }) });
    await until(() => paths().includes(`GET /pairing/local/${CODE}`), "待ち");
    cli.interrupts.fire();
    const r = await run.done;
    expect(r.code).toBe(130);
    expect(events(r.stdout).at(-1)).toMatchObject({ event: "cancelled" });
    expect(paths()).toContain(`POST /pairing/local/${CODE}/cancel`);
  });

  it("期限切れ・失敗は error（message と hints）。標準出力は JSON の行だけ", async () => {
    routes(daemon, [], [{ status: "expired" }]);
    const r = await cli.run(["open", "--launcher"], { stdin: new FakeInput({ open: true }) });
    expect(r.code).toBe(1);
    const last = events(r.stdout).at(-1) as Record<string, unknown>;
    expect(last.event).toBe("error");
    expect(String(last.message)).toContain("期限");
    expect(Array.isArray(last.hints)).toBe(true);
    expect(paths()).not.toContain(`POST /pairing/local/${CODE}/activate`);
  });

  it("端末の名前の制御文字・向きを変える文字は、confirm に入れない", async () => {
    routes(daemon, [], [{ ...registered, device_name: `悪い\u001b[31m名前${RLO}\u0007` }]);
    const stdin = new FakeInput({ open: true });
    const run = cli.start(["open", "--launcher"], { stdin });
    await until(() => run.stdout.text.includes('"confirm"'), "confirm");
    stdin.type("no\n");
    const r = await run.done;
    const confirm = events(r.stdout).find((e) => e.event === "confirm");
    for (const bad of ["\u001b", "\u0007", RLO]) {
      expect(String(confirm?.device_name)).not.toContain(bad);
    }
  });

  it("拒否：確認コードが6桁の数字でなければ、聞かずに取り消す", async () => {
    routes(daemon, [], [{ ...registered, confirm_code: "12345\n" }]);
    const r = await cli.run(["open", "--launcher"], { stdin: new FakeInput({ open: true }) });
    expect(r.code).toBe(1);
    expect(events(r.stdout).some((e) => e.event === "confirm")).toBe(false);
    expect(paths()).not.toContain(`POST /pairing/local/${CODE}/activate`);
    expect(paths()).toContain(`POST /pairing/local/${CODE}/cancel`);
  });
});

describe("5.14 の2の1・2 aicoop open：設定がない・制御サーバーが動いていない", () => {
  let cli: TestCli;
  let spawned: FakeDaemon | undefined;
  let spawnCalls: number;
  beforeEach(() => {
    spawnCalls = 0;
    spawned = undefined;
    cli = createTestCli({
      deps: {
        loadDaemonEntry: async () => entry,
        spawnDaemon: (home) => {
          spawnCalls++;
          void startFakeDaemon(home, { pid: 9999 }).then((d) => {
            routes(d, [DEVICE], []);
            spawned = d;
          });
          return { pid: 9999, exited: new Promise(() => undefined) };
        },
      },
    });
  });
  afterEach(async () => {
    await spawned?.close();
    cli.cleanup();
  });

  it("5.14 の2の1・2：設定がなければ「わたしの会社」の雛形を作り、制御サーバーを起動してから開く", async () => {
    const r = await cli.run(["open"]);
    expect(r.code, r.stderr).toBe(0);
    const yaml = readFileSync(join(cli.home, "aicoop.yaml"), "utf8");
    expect(yaml).toContain("わたしの会社");
    expect(existsSync(join(cli.home, "groups.yaml"))).toBe(true);
    expect(spawnCalls).toBe(1);
    expect(r.stdout).toContain(`http://localhost:${spawned?.port}/app/`);
  });

  it("5.14 の2の1：設定があれば作り直さない（会社の名前・ID はそのまま）", async () => {
    await cli.run(["init", "--name", "サンプル商会"]);
    const before = readFileSync(join(cli.home, "aicoop.yaml"), "utf8");
    const r = await cli.run(["open"]);
    expect(r.code, r.stderr).toBe(0);
    expect(readFileSync(join(cli.home, "aicoop.yaml"), "utf8")).toBe(before);
  });

  it("拒否：aicoop.yaml がないのに、ほかの設定や state.db があれば、雛形を作らずに止める", async () => {
    for (const file of ["groups.yaml", "state.db", "secrets.json"]) {
      const other = createTestCli();
      try {
        mkdirSync(other.home, { recursive: true });
        writeFileSync(join(other.home, file), "x");
        const r = await other.run(["open", "--launcher"]);
        expect(r.code, file).toBe(1);
        expect(existsSync(join(other.home, "aicoop.yaml")), file).toBe(false);
        expect(events(r.stdout).at(-1)?.event).toBe("error");
      } finally {
        other.cleanup();
      }
    }
  });

  it("5.14 の2の2：設定にエラーがあれば起動せず、--launcher では error にまとめる", async () => {
    await cli.run(["init"]);
    const path = join(cli.home, "aicoop.yaml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("max_concurrent_boxes: 3", "max_concurrent_boxes: 99"),
    );
    const r = await cli.run(["open", "--launcher"]);
    expect(r.code).toBe(1);
    expect(spawnCalls).toBe(0);
    const last = events(r.stdout).at(-1) as { event: string; hints: string[] };
    expect(last.event).toBe("error");
    expect(last.hints.join("\n")).toContain("daemon.max_concurrent_boxes");
    // 色の符号は入れない
    expect(r.stdout).not.toContain("\u001b");
  });
});
