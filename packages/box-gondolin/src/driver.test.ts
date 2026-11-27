import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxSpec, ExecLine, ProxyDecision } from "@aicoop/shared";
import { ReadonlyProvider, RealFSProvider } from "@earendil-works/gondolin";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGondolinDriver } from "./driver.ts";
import { FakeVm } from "./testing/fake-vm.ts";

const REAL = "ghs_REAL_TOKEN_must_never_be_seen_0123456789";

let root = "";
let work = "";
let home = "";
let skills = "";
let etc = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "aicoop-box-"));
  work = join(root, "work");
  home = join(root, "home");
  skills = join(root, "skills");
  etc = join(root, "etc");
  for (const dir of [work, home, skills, etc]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, "a-file"), "x");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function spec(overrides: Partial<BoxSpec> = {}): BoxSpec {
  return {
    groupId: "dev",
    memberId: "alice",
    runId: "run_01",
    kind: "vm",
    mounts: [
      { hostPath: work, guestPath: "/work", readOnly: false },
      { hostPath: home, guestPath: "/home/agent", readOnly: false },
      { hostPath: skills, guestPath: "/home/agent/.claude/skills", readOnly: true },
      { hostPath: etc, guestPath: "/etc/aicoop", readOnly: true },
    ],
    env: { HOME: "/home/agent", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    secrets: [{ env: "GITHUB_TOKEN", hosts: ["api.github.com", "github.com"], value: REAL }],
    network: {
      passthroughHosts: ["api.anthropic.com"],
      gatewayPort: 43123,
      onRequest: async (): Promise<ProxyDecision> => ({ action: "forward" }),
    },
    ...overrides,
  };
}

function setup(options: { killGraceMs?: number } = {}) {
  const vms: FakeVm[] = [];
  const driver = createGondolinDriver({
    ...options,
    createVm: async (vmOptions) => {
      const vm = new FakeVm(vmOptions);
      vms.push(vm);
      return vm;
    },
  });
  return { driver, vms };
}

function envOf(vm: FakeVm | undefined): Record<string, string> {
  const env = vm?.options.env;
  if (env === undefined || Array.isArray(env)) throw new Error("env がない");
  return env;
}

async function collect(handle: AsyncIterable<ExecLine>): Promise<ExecLine[]> {
  const lines: ExecLine[] = [];
  for await (const line of handle) lines.push(line);
  return lines;
}

describe("4.4：createGondolinDriver", () => {
  it("kind は vm", () => {
    expect(createGondolinDriver().kind).toBe("vm");
  });

  it("vm 以外の BoxSpec は作らない", async () => {
    const { driver, vms } = setup();
    await expect(driver.create(spec({ kind: "srt" }))).rejects.toThrow();
    expect(vms).toHaveLength(0);
  });

  it("VM を起こしてから Box を返す", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    expect(vms[0]?.started).toBe(1);
  });

  it("VM が起きなければ、VM を閉じて失敗する", async () => {
    const vms: FakeVm[] = [];
    const driver = createGondolinDriver({
      createVm: async (o) => {
        const vm = new FakeVm(o);
        vm.startError = new Error("boot failed");
        vms.push(vm);
        return vm;
      },
    });
    await expect(driver.create(spec())).rejects.toThrow("boot failed");
    expect(vms[0]?.closed).toBe(1);
  });
});

describe("5.1.6・V-4：箱の大きさ", () => {
  it("memoryMiB と cpus を Gondolin の memory・cpus に渡す", async () => {
    const { driver, vms } = setup();
    await driver.create(spec({ memoryMiB: 1536, cpus: 3 }));
    expect(vms[0]?.options.memory).toBe("1536M");
    expect(vms[0]?.options.cpus).toBe(3);
  });

  it("指定がなければ 5.1.6 の既定（2048 MiB、2 CPU）", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    expect(vms[0]?.options.memory).toBe("2048M");
    expect(vms[0]?.options.cpus).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN, 64])("memoryMiB %s は作らない", async (memoryMiB) => {
    const { driver } = setup();
    await expect(driver.create(spec({ memoryMiB }))).rejects.toThrow();
  });

  it.each([0, -1, 1.5, 1000])("cpus %s は作らない", async (cpus) => {
    const { driver } = setup();
    await expect(driver.create(spec({ cpus }))).rejects.toThrow();
  });
});

