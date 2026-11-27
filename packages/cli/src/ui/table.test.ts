import { describe, expect, it } from "vitest";
import { createStyle } from "./style.ts";
import { renderTable } from "./table.ts";
import { displayWidth } from "./text.ts";

const plain = createStyle(false);

describe("表（端末で列をそろえる）", () => {
  it("全角を含んでも列がそろう", () => {
    const lines = renderTable(
      [{ header: "ID" }, { header: "部署" }, { header: "状態" }],
      [
        ["t_1", "開発部", "実行中"],
        ["t_22", "sales", "done"],
      ],
      { style: plain },
    );
    expect(lines).toHaveLength(3);
    // 2列目の始まりの位置が、どの行でも同じ
    const starts = lines.map((l) =>
      displayWidth(l.slice(0, l.indexOf(l.trim().split(/\s{2,}/)[1] ?? ""))),
    );
    expect(new Set(starts).size).toBe(1);
    expect(lines[0]).toMatch(/^ID\s+部署\s+状態$/);
  });

  it("flex の列は、端末の幅に収まるように切る", () => {
    const lines = renderTable(
      [{ header: "ID" }, { header: "目的", flex: true }],
      [["t_1", "とても長い目的の文章がここに入って端末の幅を超えてしまう"]],
      { style: plain, width: 30 },
    );
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(30);
    expect(lines[1]).toContain("…");
  });

  it("幅が分からない（パイプ）ときは切らない", () => {
    const long = "あ".repeat(100);
    const lines = renderTable([{ header: "目的", flex: true }], [[long]], { style: plain });
    expect(lines[1]).toContain(long);
  });

  it("右寄せの列", () => {
    const lines = renderTable(
      [{ header: "状態" }, { header: "件数", align: "right" }],
      [
        ["queued", "3"],
        ["done", "120"],
      ],
      { style: plain },
    );
    expect(lines[1]?.endsWith("  3")).toBe(true);
    expect(lines[2]?.endsWith("120")).toBe(true);
  });
});
