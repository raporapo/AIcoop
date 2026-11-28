import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aicoopPaths, resolveAicoopHome } from "./paths.ts";

describe("6.1：~/.aicoop の置き場所", () => {
  it("AICOOP_HOME があればそれを使う", () => {
    expect(resolveAicoopHome({ AICOOP_HOME: "/srv/company" }, "/home/owner")).toBe(
      resolve("/srv/company"),
    );
  });

  it("AICOOP_HOME の ~ はホームに展開する", () => {
    expect(resolveAicoopHome({ AICOOP_HOME: "~/work/co" }, "/home/owner")).toBe(
      resolve(join("/home/owner", "work/co")),
    );
  });

  it("AICOOP_HOME が無い・空なら ~/.aicoop", () => {
    expect(resolveAicoopHome({}, "/home/owner")).toBe(join("/home/owner", ".aicoop"));
    expect(resolveAicoopHome({ AICOOP_HOME: "  " }, "/home/owner")).toBe(
      join("/home/owner", ".aicoop"),
    );
  });
});

describe("5.1.7・6.1：ホスト側のパス", () => {
  const p = aicoopPaths("/h");

  it("部署の作業フォルダと社員のホーム", () => {
    expect(p.groupWork("dev")).toBe(join("/h", "data", "groups", "dev", "work"));
    expect(p.memberHome("dev-implementer")).toBe(
      join("/h", "data", "members", "dev-implementer", "home"),
    );
  });

  it("実行ごとのフォルダ（etc・skills・managed）", () => {
    const run = "r_01JD6V8X3S0Q5W7KQ9M2T4R6YB";
    expect(p.runDir(run)).toBe(join("/h", "runtime", run));
    expect(p.runEtc(run)).toBe(join("/h", "runtime", run, "etc"));
    expect(p.runSkills(run)).toBe(join("/h", "runtime", run, "skills"));
    expect(p.runManaged(run)).toBe(join("/h", "runtime", run, "managed"));
    expect(p.runLog(run)).toBe(join("/h", "logs", "runs", `${run}.jsonl`));
  });

  it("保留の本文と、固定の場所", () => {
    expect(p.holdFile("h_01JD6V8X3S0Q5W7KQ9M2T4R6YB")).toBe(
      join("/h", "state", "holds", "h_01JD6V8X3S0Q5W7KQ9M2T4R6YB.bin"),
    );
    expect(p.holdResponseFile("h_01JD6V8X3S0Q5W7KQ9M2T4R6YB")).toBe(
      join("/h", "state", "holds", "h_01JD6V8X3S0Q5W7KQ9M2T4R6YB.response.bin"),
    );
    expect(p.stateDb).toBe(join("/h", "state.db"));
    expect(p.secrets).toBe(join("/h", "secrets.json"));
    expect(p.apiToken).toBe(join("/h", "runtime", "api_token"));
    expect(p.daemonInfo).toBe(join("/h", "runtime", "daemon.json"));
  });

  it("ID でないものからパスを作らない（../ でホームの外に出ない）", () => {
    expect(() => p.groupWork("../secrets")).toThrow();
    expect(() => p.memberHome("a/b")).toThrow();
    expect(() => p.runDir("../../etc")).toThrow();
    expect(() => p.runDir("t_01JD6V8X3S0Q5W7KQ9M2T4R6YB")).toThrow();
    expect(() => p.holdFile("r_01JD6V8X3S0Q5W7KQ9M2T4R6YB")).toThrow();
    expect(() => p.holdResponseFile("../x")).toThrow();
  });
});
