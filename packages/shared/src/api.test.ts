import { describe, expect, it } from "vitest";
import { CONFIG_FILE_PATH_PATTERN, isRepositoryPattern } from "./api.ts";

describe("5.14 の3の3：AI が触ってよいリポジトリの書き方", () => {
  it.each(["raporapo/AIcoop", "raporapo/*", "a/b", "my-org/repo.name_2", "A1/x-y"])(
    "%j は受け入れる",
    (value) => {
      expect(isRepositoryPattern(value)).toBe(true);
    },
  );

  it.each([
    "*/*",
    "*/repo",
    "../x",
    "owner/..",
    "owner/.",
    "owner",
    "owner/",
    "/repo",
    "owner/repo/extra",
    "owner/re po",
    " owner/repo",
    "owner/repo ",
    "owner/repo\n",
    "owner/re*",
    "-owner/repo",
    "your-org/*",
    "Your-Org/app",
    `${"a".repeat(40)}/repo`,
    `owner/${"r".repeat(101)}`,
    "owner\\repo",
    "",
  ])("%j は受け入れない（拒否側）", (value) => {
    expect(isRepositoryPattern(value)).toBe(false);
  });
});

describe("5.14 の4の1：設定の画面で扱えるファイルのパス", () => {
  it.each([
    "aicoop.yaml",
    "groups.yaml",
    "roles.yaml",
    "members.yaml",
    "triggers.yaml",
    "mcp_servers.yaml",
    "host_tools.yaml",
    "services/github.yaml",
    "services/my-crm.yaml",
    "prompts/company.md",
    "prompts/roles/implementer.md",
    "prompts/groups/dev.md",
    "prompts/members/dev-implementer.md",
  ])("%s は扱える", (path) => {
    expect(CONFIG_FILE_PATH_PATTERN.test(path)).toBe(true);
  });

  it.each([
    "secrets.json",
    "state.db",
    "state.db-wal",
    "runtime/api_token",
    "logs/daemon.log",
    "data/groups/dev/work/a.md",
    "state/holds/h_x.bin",
    "skills/x/SKILL.md",
    ".gitignore",
    "../secrets.json",
    "prompts/../secrets.json",
    "prompts/./company.md",
    "prompts/../../etc/passwd.md",
    "prompts/%2e%2e/company.md",
    "%2e%2e/secrets.json",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "prompts\\company.md",
    "services/../secrets.json",
    "services/sub/x.yaml",
    "services/github.yml",
    "aicoop.yml",
    "Aicoop.yaml",
    "groups.yaml/",
    "prompts/a/b/c/d.md",
    "prompts/company.md.bak",
    "prompts/.hidden.md",
    "",
    "groups.yaml\n",
  ])("%j は扱わない", (path) => {
    expect(CONFIG_FILE_PATH_PATTERN.test(path)).toBe(false);
  });
});
