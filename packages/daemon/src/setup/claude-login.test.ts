import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateSecretChangeResponse } from "@aicoop/shared/api";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalFailure } from "../approvals/errors.ts";
import { manualClock } from "../testing/manual-clock.ts";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import { systemTimers, type Timers } from "../timers.ts";
import { type ClaudeLogin, type ClaudeLoginDeps, createClaudeLogin } from "./claude-login.ts";
import { spawnPty } from "./pty.ts";

const FAKE = join(import.meta.dirname, "..", "testing", "fake-setup-token.mjs");
const TOKEN = `sk-ant-oat01-${"Q".repeat(20)}FAKE_LOGIN_TOKEN_${"z".repeat(40)}`;
const GOOD_CODE = "AbCdEf0123456789_-AbCdEf0123456789#state_0123456789";
const URL = "https://claude.ai/oauth/authorize?IMeNLHJMkrH2UN_V5CAd50YPtDYRKh0F903qpeiMx3cE";

let dir: TempDir;
let logs: string[];
let proposed: string[];
let spawned: Array<{ argv: readonly string[]; env: NodeJS.ProcessEnv }>;
let login: ClaudeLogin;

const record = () => join(dir.path, "code.txt");

function make(mode: string, over: Partial<ClaudeLoginDeps> = {}): ClaudeLogin {
  login = createClaudeLogin({
    platform: "linux",
    userHome: dir.path,
    which: (command) => `/usr/bin/${command}`,
    spawn: (argv, env) => {
      spawned.push({ argv, env });
      return spawnPty([process.execPath, FAKE, "setup-token"], {
        ...env,
        FAKE_SETUP_TOKEN_MODE: mode,
        FAKE_SETUP_TOKEN_VALUE: TOKEN,
        FAKE_SETUP_TOKEN_RECORD: record(),
      });
    },
    timers: systemTimers,
    now: () => new Date(),
    logger: pino({ level: "debug" }, { write: (line: string) => void logs.push(line) }),
    propose: (token): CreateSecretChangeResponse => {
      proposed.push(token);
      return {
        id: "x_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
        summary: { id: "anthropic", kind: "anthropic_oauth", action: "create" },
        expires_at: "2026-11-29T00:10:00.000Z",
      };
    },
    ...over,
  });
  return login;
}

async function failure(promise: Promise<unknown> | (() => unknown)): Promise<ApprovalFailure> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (e) {
    if (e instanceof ApprovalFailure) return e;
    throw e;
  }
  throw new Error("失敗しませんでした");
}

beforeEach(() => {
  dir = tempDir();
  logs = [];
  proposed = [];
  spawned = [];
});

afterEach(async () => {
  login?.stop();
  dir.cleanup();
});

