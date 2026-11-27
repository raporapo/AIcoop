import { describe, expect, it } from "vitest";
import { compilePathPattern, PathPatternError } from "./path-pattern.ts";

const params = { repo: 2 };

// パスの書き方（5.2.3 の3・4、6.7 の注記）
describe("compilePathPattern", () => {
  describe("文字だけのパターン", () => {
    const p = compilePathPattern("/gmail/v1/users/me/messages/send", {});

    it("同じパスに一致し、パラメーターは空", () => {
      expect(p.match("/gmail/v1/users/me/messages/send")).toEqual({});
    });

    it("1文字でも違えば一致しない", () => {
      expect(p.match("/gmail/v1/users/me/messages/sendx")).toBeNull();
      expect(p.match("/gmail/v1/users/me/messages")).toBeNull();
    });

    it("クエリ文字列は照合に使わない", () => {
      expect(p.match("/gmail/v1/users/me/messages/send?uploadType=media")).toEqual({});
    });
  });

  describe("* はパスの1区切り", () => {
    const p = compilePathPattern("/repos/{repo}/issues/*/comments", params);

    it("1区切りに一致する", () => {
      expect(p.match("/repos/myorg/app/issues/42/comments")).toEqual({ repo: "myorg/app" });
    });

    it("空の区切りや、2区切り以上には一致しない", () => {
      expect(p.match("/repos/myorg/app/issues//comments")).toBeNull();
      expect(p.match("/repos/myorg/app/issues/4/2/comments")).toBeNull();
    });
  });

  describe("** はパスの0個以上の区切り（末尾だけ）", () => {
    const p = compilePathPattern("/repos/{repo}/**", params);

    it("その手前までのパスそのものにも一致する", () => {
      expect(p.match("/repos/myorg/app")).toEqual({ repo: "myorg/app" });
    });

    it("下の階層にも一致する", () => {
      expect(p.match("/repos/myorg/app/contents/src/index.ts")).toEqual({ repo: "myorg/app" });
    });

    it("手前の区切りが足りなければ一致しない", () => {
      expect(p.match("/repos/myorg")).toBeNull();
    });

    it("/** だけのパターンは、すべてのパスに一致する", () => {
      const all = compilePathPattern("/**", {});
      expect(all.match("/")).toEqual({});
      expect(all.match("/a/b/c")).toEqual({});
    });
  });

  describe("{name} は params で決めた数の区切りを取る", () => {
    it("{repo} は2区切り（owner/name）", () => {
      const p = compilePathPattern("/repos/{repo}/pulls", params);
      expect(p.match("/repos/myorg/app/pulls")).toEqual({ repo: "myorg/app" });
      expect(p.match("/repos/myorg/pulls")).toBeNull();
    });

    it("区切りの途中に文字が続いてもよい（/{repo}.git/...）", () => {
      const p = compilePathPattern("/{repo}.git/info/refs", params);
      expect(p.match("/myorg/app.git/info/refs")).toEqual({ repo: "myorg/app" });
      expect(p.match("/myorg/app.js.git/info/refs")).toEqual({ repo: "myorg/app.js" });
      expect(p.match("/myorg/app/info/refs")).toBeNull();
    });
  });

  describe("解釈が分かれるパスは、どのパターンにも一致させない（書いていないことは禁止 P-3）", () => {
    const p = compilePathPattern("/repos/{repo}/**", params);

    it.each([
      ["..の区切り", "/repos/myorg/app/../../other/secret/contents/x"],
      [".の区切り", "/repos/myorg/app/./contents"],
      ["%2e%2e（エンコードした ..）", "/repos/myorg/app/%2e%2e/%2E%2E/other/secret"],
      ["%2f（エンコードした /）", "/repos/myorg%2fapp/contents"],
      ["%5c（エンコードした \\）", "/repos/myorg/app/%5ccontents"],
      ["\\ を含む", "/repos/myorg/app\\..\\x"],
      ["制御文字を含む", "/repos/myorg/app/\n/x"],
      ["/ で始まらない", "repos/myorg/app"],
    ])("%s", (_label, path) => {
      expect(p.match(path)).toBeNull();
    });
  });

  describe("書き方の誤りは、作るときにエラーにする", () => {
    it.each([
      ["** が末尾以外にある", "/repos/**/pulls"],
      ["** が区切りの一部になっている", "/repos/a**"],
      ["* が区切りの一部になっている", "/repos/a*/pulls"],
      ["/ で始まらない", "repos/{repo}"],
      ["params にないパラメーター", "/orgs/{org}/repos"],
      ["同じパラメーターが2回", "/{repo}/x/{repo}"],
      ["閉じていない {", "/repos/{repo/pulls"],
    ])("%s", (_label, pattern) => {
      expect(() => compilePathPattern(pattern, params)).toThrow(PathPatternError);
    });
  });
});
