import { describe, expect, it } from "vitest";
import { identifyOperations, type RequestTarget } from "./operation.ts";
import { createServiceCatalog, validateServiceCatalog } from "./service.ts";
import { loadBuiltinServices } from "./testing/builtin-services.ts";

const definitions = loadBuiltinServices();
const catalog = createServiceCatalog(definitions);
const ids = (req: RequestTarget) => identifyOperations(catalog, req).map((m) => m.operation.id);

// 組み込みのサービス定義（5.2.3 の6、6.7）
describe("組み込みのサービス定義", () => {
  it("github・gmail・web の3つがあり、設定の検証でエラーにならない", () => {
    expect(definitions.map((d) => d.id)).toEqual(["github", "gmail", "web"]);
    expect(validateServiceCatalog(definitions)).toEqual([]);
  });

  describe("github", () => {
    it("git push の流れ（info/refs と git-receive-pack）は github.git.push で、repo が取れる", () => {
      const refs = identifyOperations(catalog, {
        method: "GET",
        host: "github.com",
        path: "/myorg/app.git/info/refs?service=git-receive-pack",
      });
      expect(refs.map((m) => m.operation.id)).toContain("github.git.push");
      expect(refs.every((m) => m.params.repo === "myorg/app")).toBe(true);

      expect(
        ids({ method: "POST", host: "github.com", path: "/myorg/app.git/git-receive-pack" }),
      ).toEqual(["github.git.push"]);
    });

    it("git clone / fetch（git-upload-pack）は github.repo.read", () => {
      expect(
        ids({ method: "POST", host: "github.com", path: "/myorg/app.git/git-upload-pack" }),
      ).toEqual(["github.repo.read"]);
    });

    it("API の GET /repos/{repo} とその下は github.repo.read", () => {
      expect(ids({ method: "GET", host: "api.github.com", path: "/repos/myorg/app" })).toEqual([
        "github.repo.read",
      ]);
      expect(
        ids({ method: "GET", host: "api.github.com", path: "/repos/myorg/app/issues/42" }),
      ).toEqual(["github.repo.read"]);
    });

    it("PRのマージは github.pr.merge で、保留の要約は github_pr_merge", () => {
      const [m] = identifyOperations(catalog, {
        method: "PUT",
        host: "api.github.com",
        path: "/repos/myorg/app/pulls/7/merge",
      });
      expect(m?.operation.id).toBe("github.pr.merge");
      expect(m?.operation.summary).toBe("github_pr_merge");
    });
  });

  describe("gmail", () => {
    it("下書きの送信（drafts/send）も gmail.message.send で、要約は gmail_message", () => {
      const [m] = identifyOperations(catalog, {
        method: "POST",
        host: "gmail.googleapis.com",
        path: "/gmail/v1/users/me/drafts/send",
      });
      expect(m?.operation.id).toBe("gmail.message.send");
      expect(m?.operation.summary).toBe("gmail_message");
    });

    it("メールの読み取りは gmail.message.read", () => {
      expect(
        ids({
          method: "GET",
          host: "gmail.googleapis.com",
          path: "/gmail/v1/users/me/messages/abc?format=full",
        }),
      ).toEqual(["gmail.message.read"]);
    });
  });

  describe("web", () => {
    it("ほかのホストへの GET・HEAD は web.read", () => {
      expect(ids({ method: "GET", host: "example.com", path: "/news?q=1" })).toEqual(["web.read"]);
      expect(ids({ method: "HEAD", host: "example.com", path: "/" })).toEqual(["web.read"]);
    });

    it("POST は web.read にならない", () => {
      expect(ids({ method: "POST", host: "example.com", path: "/" })).toEqual([]);
    });

    it.each(["api.github.com", "github.com", "gmail.googleapis.com"])(
      "資格を使うサービスのホスト %s は含まない（資格の制限を回り道させない。6.7）",
      (host) => {
        expect(ids({ method: "GET", host, path: "/zen" })).not.toContain("web.read");
      },
    );
  });
});