describe("5.1.8：イメージ", () => {
  it("BoxSpec.image があれば、それを使う", async () => {
    const { driver, vms } = setup();
    await driver.create(spec({ image: "/home/u/.aicoop/images/base" }));
    expect(vms[0]?.options.sandbox?.imagePath).toBe("/home/u/.aicoop/images/base");
  });

  it("なければドライバーの既定、それもなければ Gondolin の既定", async () => {
    const vms: FakeVm[] = [];
    const createVm = async (o: ConstructorParameters<typeof FakeVm>[0]) => {
      const vm = new FakeVm(o);
      vms.push(vm);
      return vm;
    };
    await createGondolinDriver({ createVm, defaultImage: "/img/default" }).create(spec());
    await createGondolinDriver({ createVm }).create(spec());
    expect(vms[0]?.options.sandbox?.imagePath).toBe("/img/default");
    expect(vms[1]?.options.sandbox?.imagePath).toBeUndefined();
  });

  it("Gondolin のデバッグログは環境変数（GONDOLIN_DEBUG）があっても出さない", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    expect(vms[0]?.options.sandbox?.debug).toBe(false);
    expect(vms[0]?.options.debugLog).toBeNull();
  });
});

describe("5.1.7：マウント", () => {
  it("ホストのフォルダを RealFSProvider で、読み取り専用は ReadonlyProvider で包む", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    const mounts = vms[0]?.options.vfs?.mounts ?? {};
    expect(Object.keys(mounts).sort()).toEqual([
      "/etc/aicoop",
      "/home/agent",
      "/home/agent/.claude/skills",
      "/work",
    ]);
    expect(mounts["/work"]).toBeInstanceOf(RealFSProvider);
    expect(mounts["/home/agent"]).toBeInstanceOf(RealFSProvider);
    expect(mounts["/home/agent/.claude/skills"]).toBeInstanceOf(ReadonlyProvider);
    expect(mounts["/etc/aicoop"]).toBeInstanceOf(ReadonlyProvider);
    expect(mounts["/work"]?.readonly).toBe(false);
    expect(mounts["/home/agent/.claude/skills"]?.readonly).toBe(true);
  });

  it.each([
    ["work", "相対パス"],
    ["/", "ルート"],
    ["/work/", "末尾の /"],
    ["/work/../etc", ".."],
    ["/work/./x", "."],
    ["/a//b", "空の区切り"],
    ["/etc/gondolin", "Gondolin の予約"],
    ["/etc/gondolin/x", "Gondolin の予約の中"],
    ["/data", "Gondolin の FUSE の場所"],
    ["/proc", "カーネルの場所"],
    ["/dev/x", "カーネルの場所"],
    ["/w\\x", "バックスラッシュ"],
  ])("箱の中のパス %j（%s）は作らない", async (guestPath) => {
    const { driver } = setup();
    await expect(
      driver.create(spec({ mounts: [{ hostPath: work, guestPath, readOnly: false }] })),
    ).rejects.toThrow();
  });

  it("同じ箱の中のパスに2つマウントしない", async () => {
    const { driver } = setup();
    await expect(
      driver.create(
        spec({
          mounts: [
            { hostPath: work, guestPath: "/work", readOnly: false },
            { hostPath: home, guestPath: "/work", readOnly: true },
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it("ホストのパスが絶対パスのフォルダでなければ作らない", async () => {
    const { driver } = setup();
    for (const hostPath of ["relative/dir", join(root, "missing"), join(root, "a-file")]) {
      await expect(
        driver.create(spec({ mounts: [{ hostPath, guestPath: "/work", readOnly: false }] })),
      ).rejects.toThrow();
    }
  });
});

describe("5.2.1：資格と環境変数", () => {
  it("P1 完了条件1：箱の環境変数には仮の札だけが入り、本物は入らない", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    const env = envOf(vms[0]);
    expect(env.GITHUB_TOKEN).toMatch(/^GONDOLIN_SECRET_[0-9a-f]{48}$/);
    expect(JSON.stringify(vms[0]?.options)).not.toContain(REAL);
  });

  it("BoxSpec.env はそのまま渡し、PATH がなければ既定を足す", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    const env = envOf(vms[0]);
    expect(env.HOME).toBe("/home/agent");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.PATH).toContain("/usr/local/bin");
  });

  it("BoxSpec.env が資格と同じ名前を持てば作らない（本物が紛れ込むのを防ぐ）", async () => {
    const { driver } = setup();
    await expect(driver.create(spec({ env: { GITHUB_TOKEN: REAL } }))).rejects.toThrow();
  });

  it("環境変数の名前が不正なら作らない", async () => {
    const { driver } = setup();
    await expect(driver.create(spec({ env: { "A=B": "x" } }))).rejects.toThrow();
  });

  it("作るのに失敗したときのエラーに本物の資格を出さない", async () => {
    const { driver } = setup();
    const error = await driver.create(spec({ env: { GITHUB_TOKEN: REAL } })).catch((e) => e);
    expect(String(error)).not.toContain(REAL);
  });

  it("5.1.3 の2：箱ごとに仮の札が変わる", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    await driver.create(spec());
    const a = envOf(vms[0]).GITHUB_TOKEN;
    const b = envOf(vms[1]).GITHUB_TOKEN;
    expect(a).not.toBe(b);
  });

  it("資格プロキシのフックは BoxSpec の onRequest を呼ぶ", async () => {
    const onRequest = vi.fn(async (): Promise<ProxyDecision> => ({ action: "forward" }));
    const { driver, vms } = setup();
    await driver.create(spec({ network: { ...spec().network, onRequest } }));
    await vms[0]?.options.httpHooks?.onRequest?.(new Request("https://api.github.com/user"));
    expect(onRequest).toHaveBeenCalledTimes(1);
  });
});

describe("5.1.4・5.2.7・5.3.1：通信", () => {
  it("V-1：passthroughHosts は tcp.hosts で、暗号を解かずに 443 を素通しする", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    expect(vms[0]?.options.tcp?.hosts["api.anthropic.com:443"]).toBe("api.anthropic.com:443");
  });

  it("V-2：aicoop.internal:80 を 127.0.0.1:<gatewayPort> に向ける", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    expect(vms[0]?.options.tcp?.hosts["aicoop.internal:80"]).toBe("127.0.0.1:43123");
  });

  it("tcp.hosts には、この2種類のほかは入れない", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    expect(Object.keys(vms[0]?.options.tcp?.hosts ?? {}).sort()).toEqual([
      "aicoop.internal:80",
      "api.anthropic.com:443",
    ]);
  });

  it("tcp.hosts に要る合成DNS（ホストごと）を使う", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    expect(vms[0]?.options.dns).toEqual({ mode: "synthetic", syntheticHostMapping: "per-host" });
  });

  it("WebSocket は使わない（切り替えたあとの中身を判定できない）", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    expect(vms[0]?.options.allowWebSockets).toBe(false);
  });

  it("SSH の出口は作らない", async () => {
    const { driver, vms } = setup();
    await driver.create(spec());
    expect(vms[0]?.options.ssh).toBeUndefined();
  });

  it.each([
    ["*.anthropic.com", "ワイルドカード"],
    ["aicoop.internal", "道具ゲートの名前"],
    ["127.0.0.1", "IP アドレス"],
    ["api.anthropic.com:443", "ポートつき"],
    ["API.anthropic.com", "大文字"],
    ["localhost", "ドットのない名前"],
    ["", "空"],
  ])("passthroughHosts に %j（%s）があれば作らない", async (host) => {
    const { driver } = setup();
    await expect(
      driver.create(spec({ network: { ...spec().network, passthroughHosts: [host] } })),
    ).rejects.toThrow();
  });

  it.each([0, 65536, 1.5, -80])("gatewayPort %s は作らない", async (gatewayPort) => {
    const { driver } = setup();
    await expect(
      driver.create(spec({ network: { ...spec().network, gatewayPort } })),
    ).rejects.toThrow();
  });
});

