import { describe, expect, it } from "vitest";
import {
  overrideServices,
  parseServiceDefinition,
  parseServiceYaml,
  type ServiceDefinition,
  validateServiceCatalog,
} from "./service.ts";

/** テスト用：必ず読める定義を作る */
function service(input: unknown): ServiceDefinition {
  const result = parseServiceDefinition(input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

const gmailLike = {
  id: "gmail",
  hosts: ["gmail.googleapis.com"],
  secret: { env: "GMAIL_ACCESS_TOKEN", kind: "google_oauth", header: "authorization" },
  operations: {
    "message.read": {
      match: [{ method: "GET", path: "/gmail/v1/users/me/messages/**" }],
      tags: ["reads_internal"],
    },
    "message.send": {
      match: [{ method: "POST", path: "/gmail/v1/users/me/messages/send" }],
      tags: ["sends_external"],
      summary: "gmail_message",
    },
  },
};

// サービス定義の形式（5.2.3 の2）
describe("parseServiceDefinition", () => {
  it("5.2.3 の形式を読み、省略したキーに既定値を入れる", () => {
    const def = service({
      id: "web",
      hosts: ["*"],
      operations: { read: { match: [{ method: ["GET", "HEAD"], path: "/**" }] } },
    });
    expect(def.params).toEqual({});
    expect(def.secret).toBeNull();
    expect(def.operations.read?.tags).toEqual([]);
  });

  it("method は1つでも配列でも書け、読んだあとは配列にそろう", () => {
    const def = service(gmailLike);
    expect(def.operations["message.read"]?.match[0]?.method).toEqual(["GET"]);
  });

  it("ホスト名は小文字にそろえる", () => {
    const def = service({ ...gmailLike, hosts: ["Gmail.GoogleAPIs.com"] });
    expect(def.hosts).toEqual(["gmail.googleapis.com"]);
  });

  describe("形式の誤りは E-013 として返す", () => {
    const op = (over: Record<string, unknown>) => ({
      ...gmailLike,
      operations: { "message.read": { match: [{ method: "GET", path: "/x" }], ...over } },
    });

    it.each([
      ["id に大文字", { ...gmailLike, id: "Gmail" }],
      ["hosts が空", { ...gmailLike, hosts: [] }],
      ["知らないメソッド", op({ match: [{ method: "FETCH", path: "/x" }] })],
      ["知らないタグ", op({ tags: ["reads_everything"] })],
      ["知らない summary", op({ summary: "fax_message" })],
      ["match が空", op({ match: [] })],
      ["** が途中にあるパス", op({ match: [{ method: "GET", path: "/a/**/b" }] })],
      ["params にないパラメーター", op({ match: [{ method: "GET", path: "/repos/{repo}" }] })],
      [
        "match の host がサービスの hosts にない",
        op({ match: [{ method: "GET", host: "evil.example.com", path: "/x" }] }),
      ],
      ["知らない secret.kind", { ...gmailLike, secret: { ...gmailLike.secret, kind: "password" } }],
      [
        "secret.env が環境変数の名前として不正",
        { ...gmailLike, secret: { ...gmailLike.secret, env: "gmail-token" } },
      ],
      ["操作名に大文字", { ...gmailLike, operations: { "Message.Read": {} } }],
    ])("%s", (_label, input) => {
      const result = parseServiceDefinition(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues.every((i) => i.code === "E-013")).toBe(true);
      }
    });
  });
});

describe("parseServiceYaml", () => {
  it("YAML の文字列から読む", () => {
    const result = parseServiceYaml(
      "id: web\nhosts: ['*']\nsecret: null\noperations:\n  read:\n    match: [{ method: GET, path: '/**' }]\n",
      "web.yaml",
    );
    expect(result.ok).toBe(true);
  });

  it("YAML として読めなければ E-013 を返し、どのファイルかを書く", () => {
    const result = parseServiceYaml("id: [unclosed", "broken.yaml");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe("E-013");
      expect(result.issues[0]?.source).toBe("broken.yaml");
    }
  });
});

// 組み込みとオーナーの定義（5.2.3 の1）
describe("overrideServices", () => {
  const builtinGmail = service(gmailLike);
  const builtinWeb = service({
    id: "web",
    hosts: ["*"],
    operations: { read: { match: [{ method: "GET", path: "/**" }] } },
  });

  it("同じ id があれば、オーナーの定義が組み込みを丸ごと上書きする", () => {
    const ownerGmail = service({
      ...gmailLike,
      operations: { "draft.create": { match: [{ method: "POST", path: "/drafts" }] } },
    });
    const merged = overrideServices([builtinGmail, builtinWeb], [ownerGmail]);
    expect(merged.map((s) => s.id)).toEqual(["gmail", "web"]);
    // 組み込みの操作は1つも残らない
    expect(Object.keys(merged[0]?.operations ?? {})).toEqual(["draft.create"]);
  });

  it("新しい id は後ろに足す", () => {
    const x = service({
      id: "x",
      hosts: ["api.x.com"],
      operations: { "post.create": { match: [{ method: "POST", path: "/2/tweets" }] } },
    });
    expect(overrideServices([builtinGmail], [x]).map((s) => s.id)).toEqual(["gmail", "x"]);
  });
});

// 設定の検証のうち、サービス定義どうしに関わるもの（6.10）
describe("validateServiceCatalog", () => {
  it("E-010：web 以外のサービスの hosts に * がある", () => {
    const bad = service({ ...gmailLike, hosts: ["*"] });
    expect(validateServiceCatalog([bad]).map((i) => i.code)).toEqual(["E-010"]);
  });

  it("web の * はエラーにしない", () => {
    const web = service({
      id: "web",
      hosts: ["*"],
      operations: { read: { match: [{ method: "GET", path: "/**" }] } },
    });
    expect(validateServiceCatalog([web])).toEqual([]);
  });

  it("E-011：secret を持つサービスどうしで hosts が重なっている", () => {
    const a = service(gmailLike);
    const b = service({ ...gmailLike, id: "gmail2" });
    expect(validateServiceCatalog([a, b]).map((i) => i.code)).toEqual(["E-011"]);
  });

  it("secret を持たないサービスとの重なりはエラーにしない", () => {
    const a = service(gmailLike);
    const b = service({ ...gmailLike, id: "gmail-public", secret: null });
    expect(validateServiceCatalog([a, b])).toEqual([]);
  });
});