describe("5.14 の3の2：Claude へのログイン（setup-token を擬似端末で動かす）", () => {
  it("始めると、setup-token を script の中で動かし、画面のログイン用の URL を返す", async () => {
    const view = await make("ok").start();
    expect(view).toMatchObject({ state: "waiting_code", url: URL, change: null });
    expect(Date.parse(view.expires_at) - Date.parse(view.started_at)).toBe(10 * 60 * 1000);
    const { argv, env } = spawned[0] ?? { argv: [], env: {} };
    expect(argv[0]).toBe("/usr/bin/script");
    expect(argv.join(" ")).toContain("stty cols");
    expect(argv.join(" ")).toContain("'/usr/bin/claude' setup-token");
    // setup-token が自分でブラウザを開かない（URL は準備の画面に出す）
    expect(env.BROWSER).toBe("true");
    expect(login.current()?.state).toBe("waiting_code");
  });

  it("貼られたコードを setup-token に渡し、トークンを読み取って、資格 anthropic の変更（署名待ち）を作る。応答にトークンを出さない", async () => {
    const { id } = await make("ok").start();
    const done = await login.submitCode(id, `  ${GOOD_CODE}\n`);
    expect(readFileSync(record(), "utf8")).toBe(GOOD_CODE);
    expect(proposed).toEqual([TOKEN]);
    expect(done.state).toBe("done");
    expect(done.change?.summary).toEqual({
      id: "anthropic",
      kind: "anthropic_oauth",
      action: "create",
    });
    expect(done.url).toBeNull();
    expect(JSON.stringify(done)).not.toContain("FAKE_LOGIN_TOKEN");
    expect(JSON.stringify(login.current())).not.toContain("FAKE_LOGIN_TOKEN");
    expect(logs.join("\n")).not.toContain("FAKE_LOGIN_TOKEN");
    expect(logs.join("\n")).not.toContain(GOOD_CODE);
    // 終わったら、次のログインを始められる
    expect((await login.start()).state).toBe("waiting_code");
  });

  it("2つめのログインは始めない（同時に1つだけ）", async () => {
    await make("ok").start();
    const e = await failure(login.start());
    expect(e.status).toBe(409);
    expect(e.code).toBe("invalid_state");
    expect(spawned).toHaveLength(1);
  });

  it("始めてから10分で取り消す（setup-token を止める）。そのあとのコードは受けない", async () => {
    const clock = manualClock();
    const { id } = await make("hang", { timers: clock, now: clock.now }).start();
    clock.advance(10 * 60 * 1000);
    expect(login.current()?.state).toBe("expired");
    expect(login.current()?.url).toBeNull();
    await login.settled();
    const e = await failure(login.submitCode(id, GOOD_CODE));
    expect(e.status).toBe(409);
    expect(existsSync(record())).toBe(false);
    expect(proposed).toEqual([]);
  });

  it("取り消せる（setup-token を止める）", async () => {
    const { id } = await make("hang").start();
    expect(login.cancel(id).state).toBe("cancelled");
    await login.settled();
    expect((await failure(login.submitCode(id, GOOD_CODE))).status).toBe(409);
  });

  it.each([
    ["bad-exit", "0以外で終わる"],
    ["token-exit1", "トークンを出したが0以外で終わる"],
    ["no-token", "トークンが読み取れない"],
  ])("setup-token が %s（%s）なら失敗とし、何も作らない", async (mode) => {
    const { id } = await make(mode).start();
    const e = await failure(login.submitCode(id, GOOD_CODE));
    expect(e.status).toBe(422);
    expect(e.code).toBe("login_failed");
    expect(e.message).not.toContain("FAKE_LOGIN_TOKEN");
    expect(proposed).toEqual([]);
    expect(login.current()?.state).toBe("failed");
    expect(login.current()?.change).toBeNull();
    expect(logs.join("\n")).not.toContain("FAKE_LOGIN_TOKEN");
  });

  it("URL を出さずに終われば、始められなかったとする", async () => {
    const e = await failure(make("no-url").start());
    expect(e.code).toBe("login_failed");
    expect(login.current()?.state).toBe("failed");
  });

  it.each([
    ["壊れたコード（使えない文字）", "abc def ghi jkl"],
    ["壊れたコード（短すぎる）", "abc"],
    ["空", "   "],
    ["制御文字", `${GOOD_CODE.slice(0, 10)}\x1b[2J${GOOD_CODE.slice(10)}`],
    ["改行の途中", `${GOOD_CODE}\r\nexit`],
    ["長すぎる", "a".repeat(513)],
    ["文字列でない", 12345],
  ])("%s のコードは渡さない（400）。そのまま正しいコードを待つ", async (_, code) => {
    const { id } = await make("ok").start();
    const e = await failure(login.submitCode(id, code));
    expect(e.status).toBe(400);
    expect(e.code).toBe("invalid_input");
    expect(existsSync(record())).toBe(false);
    expect(login.current()?.state).toBe("waiting_code");
    expect((await login.submitCode(id, GOOD_CODE)).state).toBe("done");
  });

  it("ほかのログインの ID には渡さない（404）", async () => {
    await make("ok").start();
    const e = await failure(login.submitCode("00000000-0000-4000-8000-000000000000", GOOD_CODE));
    expect(e.status).toBe(404);
  });

  it("claude・script がなければ、入れ方つきで失敗（起こさない）", async () => {
    const noClaude = await failure(
      make("ok", { which: (c) => (c === "script" ? "/usr/bin/script" : null) }).start(),
    );
    expect(noClaude.code).toBe("unavailable");
    expect(noClaude.message).toContain("https://claude.ai/install.sh");
    const noScript = await failure(
      make("ok", { which: (c) => (c === "claude" ? "/usr/bin/claude" : null) }).start(),
    );
    expect(noScript.code).toBe("unavailable");
    expect(noScript.message).toContain("util-linux");
    expect(spawned).toHaveLength(0);
  });

  it("PATH になくても ~/.local/bin/claude（公式のインストーラーの置き場所）を使う", async () => {
    const local = join(dir.path, ".local", "bin");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "claude"), "#!/bin/sh\n");
    chmodSync(join(local, "claude"), 0o755);
    await make("ok", { which: (c) => (c === "script" ? "/usr/bin/script" : null) }).start();
    expect(spawned[0]?.argv.join(" ")).toContain(`${join(local, "claude")}`);
  });

  it("Windows では始めない（WSL2 の中で動かす）", async () => {
    const e = await failure(make("ok", { platform: "win32" }).start());
    expect(e.code).toBe("unavailable");
  });
});

describe.skipIf(process.platform === "win32")(
  "5.14 の3の2：本物の script（擬似端末）で、偽の claude を動かす",
  () => {
    it("URL を読み取り、コードを渡して、トークンを受け取る", async () => {
      const { execFileSync } = await import("node:child_process");
      let script: string;
      try {
        script = execFileSync("sh", ["-c", "command -v script"], { encoding: "utf8" }).trim();
      } catch {
        return; // script がない環境では確かめない
      }
      const claude = join(dir.path, "claude");
      writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
      chmodSync(claude, 0o755);
      const timers: Timers = systemTimers;
      login = createClaudeLogin({
        platform: process.platform,
        userHome: dir.path,
        which: (c) => (c === "script" ? script : c === "claude" ? claude : null),
        env: {
          ...process.env,
          FAKE_SETUP_TOKEN_VALUE: TOKEN,
          FAKE_SETUP_TOKEN_RECORD: record(),
        },
        timers,
        now: () => new Date(),
        logger: pino({ level: "silent" }),
        propose: (token) => {
          proposed.push(token);
          return {
            id: "x_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
            summary: { id: "anthropic", kind: "anthropic_oauth", action: "replace" },
            expires_at: "2026-11-29T00:10:00.000Z",
          };
        },
      });
      const started = await login.start();
      expect(started.url).toBe(URL);
      const done = await login.submitCode(started.id, GOOD_CODE);
      expect(done.state).toBe("done");
      expect(proposed).toEqual([TOKEN]);
      expect(readFileSync(record(), "utf8")).toBe(GOOD_CODE);
    }, 20_000);
  },
);
