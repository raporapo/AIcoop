import { describe, expect, it } from "vitest";
import { identifyOperations } from "./operation.ts";
import { createServiceCatalog, parseServiceDefinition, type ServiceDefinition } from "./service.ts";

function service(input: unknown): ServiceDefinition {
  const result = parseServiceDefinition(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

const catalog = createServiceCatalog([
  service({
    id: "github",
    hosts: ["api.github.com", "github.com"],
    params: { repo: 2 },
    secret: { env: "GITHUB_TOKEN", kind: "github_app", header: "authorization" },
    operations: {
      "repo.read": {
        match: [
          { method: ["GET", "HEAD"], host: "api.github.com", path: "/repos/{repo}/**" },
          { method: "GET", host: "github.com", path: "/{repo}.git/info/refs" },
        ],
      },
      "git.push": {
        match: [
          { method: "GET", host: "github.com", path: "/{repo}.git/info/refs" },
          { method: "POST", host: "github.com", path: "/{repo}.git/git-receive-pack" },
        ],
      },
    },
  }),
  service({
    id: "web",
    hosts: ["*"],
    operations: { read: { match: [{ method: ["GET", "HEAD"], path: "/**" }] } },
  }),
]);

const ids = (req: { method: string; host: string; path: string }) =>
  identifyOperations(catalog, req).map((m) => m.operation.id);

// 操作の特定（5.2.4 の1）
describe("identifyOperations", () => {
  it("ホストと match に一致する操作を返し、パラメーターを取り出す", () => {
    const matches = identifyOperations(catalog, {
      method: "POST",
      host: "github.com",
      path: "/myorg/app.git/git-receive-pack",
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.operation.id).toBe("github.git.push");
    expect(matches[0]?.operation.service).toBe("github");
    expect(matches[0]?.operation.name).toBe("git.push");
    expect(matches[0]?.params).toEqual({ repo: "myorg/app" });
  });

  it("一致する操作が複数あれば、定義の順にすべて返す", () => {
    expect(ids({ method: "GET", host: "github.com", path: "/myorg/app.git/info/refs" })).toEqual([
      "github.repo.read",
      "github.git.push",
    ]);
  });

  it("match の host が違えば一致しない", () => {
    expect(ids({ method: "GET", host: "github.com", path: "/repos/myorg/app" })).toEqual([]);
  });

  it("メソッドは完全一致（小文字は一致しない）", () => {
    expect(ids({ method: "DELETE", host: "api.github.com", path: "/repos/myorg/app" })).toEqual([]);
    expect(ids({ method: "get", host: "api.github.com", path: "/repos/myorg/app" })).toEqual([]);
  });

  it("ホスト名の大文字・小文字と、末尾の . は区別しない", () => {
    expect(ids({ method: "GET", host: "API.GitHub.com.", path: "/repos/myorg/app" })).toEqual([
      "github.repo.read",
    ]);
  });

  describe("web の *", () => {
    it("ほかのサービスの hosts に入っているホストを含まない（6.7）", () => {
      expect(ids({ method: "GET", host: "api.github.com", path: "/zen" })).toEqual([]);
      expect(ids({ method: "GET", host: "API.GITHUB.COM.", path: "/zen" })).toEqual([]);
    });

    it("それ以外のホストには一致する", () => {
      expect(ids({ method: "GET", host: "example.com", path: "/" })).toEqual(["web.read"]);
    });
  });

  it("解釈が分かれるパスは、どの操作にも一致しない", () => {
    expect(
      ids({ method: "GET", host: "api.github.com", path: "/repos/myorg/app/../../o/secret" }),
    ).toEqual([]);
  });
});
