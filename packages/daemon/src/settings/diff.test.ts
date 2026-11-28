import { describe, expect, it } from "vitest";
import { unifiedDiff } from "./diff.ts";

describe("5.14 の4の3：変更の差分（unified diff）", () => {
  it("変えた行と、前後3行を出す", () => {
    const before = `${["a", "b", "c", "d", "e", "f", "g", "h", "i"].join("\n")}\n`;
    const after = `${["a", "b", "c", "d", "E", "f", "g", "h", "i"].join("\n")}\n`;
    expect(unifiedDiff("groups.yaml", before, after)).toBe(
      [
        "--- a/groups.yaml",
        "+++ b/groups.yaml",
        "@@ -2,7 +2,7 @@",
        " b",
        " c",
        " d",
        "-e",
        "+E",
        " f",
        " g",
        " h",
        "",
      ].join("\n"),
    );
  });

  it("新しいファイルは /dev/null から", () => {
    expect(unifiedDiff("prompts/members/x.md", null, "一行目\n二行目\n")).toBe(
      [
        "--- /dev/null",
        "+++ b/prompts/members/x.md",
        "@@ -0,0 +1,2 @@",
        "+一行目",
        "+二行目",
        "",
      ].join("\n"),
    );
  });

  it("離れた2か所の変更は、2つの塊にする", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
    const changed = [...lines];
    changed[1] = "X";
    changed[17] = "Y";
    const diff = unifiedDiff("roles.yaml", `${lines.join("\n")}\n`, `${changed.join("\n")}\n`);
    expect(diff.match(/^@@ /gm)).toHaveLength(2);
    expect(diff).toContain("@@ -1,5 +1,5 @@");
    expect(diff).toContain("@@ -15,6 +15,6 @@");
  });

  it("行を足す・消す", () => {
    const diff = unifiedDiff("a.yaml", "a\nb\nc\n", "a\nc\nd\n");
    expect(diff).toBe(
      ["--- a/a.yaml", "+++ b/a.yaml", "@@ -1,3 +1,3 @@", " a", "-b", " c", "+d", ""].join("\n"),
    );
  });

  it("最後に改行がないことを示す", () => {
    const diff = unifiedDiff("a.yaml", "a\n", "a");
    expect(diff).toContain("\\ No newline at end of file");
  });

  it("同じ中身なら、見出しだけ", () => {
    expect(unifiedDiff("a.yaml", "a\n", "a\n")).toBe("--- a/a.yaml\n+++ b/a.yaml\n");
  });

  it("CRLF の違いも差分に出る", () => {
    const diff = unifiedDiff("a.yaml", "a\r\nb\r\n", "a\nb\n");
    expect(diff).toContain("-a\r");
    expect(diff).toContain("+a");
  });
});