describe("4.4：Box.exec", () => {
  it("$PATH を探せるよう /bin/sh を通し、引数は位置引数で渡す（注入されない）", async () => {
    const { driver, vms } = setup();
    const box = await driver.create(spec());
    const handle = box.exec(["claude", "-p", "$(id); rm -rf /"], { cwd: "/work" });
    await handle.exitCode;
    const call = vms[0]?.execCalls[0];
    expect(call?.command.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(call?.command.slice(-3)).toEqual(["claude", "-p", "$(id); rm -rf /"]);
    expect(call?.command[2]).not.toContain("claude");
    expect(call?.options.cwd).toBe("/work");
    expect(call?.options.stdout).toBe("pipe");
    expect(call?.options.stderr).toBe("pipe");
  });

  it("stdout・stderr を行ごとに、どちらの出力か付けて返す", async () => {
    const { driver, vms } = setup();
    const box = await driver.create(spec());
    vms[0]?.scripts.push({
      chunks: [
        { stream: "stdout", text: '{"type":"system"}\n{"ty' },
        { stream: "stderr", text: "warn\n" },
        { stream: "stdout", text: 'pe":"result"}\nlast' },
      ],
      exitCode: 0,
    });
    const handle = box.exec(["claude"], { cwd: "/work" });
    expect(await collect(handle)).toEqual([
      { stream: "stdout", line: '{"type":"system"}' },
      { stream: "stderr", line: "warn" },
      { stream: "stdout", line: '{"type":"result"}' },
      { stream: "stdout", line: "last" },
    ]);
    expect(await handle.exitCode).toBe(0);
  });

  it("exitCode はコマンドの終了コード。シグナルで止まったら 128 + シグナル", async () => {
    const { driver, vms } = setup();
    const box = await driver.create(spec());
    vms[0]?.scripts.push({ exitCode: 3 }, { signal: 15 });
    expect(await box.exec(["false"], { cwd: "/" }).exitCode).toBe(3);
    expect(await box.exec(["sleep", "9"], { cwd: "/" }).exitCode).toBe(143);
  });

  it("opts.env を渡す", async () => {
    const { driver, vms } = setup();
    const box = await driver.create(spec());
    await box.exec(["env"], { cwd: "/", env: { A: "1" } }).exitCode;
    expect(vms[0]?.execCalls[0]?.options.env).toEqual({ A: "1" });
  });

  it("opts.env で資格と同じ名前の環境変数は渡せない（仮の札を本物で上書きさせない）", async () => {
    const { driver } = setup();
    const box = await driver.create(spec());
    expect(() => box.exec(["env"], { cwd: "/", env: { GITHUB_TOKEN: REAL } })).toThrow();
  });

  it("行を読まなくても exitCode は決まる", async () => {
    const { driver, vms } = setup();
    const box = await driver.create(spec());
    vms[0]?.scripts.push({ chunks: [{ stream: "stdout", text: "x\n".repeat(1000) }], exitCode: 0 });
    expect(await box.exec(["yes"], { cwd: "/" }).exitCode).toBe(0);
  });
});

describe("5.5.5：Box.kill", () => {
  it("箱の中で、動いている exec の PID とその子孫を止めるスクリプトを動かす", async () => {
    const { driver, vms } = setup({ killGraceMs: 10 });
    const box = await driver.create(spec());
    vms[0]?.scripts.push({ exitCode: 0 }, { hang: true });
    await box.exec(["true"], { cwd: "/" }).exitCode;
    const running = box.exec(["sleep", "600"], { cwd: "/" });
    await box.kill();
    const last = vms[0]?.execCalls.at(-1);
    expect(last?.command[0]).toBe("/bin/sh");
    expect(last?.command[2]).toContain("kill -TERM");
    // 終わった exec（1番）は対象にせず、動いている exec（2番）だけを渡す
    expect(last?.command.slice(3)).toEqual(["aicoop-kill", "2"]);
    expect(await running.exitCode).toBe(137);
  });

  it("動いている exec がなければ、箱の中では何もしない", async () => {
    const { driver, vms } = setup({ killGraceMs: 10 });
    const box = await driver.create(spec());
    await box.kill();
    expect(vms[0]?.execCalls).toHaveLength(0);
  });

  it("箱の中で止まらなくても、待っている exitCode は 137 で終わる", async () => {
    const { driver, vms } = setup({ killGraceMs: 10 });
    const box = await driver.create(spec());
    vms[0]?.scripts.push({ hang: true });
    const handle = box.exec(["sleep", "600"], { cwd: "/" });
    const lines = collect(handle);
    await box.kill();
    expect(await handle.exitCode).toBe(137);
    expect(await lines).toEqual([]);
  });
});

describe("5.1.7：Box.destroy", () => {
  it("VM を閉じる。何度呼んでも閉じるのは1回", async () => {
    const { driver, vms } = setup();
    const box = await driver.create(spec());
    await box.destroy();
    await box.destroy();
    await Promise.all([box.destroy(), box.destroy()]);
    expect(vms[0]?.closed).toBe(1);
  });

  it("壊したあとの exec は失敗する", async () => {
    const { driver } = setup();
    const box = await driver.create(spec());
    await box.destroy();
    expect(() => box.exec(["true"], { cwd: "/" })).toThrow();
  });

  it("5.1.3 の2：壊したら、その箱の仮の札は本物に置き換わらない", async () => {
    const { driver, vms } = setup();
    const box = await driver.create(spec());
    const placeholder = envOf(vms[0]).GITHUB_TOKEN;
    await box.destroy();
    const request = new Request("https://api.github.com/user", {
      headers: { authorization: `Bearer ${placeholder}` },
    });
    const out = (await vms[0]?.options.httpHooks?.onRequest?.(request)) ?? request;
    expect((out as Request).headers.get("authorization") ?? "").not.toContain(REAL);
  });

  it("動いている exec は壊すと終わる", async () => {
    const { driver, vms } = setup();
    const box = await driver.create(spec());
    vms[0]?.scripts.push({ hang: true });
    const handle = box.exec(["sleep", "600"], { cwd: "/" });
    await box.destroy();
    expect(await handle.exitCode).toBe(137);
  });
});
