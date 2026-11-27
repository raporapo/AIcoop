import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import type { ConfigIssue } from "../config-issue.ts";
import { baseGroups, baseMembers, baseRoles, COMPANY } from "../testing/config-fixtures.ts";
import { loadConfig } from "./load.ts";
import { builtinServicesDir } from "./paths.ts";

let userHome: string;
let home: string;

beforeEach(() => {
  userHome = mkdtempSync(join(tmpdir(), "aicoop-load-"));
  home = join(userHome, ".aicoop");
  write("aicoop.yaml", stringify({ company: COMPANY }));
  write("groups.yaml", stringify({ groups: baseGroups }));
  write("roles.yaml", stringify({ roles: baseRoles }));
  write("members.yaml", stringify({ members: baseMembers }));
  write("prompts/company.md", "# 会社の方針\n");
  write("prompts/roles/implementer.md", "# 実装担当\n");
  write("prompts/roles/researcher.md", "# 調査担当\n");
});

afterEach(() => {
  rmSync(userHome, { recursive: true, force: true });
});

function write(relative: string, text: string) {
  const path = join(home, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function load(options: Parameters<typeof loadConfig>[1] = {}) {
  return loadConfig(home, { userHome, checkSecretsMode: false, ...options });
}

function issuesOf(result: ReturnType<typeof loadConfig>): readonly ConfigIssue[] {
  return result.ok ? result.warnings : result.issues;
}

const sha256 = (relative: string) =>
  createHash("sha256")
    .update(readFileSync(join(home, relative)))
    .digest("hex");

describe("loadConfig（6.1）", () => {
  it("home の YAML・prompts・組み込みのサービス定義を読んで、CompanyConfig を返す", () => {
    const result = load();
    expect(issuesOf(result)).toEqual([]);
    if (!result.ok) return;
    expect(result.config.home).toBe(home);
    expect(result.config.groups.dev?.name).toBe("開発部");
    expect(result.config.services.map((s) => s.id)).toEqual(["github", "gmail", "web"]);
    expect(result.config.prompts.get("roles/implementer.md")).toBe("# 実装担当\n");
  });

  it("5.10 config.load：読んだファイルごとの SHA-256 を返す（組み込みのサービス定義も）", () => {
    write("triggers.yaml", "triggers: []\n");
    const result = load();
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    const hashes = result.config.fileHashes;
    expect(Object.keys(hashes).sort()).toEqual([
      "aicoop.yaml",
      "builtin:services/github.yaml",
      "builtin:services/gmail.yaml",
      "builtin:services/web.yaml",
      "groups.yaml",
      "members.yaml",
      "prompts/company.md",
      "prompts/roles/implementer.md",
      "prompts/roles/researcher.md",
      "roles.yaml",
      "triggers.yaml",
    ]);
    expect(hashes["groups.yaml"]).toBe(sha256("groups.yaml"));
    expect(hashes["prompts/company.md"]).toBe(sha256("prompts/company.md"));
    expect(hashes["builtin:services/github.yaml"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("必須のファイル（members.yaml）がなければ E-013", () => {
    rmSync(join(home, "members.yaml"));
    const result = load();
    expect(result.ok).toBe(false);
    expect(issuesOf(result).map((i) => `${i.code} ${i.source}`)).toEqual(["E-013 members.yaml"]);
  });

  it("home そのものがなくても、例外で落とさずに誤りを返す", () => {
    const result = loadConfig(join(userHome, "nothing"), { userHome, checkSecretsMode: false });
    expect(result.ok).toBe(false);
    expect(issuesOf(result).map((i) => i.source)).toEqual([
      "aicoop.yaml",
      "groups.yaml",
      "roles.yaml",
      "members.yaml",
    ]);
  });

  it("空のファイルは、何も書いていないものとして扱う", () => {
    write("triggers.yaml", "");
    expect(load().ok).toBe(true);
    write("groups.yaml", "# まだ何もない\n");
    const result = load();
    expect(issuesOf(result).map((i) => `${i.code} ${i.path}`)).toEqual(["E-013 groups"]);
  });

  it("6.10 E-013：YAML として読めないファイルは、どのファイルの何行目かを書く", () => {
    write("groups.yaml", "groups:\n  dev:\n    name: 開発部\n   box: vm\n");
    const result = load();
    expect(result.ok).toBe(false);
    const [issue] = issuesOf(result);
    expect(issue?.code).toBe("E-013");
    expect(issue?.source).toBe("groups.yaml");
    expect(issue?.message).toMatch(/^groups\.yaml をYAMLとして読めません（4行目）/);
  });

  it("6.10 E-013：同じキーを2回書いたら、後の値で黙って上書きしない", () => {
    write("members.yaml", `${stringify({ members: baseMembers })}members: {}\n`);
    const [issue] = issuesOf(load());
    expect(issue?.code).toBe("E-013");
    expect(issue?.message).toContain("同じキーが2回書かれています");
  });

  it("6.10 E-013：.yml の名前のファイルは読まないので、名前の誤りとして知らせる", () => {
    write("triggers.yml", "triggers: []\n");
    const [issue] = issuesOf(load());
    expect(issue?.code).toBe("E-013");
    expect(issue?.source).toBe("triggers.yml");
    expect(issue?.message).toContain("triggers.yaml");
  });

  describe("サービス定義（5.2.3 の1）", () => {
    const x = {
      id: "x",
      hosts: ["api.x.com"],
      secret: { env: "X_TOKEN", kind: "static_token", header: "authorization" },
      operations: { "post.create": { match: [{ method: "POST", path: "/2/tweets" }] } },
    };

    it("home/services/*.yaml を組み込みに重ねる", () => {
      write("services/x.yaml", stringify(x));
      const result = load();
      if (!result.ok) throw new Error(JSON.stringify(result.issues));
      expect(result.config.services.map((s) => s.id)).toEqual(["github", "gmail", "web", "x"]);
      expect(result.config.fileHashes["services/x.yaml"]).toBe(sha256("services/x.yaml"));
    });

    it("サービス定義の誤りは、home からの相対パスで知らせる", () => {
      write("services/x.yaml", stringify({ ...x, hosts: ["*"] }));
      const [issue] = issuesOf(load());
      expect(issue?.code).toBe("E-010");
      expect(issue?.source).toBe("services/x.yaml");
    });

    it("services/ の .yml は E-013", () => {
      write("services/x.yml", stringify(x));
      const [issue] = issuesOf(load());
      expect(issue?.code).toBe("E-013");
      expect(issue?.source).toBe("services/x.yml");
    });

    it("組み込みの場所を変えられる（テスト・パッケージにしたとき用）", () => {
      const dir = join(userHome, "builtin");
      mkdirSync(dir);
      for (const file of ["github.yaml", "web.yaml"]) {
        writeFileSync(join(dir, file), readFileSync(join(builtinServicesDir(), file)));
      }
      const result = load({ builtinServicesDir: dir });
      expect(result.ok && result.config.services.map((s) => s.id)).toEqual(["github", "web"]);
    });
  });

  describe("プロンプトとスキル", () => {
    it("5.4.3：使われている役職の md がなければ E-001", () => {
      rmSync(join(home, "prompts/roles/researcher.md"));
      const [issue] = issuesOf(load());
      expect(issue?.code).toBe("E-001");
      expect(issue?.message).toContain("prompts/roles/researcher.md");
    });

    it("md 以外のファイルは読まない", () => {
      write("prompts/notes.txt", "x");
      const result = load();
      expect(result.ok && [...result.config.prompts.keys()].sort()).toEqual([
        "company.md",
        "roles/implementer.md",
        "roles/researcher.md",
      ]);
    });

    it.skipIf(process.platform === "win32")(
      "prompts の中のシンボリックリンクは E-013（secrets.json などを指して、箱の中に持ち込ませない）",
      () => {
        write("secrets.json", "{}");
        rmSync(join(home, "prompts/roles/researcher.md"));
        symlinkSync(join(home, "secrets.json"), join(home, "prompts/roles/researcher.md"));
        const result = load();
        expect(result.ok).toBe(false);
        expect(issuesOf(result).map((i) => `${i.code} ${i.source}`)).toContain(
          "E-013 prompts/roles/researcher.md",
        );
      },
    );

    it("skills/ の下のフォルダを、役職の skills と照らし合わせる", () => {
      const roles = {
        ...baseRoles,
        implementer: { ...baseRoles.implementer, skills: ["git-workflow"] },
      };
      write("roles.yaml", stringify({ roles }));
      expect(issuesOf(load()).map((i) => i.code)).toEqual(["E-001"]);
      mkdirSync(join(home, "skills/git-workflow"), { recursive: true });
      expect(issuesOf(load())).toEqual([]);
    });
  });

  describe("E-008：secrets.json の権限（5.2.8）", () => {
    it.skipIf(process.platform === "win32")("0600 でなければエラー、0600 ならよい", () => {
      write("secrets.json", "{}");
      chmodSync(join(home, "secrets.json"), 0o644);
      const result = loadConfig(home, { userHome });
      expect(issuesOf(result).map((i) => i.code)).toEqual(["E-008"]);
      chmodSync(join(home, "secrets.json"), 0o600);
      expect(loadConfig(home, { userHome }).ok).toBe(true);
    });

    it("secrets.json がなければ、確かめるものがないのでよい", () => {
      expect(existsSync(join(home, "secrets.json"))).toBe(false);
      expect(loadConfig(home, { userHome, checkSecretsMode: true }).ok).toBe(true);
    });

    it("Windows（checkSecretsMode: false）では権限を確かめない", () => {
      write("secrets.json", "{}");
      expect(load({ checkSecretsMode: false }).ok).toBe(true);
    });
  });

  it("daemon.home の ~ は userHome で展開して、実際の置き場所と比べる", () => {
    write("aicoop.yaml", stringify({ company: COMPANY, daemon: { home: "~/.aicoop" } }));
    expect(load().ok).toBe(true);
    write("aicoop.yaml", stringify({ company: COMPANY, daemon: { home: "~/elsewhere" } }));
    expect(issuesOf(load()).map((i) => `${i.code} ${i.path}`)).toEqual(["E-013 daemon.home"]);
  });
});
