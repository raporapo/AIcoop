import { describe, expect, it } from "vitest";
import { matchesGlob } from "./glob.ts";

// パラメーターの値の照合：glob で、* は任意の文字列（5.2.4 の3）
describe("matchesGlob", () => {
  it("* のない glob は完全一致", () => {
    expect(matchesGlob("myorg/app", "myorg/app")).toBe(true);
    expect(matchesGlob("myorg/app", "myorg/app2")).toBe(false);
    expect(matchesGlob("myorg/app", "xmyorg/app")).toBe(false);
  });

  it("* は / を含む任意の文字列に一致する", () => {
    expect(matchesGlob("myorg/*", "myorg/app")).toBe(true);
    expect(matchesGlob("*", "owner/name")).toBe(true);
    expect(matchesGlob("my*/app", "myorg/app")).toBe(true);
  });

  it("前方が違えば一致しない", () => {
    expect(matchesGlob("myorg/*", "other/app")).toBe(false);
    expect(matchesGlob("myorg/*", "myorg2/app")).toBe(false);
  });

  it("正規表現の記号は文字そのものとして扱う", () => {
    expect(matchesGlob("my.org/app", "my.org/app")).toBe(true);
    expect(matchesGlob("my.org/app", "myxorg/app")).toBe(false);
    expect(matchesGlob("a+b/(c)", "a+b/(c)")).toBe(true);
  });

  it("大文字と小文字は区別する（一致しなければ拒否側に倒れるので安全）", () => {
    expect(matchesGlob("myorg/app", "MyOrg/App")).toBe(false);
  });
});
