import { readFileSync } from "node:fs";
import { templatesDir } from "@aicoop/shared";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { replacePlaceholderRepositories, setCompanyName, YamlEditError } from "./yaml-edit.ts";

const template = (name: string) => readFileSync(`${templatesDir()}/${name}`, "utf8");

const changedLines = (before: string, after: string) => {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b.length).toBe(a.length);
  return a.flatMap((line, i) => (line === b[i] ? [] : [i]));
};

describe("5.14 の3の3：groups.yaml の your-org を書き換える（コメントと並びを保つ）", () => {
  it("雛形の your-org/* を、入れたリポジトリに置き換える。ほかの行（コメント・コメントにした your-org）はそのまま", () => {
    const before = template("groups.yaml");
    const result = replacePlaceholderRepositories(before, ["raporapo/*", "me/app"]);
    expect(result.replaced).toBe(3);
    const lines = changedLines(before, result.content);
    expect(lines).toHaveLength(3);
    for (const i of lines) {
      expect(result.content.split("\n")[i]).toContain('repo: ["raporapo/*", "me/app"]');
    }
    // コメントの中の your-org は書き換えない（読み込みでは無視される）
    expect(result.content).toContain("# 「your-org」を、自分の GitHub のユーザー名か組織名に");
    expect(result.content).toContain(
      '#   - { op: "github.git.push", params: { repo: ["your-org/*"] } }',
    );
    const parsed = parse(result.content) as {
      groups: { dev: { ceiling: Array<{ params?: { repo?: string[] } }> } };
    };
    expect(parsed.groups.dev.ceiling.map((c) => c.params?.repo)).toEqual([
      ["raporapo/*", "me/app"],
      ["raporapo/*", "me/app"],
      ["raporapo/*", "me/app"],
    ]);
  });

  it("your-org でないリポジトリは残し、重ねて書かない", () => {
    const before =
      "groups:\n  dev:\n    ceiling:\n      - { op: github.repo.read, params: { repo: [mine/x, your-org/*, your-org/app] } }\n";
    const result = replacePlaceholderRepositories(before, ["mine/x", "raporapo/*"]);
    const parsed = parse(result.content) as {
      groups: { dev: { ceiling: Array<{ params: { repo: string[] } }> } };
    };
    expect(parsed.groups.dev.ceiling[0]?.params.repo).toEqual(["mine/x", "raporapo/*"]);
  });

  it("block の並び（- の行）は、同じ字下げの block で書く。続く行とコメントはそのまま", () => {
    const before =
      "groups:\n  dev:\n    ceiling:\n      - op: github.repo.read\n        params:\n          repo:\n            - your-org/*\n            - mine/x # 自分の\n      - op: web.read\n# おわり\n";
    const result = replacePlaceholderRepositories(before, ["raporapo/*", "me/app"]);
    expect(result.content).toBe(
      'groups:\n  dev:\n    ceiling:\n      - op: github.repo.read\n        params:\n          repo:\n            - "mine/x"\n            - "raporapo/*"\n            - "me/app" # 自分の\n      - op: web.read\n# おわり\n',
    );
  });

  it("your-org が残っていなければ失敗（何も書き換えない）", () => {
    const before =
      'groups:\n  dev:\n    ceiling:\n      - { op: github.repo.read, params: { repo: ["mine/*"] } }\n';
    expect(() => replacePlaceholderRepositories(before, ["raporapo/*"])).toThrow(YamlEditError);
  });

  it("読めない yaml は失敗", () => {
    expect(() => replacePlaceholderRepositories("groups: [\n", ["a/b"])).toThrow(YamlEditError);
  });
});

describe("5.14 の3の1：aicoop.yaml の company.name を書き換える", () => {
  const aicoop = template("aicoop.yaml")
    .replaceAll("{{company_id}}", "c_01JD6V8X3S0Q5W7KQ9M2T4R6YB")
    .replaceAll("{{company_name}}", "わたしの会社");

  it("名前の行だけを変え、コメントは残す", () => {
    const after = setCompanyName(aicoop, "サンプル商会");
    const lines = changedLines(aicoop, after);
    expect(lines).toHaveLength(1);
    expect((parse(after) as { company: { name: string } }).company.name).toBe("サンプル商会");
    expect((parse(after) as { company: { id: string } }).company.id).toBe(
      "c_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
    );
  });

  it("yaml で意味を持つ文字（: # \" '）を含む名前も、そのまま読み直せる", () => {
    for (const name of ["A: B #c \"d\" 'e'", "- x", "*alias", "{a}", "123"]) {
      const after = setCompanyName(aicoop, name);
      expect((parse(after) as { company: { name: unknown } }).company.name).toBe(name);
    }
  });

  it("company がない・読めない yaml は失敗", () => {
    expect(() => setCompanyName("aicoop: 1\n", "x")).toThrow(YamlEditError);
    expect(() => setCompanyName("company: [\n", "x")).toThrow(YamlEditError);
  });
});
