import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MAX_CONFIG_FILE_BYTES } from "@aicoop/shared/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TempDir, tempDir } from "../testing/state-db.ts";
import {
  ConfigFileError,
  currentSha256,
  listConfigFiles,
  readConfigFile,
  writeConfigFiles,
} from "./files.ts";

let dir: TempDir;
let home: string;
let outside: string;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function write(relative: string, text: string) {
  const path = join(home, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** シンボリックリンクを作れない環境（Windows の一般ユーザー）では false */
function trySymlink(target: string, path: string, type?: "dir" | "file"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false;
  }
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigFileError) return e.code;
    throw e;
  }
  return undefined;
}

beforeEach(() => {
  dir = tempDir();
  home = join(dir.path, ".aicoop");
  outside = join(dir.path, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.md"), "外のファイル\n");
  write("aicoop.yaml", "company: {}\n");
  write("groups.yaml", "groups: {}\n");
  write("services/my-crm.yaml", "id: my-crm\n");
  write("services/notes.txt", "x");
  write("prompts/company.md", "# 方針\n");
  write("prompts/roles/implementer.md", "# 実装\n");
  write("secrets.json", '{"version":1,"secrets":{}}');
  write("state.db", "SQLite");
  write("runtime/api_token", "tok");
  write("logs/daemon.log", "log");
  write("skills/x/SKILL.md", "skill");
  write("data/groups/dev/work/a.md", "work");
});

afterEach(() => dir.cleanup());

describe("5.14 の4の1：設定のファイルの一覧", () => {
  it("6.1 の yaml・services/*.yaml・prompts/ の md だけを、パス・大きさ・SHA-256・更新日時で出す", () => {
    const files = listConfigFiles(home);
    expect(files.map((f) => f.path)).toEqual([
      "aicoop.yaml",
      "groups.yaml",
      "services/my-crm.yaml",
      "prompts/company.md",
      "prompts/roles/implementer.md",
    ]);
    const groups = files.find((f) => f.path === "groups.yaml");
    expect(groups).toEqual({
      path: "groups.yaml",
      size: Buffer.byteLength("groups: {}\n"),
      sha256: sha("groups: {}\n"),
      modified_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("secrets.json・state.db・runtime・logs・skills・data は一覧に出さない", () => {
    const paths = listConfigFiles(home).map((f) => f.path);
    for (const p of ["secrets.json", "state.db", "runtime/api_token", "logs/daemon.log"]) {
      expect(paths).not.toContain(p);
    }
    expect(paths.some((p) => p.startsWith("skills/") || p.startsWith("data/"))).toBe(false);
  });

  it("シンボリックリンクのファイル・フォルダは一覧に出さない", (ctx) => {
    if (!trySymlink(join(outside, "secret.md"), join(home, "prompts", "link.md"), "file")) {
      ctx.skip();
    }
    trySymlink(outside, join(home, "prompts", "groups"), "dir");
    const paths = listConfigFiles(home).map((f) => f.path);
    expect(paths).not.toContain("prompts/link.md");
    expect(paths).not.toContain("prompts/groups/secret.md");
  });

  it("home がなければ空", () => {
    expect(listConfigFiles(join(dir.path, "nothing"))).toEqual([]);
  });
});

describe("5.14 の4の1：設定のファイルの中身", () => {
  it("中身と SHA-256 を返す", () => {
    expect(readConfigFile(home, "prompts/roles/implementer.md")).toEqual({
      path: "prompts/roles/implementer.md",
      content: "# 実装\n",
      sha256: sha("# 実装\n"),
    });
  });

  it.each([
    "secrets.json",
    "state.db",
    "runtime/api_token",
    "../outside/secret.md",
    "prompts/../secrets.json",
    "prompts/%2e%2e/secrets.json",
    "%2e%2e%2fsecrets.json",
    "/etc/passwd",
    "prompts\\company.md",
    "services/notes.txt",
    "skills/x/SKILL.md",
  ])("5.14 の受け入れ条件：%s は読めない（not_allowed）", (path) => {
    expect(codeOf(() => readConfigFile(home, path))).toBe("not_allowed");
  });

  it("ないファイルは not_found", () => {
    expect(codeOf(() => readConfigFile(home, "triggers.yaml"))).toBe("not_found");
  });

  it("シンボリックリンクのファイルは読まない（lstat）", (ctx) => {
    if (!trySymlink(join(home, "secrets.json"), join(home, "prompts", "x.md"), "file")) {
      ctx.skip();
    }
    expect(codeOf(() => readConfigFile(home, "prompts/x.md"))).toBe("symlink");
  });

  it("途中のフォルダがシンボリックリンクなら読まない", (ctx) => {
    if (!trySymlink(outside, join(home, "prompts", "groups"), "dir")) ctx.skip();
    expect(codeOf(() => readConfigFile(home, "prompts/groups/secret.md"))).toBe("symlink");
  });

  it("大きすぎるファイルは読まない", () => {
    write("prompts/company.md", "a".repeat(MAX_CONFIG_FILE_BYTES + 1));
    expect(codeOf(() => readConfigFile(home, "prompts/company.md"))).toBe("too_large");
  });

  it("UTF-8 として読めないファイルは読まない", () => {
    writeFileSync(join(home, "groups.yaml"), Buffer.from([0xff, 0xfe, 0x00]));
    expect(codeOf(() => readConfigFile(home, "groups.yaml"))).toBe("not_text");
  });

  it("currentSha256：なければ null", () => {
    expect(currentSha256(home, "triggers.yaml")).toBeNull();
    expect(currentSha256(home, "groups.yaml")).toBe(sha("groups: {}\n"));
  });
});

describe("5.14 の4の4：ファイルを原子的に書き、元に戻せる", () => {
  it("書き換え・新しいファイル（フォルダも作る）をし、restore で元に戻す", () => {
    const written = writeConfigFiles(home, [
      { path: "groups.yaml", content: "groups: { dev: {} }\n" },
      { path: "prompts/members/dev-implementer.md", content: "# 個人\n" },
    ]);
    expect(readFileSync(join(home, "groups.yaml"), "utf8")).toBe("groups: { dev: {} }\n");
    expect(readFileSync(join(home, "prompts/members/dev-implementer.md"), "utf8")).toBe("# 個人\n");
    // 一時ファイルは残さない
    expect(readdirSync(home).filter((n) => n.includes(".tmp"))).toEqual([]);

    written.restore();
    expect(readFileSync(join(home, "groups.yaml"), "utf8")).toBe("groups: {}\n");
    expect(existsSync(join(home, "prompts/members/dev-implementer.md"))).toBe(false);
  });

  it("許されないパスには書かない", () => {
    expect(codeOf(() => writeConfigFiles(home, [{ path: "secrets.json", content: "{}" }]))).toBe(
      "not_allowed",
    );
    expect(readFileSync(join(home, "secrets.json"), "utf8")).toBe('{"version":1,"secrets":{}}');
  });

  it("シンボリックリンクのフォルダの中には書かない", (ctx) => {
    if (!trySymlink(outside, join(home, "prompts", "groups"), "dir")) ctx.skip();
    expect(
      codeOf(() => writeConfigFiles(home, [{ path: "prompts/groups/new.md", content: "x" }])),
    ).toBe("symlink");
    expect(existsSync(join(outside, "new.md"))).toBe(false);
  });

  it("シンボリックリンクのファイルを置き換えない（指す先も書き換えない）", (ctx) => {
    if (!trySymlink(join(outside, "secret.md"), join(home, "prompts", "x.md"), "file")) {
      ctx.skip();
    }
    expect(codeOf(() => writeConfigFiles(home, [{ path: "prompts/x.md", content: "y" }]))).toBe(
      "symlink",
    );
    expect(readFileSync(join(outside, "secret.md"), "utf8")).toBe("外のファイル\n");
  });
});
