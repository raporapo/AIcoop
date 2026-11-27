import { describe, expect, it } from "vitest";
import { GITHUB_TEMPLATE_VARIABLES, parseTemplate, templateVariablesFor } from "./template.ts";

describe("6.6 github トリガーのテンプレート変数", () => {
  it("外の人が書いた文章（表の *）には external が付く（プロンプトで囲むため。5.4.3 の4）", () => {
    const external = Object.values(GITHUB_TEMPLATE_VARIABLES)
      .flat()
      .filter((v) => v.external)
      .map((v) => v.name);
    expect(new Set(external)).toEqual(
      new Set([
        "issue.title",
        "issue.body",
        "comment.body",
        "pull_request.title",
        "pull_request.body",
        "head_commit.message",
      ]),
    );
  });

  it("複数のイベントを受けるときは、どのイベントでも使える変数だけ", () => {
    expect([...templateVariablesFor(["issues.labeled"]).keys()]).toContain("label.name");
    expect([...templateVariablesFor(["issues.opened", "issues.labeled"]).keys()]).not.toContain(
      "label.name",
    );
    expect([...templateVariablesFor(["push", "pull_request.opened"]).keys()]).toEqual([
      "repository.full_name",
    ]);
  });

  it("テンプレートの変数名を取り出し、組にならない {{ }} を見つける", () => {
    expect(parseTemplate("Issue #{{issue.number}} と {{ issue.title }}")).toEqual({
      names: ["issue.number", "issue.title"],
      malformed: false,
    });
    expect(parseTemplate("issue-{{issue.number").malformed).toBe(true);
    expect(parseTemplate("x}}").malformed).toBe(true);
    expect(parseTemplate("{ だけなら文字のまま }").malformed).toBe(false);
  });
});
