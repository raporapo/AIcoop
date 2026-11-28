import { MAX_IMAGE_BUILD_LINES } from "@aicoop/shared/api";
import { pino } from "pino";
import { describe, expect, it } from "vitest";
import { ApprovalFailure } from "../approvals/errors.ts";
import { createImageBuilds, type ImageBuildRunner } from "./image-build.ts";

interface Controlled {
  readonly runner: ImageBuildRunner;
  readonly calls: Array<{ home: string }>;
  line(text: string): void;
  finish(code: number | null): void;
  aborted(): boolean;
}

function controlled(): Controlled {
  let onLine: (line: string) => void = () => {};
  let resolve: (v: { exitCode: number | null }) => void = () => {};
  let signal: AbortSignal | undefined;
  const calls: Array<{ home: string }> = [];
  return {
    calls,
    runner: (input) => {
      calls.push({ home: input.home });
      onLine = input.onLine;
      signal = input.signal;
      return new Promise((r) => {
        resolve = r;
        input.signal.addEventListener("abort", () => r({ exitCode: null }));
      });
    },
    line: (text) => onLine(text),
    finish: (code) => resolve({ exitCode: code }),
    aborted: () => signal?.aborted === true,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function make(runner: ImageBuildRunner | undefined, platform: NodeJS.Platform = "linux") {
  return createImageBuilds({
    home: "/home/a/.aicoop",
    platform,
    ...(runner !== undefined && { runner }),
    now: () => new Date("2026-11-29T00:00:00Z"),
    logger: pino({ level: "silent" }),
  });
}

function failureOf(fn: () => unknown): ApprovalFailure {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApprovalFailure) return e;
    throw e;
  }
  throw new Error("失敗しませんでした");
}

describe("5.14 の3の4：箱のイメージを作る（aicoop image build と同じこと）", () => {
  it("作り始めて、段階とログの行を返し、終わったら済み", async () => {
    const c = controlled();
    const builds = make(c.runner);
    const started = builds.start();
    expect(started.state).toBe("running");
    expect(c.calls).toEqual([{ home: "/home/a/.aicoop" }]);
    c.line("\x1b[1m[1/2] ベースのイメージを作っています…\x1b[22m\x1b[2m 数分かかります\x1b[22m");
    c.line("Building guest assets for x86_64 (alpine)");
    c.line("[2/2] 部署 dev のイメージを作っています（足すパッケージ：nodejs・npm）…");
    const running = builds.current();
    expect(running?.stage).toEqual({
      index: 2,
      total: 2,
      label: "部署 dev のイメージを作っています（足すパッケージ：nodejs・npm）",
    });
    expect(running?.lines).toContain("Building guest assets for x86_64 (alpine)");
    expect(running?.lines.join("\n")).not.toContain("\x1b");
    c.finish(0);
    await flush();
    expect(builds.current()).toMatchObject({ state: "succeeded" });
    expect(builds.current()?.finished_at).not.toBeNull();
  });

  it("二重には起こさない（作っているあいだは 409）。終わったら、また作れる", async () => {
    const c = controlled();
    const builds = make(c.runner);
    builds.start();
    const e = failureOf(() => builds.start());
    expect(e.status).toBe(409);
    expect(e.code).toBe("invalid_state");
    expect(c.calls).toHaveLength(1);
    c.finish(1);
    await flush();
    expect(builds.current()).toMatchObject({ state: "failed" });
    expect(builds.current()?.message).toContain("終了コード 1");
    builds.start();
    expect(c.calls).toHaveLength(2);
  });

  it("ログは上限の行数まで（古いものから捨てる）。長い行は切る", async () => {
    const c = controlled();
    const builds = make(c.runner);
    builds.start();
    for (let i = 0; i < MAX_IMAGE_BUILD_LINES + 50; i++) c.line(`line ${i}`);
    c.line("x".repeat(2000));
    const lines = builds.current()?.lines ?? [];
    expect(lines).toHaveLength(MAX_IMAGE_BUILD_LINES);
    expect(lines[0]).toBe("line 51");
    expect((lines.at(-1) ?? "").length).toBeLessThanOrEqual(501);
  });

  it("Windows では作れない（起こさない）", () => {
    const c = controlled();
    const e = failureOf(() => make(c.runner, "win32").start());
    expect(e.code).toBe("unavailable");
    expect(e.message).toContain("WSL2");
    expect(c.calls).toHaveLength(0);
  });

  it("イメージを作る部品が差し込まれていなければ作れない", () => {
    expect(failureOf(() => make(undefined).start()).code).toBe("unavailable");
  });

  it("止めるときは、作っているものを止める", async () => {
    const c = controlled();
    const builds = make(c.runner);
    builds.start();
    await builds.stop();
    expect(c.aborted()).toBe(true);
    expect(builds.current()?.state).toBe("failed");
  });

  it("まだ作っていなければ null", () => {
    expect(make(controlled().runner).current()).toBeNull();
  });
});
