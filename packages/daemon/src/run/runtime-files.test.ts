import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { newId } from "@aicoop/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AicoopPaths, aicoopPaths } from "../paths.ts";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import { managedSettings, mcpConfig } from "./managed-settings.ts";
import { GUEST_PATHS, vmMounts } from "./mounts.ts";
import {
  prepareRuntimeDir,
  removeRuntimeDir,
  removeStaleRuntimeDirs,
  writeHomeClaudeFiles,
} from "./runtime-files.ts";

let tmp: TempDir;
let paths: AicoopPaths;

beforeEach(() => {
  tmp = tempDir();
  paths = aicoopPaths(join(tmp.path, ".aicoop"));
});
afterEach(() => tmp.cleanup());

describe("5.4.4 の1・5.4.3 の1：ホームの .claude/ に CLAUDE.md と空の settings.json を書く", () => {
  it("毎回上書きする", () => {
    const home = paths.memberHome("dev-implementer");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "古い");
    writeHomeClaudeFiles(home, "# 会社の方針\n\n新しい\n");
    expect(readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")).toBe(
      "# 会社の方針\n\n新しい\n",
    );
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))).toEqual({});
  });
});

describe("5.1.7・5.3.6・5.3.8：実行ごとのフォルダ runtime/<run_id>/", () => {
  it("etc/mcp.json（道具ゲートだけ）と managed/managed-settings.json を書く", () => {
    const runId = newId("run");
    prepareRuntimeDir(paths, runId, [], { gatewayToken: "tok-123" });
    expect(JSON.parse(readFileSync(join(paths.runEtc(runId), "mcp.json"), "utf8"))).toEqual(
      mcpConfig("tok-123"),
    );
    expect(
      JSON.parse(readFileSync(join(paths.runManaged(runId), "managed-settings.json"), "utf8")),
    ).toEqual(managedSettings());
    expect(lstatSync(paths.runSkills(runId)).isDirectory()).toBe(true);
  });

  it("役職の skills だけを ~/.aicoop/skills/ から複製する", () => {
    write(join(paths.skillsDir, "git-workflow", "SKILL.md"), "git の手順");
    write(join(paths.skillsDir, "git-workflow", "refs", "a.md"), "参考");
    write(join(paths.skillsDir, "other", "SKILL.md"), "ほかの役職の");
    const runId = newId("run");

    const result = prepareRuntimeDir(paths, runId, ["git-workflow"], { gatewayToken: "t" });

    expect(result).toEqual({ copied: ["git-workflow"], missing: [] });
    expect(readdirSync(paths.runSkills(runId))).toEqual(["git-workflow"]);
    expect(readFileSync(join(paths.runSkills(runId), "git-workflow", "SKILL.md"), "utf8")).toBe(
      "git の手順",
    );
    expect(existsSync(join(paths.runSkills(runId), "git-workflow", "refs", "a.md"))).toBe(true);
  });

  it("無いスキルは複製せずに知らせる。スキルの中のリンクは複製しない（ホストのファイルを箱へ持ち込まない）", (ctx) => {
    write(join(paths.skillsDir, "s", "SKILL.md"), "x");
    write(join(tmp.path, "host-secret.txt"), "ホストの秘密");
    try {
      symlinkSync(join(tmp.path, "host-secret.txt"), join(paths.skillsDir, "s", "leak.txt"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") ctx.skip();
      throw e;
    }
    const runId = newId("run");

    const result = prepareRuntimeDir(paths, runId, ["s", "missing"], { gatewayToken: "t" });

    expect(result).toEqual({ copied: ["s"], missing: ["missing"] });
    expect(readdirSync(join(paths.runSkills(runId), "s"))).toEqual(["SKILL.md"]);
  });

  it("実行の終わりに消す", () => {
    const runId = newId("run");
    prepareRuntimeDir(paths, runId, [], { gatewayToken: "t" });
    removeRuntimeDir(paths, runId);
    expect(existsSync(paths.runDir(runId))).toBe(false);
    // 何度呼んでもよい
    removeRuntimeDir(paths, runId);
  });
});

describe("6.1・8.6：制御サーバーが落ちて残った runtime/<run_id>/ を、起動のときに消す", () => {
  it("実行のフォルダ（r_...）だけを消し、ほかのもの（daemon.json・api_token など）は触らない", () => {
    const a = newId("run");
    const b = newId("run");
    prepareRuntimeDir(paths, a, [], { gatewayToken: "t" });
    prepareRuntimeDir(paths, b, [], { gatewayToken: "t" });
    write(join(paths.runtimeDir, "daemon.json"), "{}");
    write(join(paths.runtimeDir, "api_token"), "x");
    write(join(paths.runtimeDir, "notes", "keep"), "x");

    expect(removeStaleRuntimeDirs(paths).sort()).toEqual([a, b].sort());
    expect(readdirSync(paths.runtimeDir).sort()).toEqual(["api_token", "daemon.json", "notes"]);
  });

  it("runtime/ がなくてもよい", () => {
    expect(removeStaleRuntimeDirs(paths)).toEqual([]);
  });
});

describe("5.1.7：箱のマウントの表", () => {
  it("作業フォルダ・ホームは書き込み可、設定・スキル・管理設定は読み取り専用", () => {
    const runId = newId("run");
    expect(vmMounts(paths, { runId, groupId: "dev", memberId: "dev-implementer" })).toEqual([
      { hostPath: paths.groupWork("dev"), guestPath: "/work", readOnly: false },
      { hostPath: paths.memberHome("dev-implementer"), guestPath: "/home/agent", readOnly: false },
      { hostPath: paths.runEtc(runId), guestPath: "/etc/aicoop", readOnly: true },
      {
        hostPath: paths.runSkills(runId),
        guestPath: "/home/agent/.claude/skills",
        readOnly: true,
      },
      { hostPath: paths.runManaged(runId), guestPath: "/etc/claude-code", readOnly: true },
    ]);
    expect(GUEST_PATHS.mcpConfig).toBe("/etc/aicoop/mcp.json");
  });
});

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}
