import { describe, expect, it } from "vitest";
import { suggest } from "./suggest.ts";

const commands = ["init", "check", "status", "start", "stop", "tasks", "logs", "cancel", "run"];

describe("11.7：打ち間違いに「もしかして」を出す", () => {
  it("1文字の打ち間違い・抜け・入れ替わりを拾う", () => {
    expect(suggest("statsu", commands)).toContain("status");
    expect(suggest("chek", commands)).toEqual(["check"]);
    expect(suggest("taks", commands)).toEqual(["tasks"]);
    expect(suggest("canecl", commands)).toEqual(["cancel"]);
  });

  it("近いものを近い順に、3つまで出す", () => {
    const out = suggest("stat", commands);
    expect(out[0]).toBe("start");
    expect(out).toContain("status");
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it("全角や大文字で打ったものも拾う", () => {
    expect(suggest("ｒｕｎ", commands)).toEqual(["run"]);
    expect(suggest("INIT", commands)).toEqual(["init"]);
  });

  it("似ていないものは出さない", () => {
    expect(suggest("deploy", commands)).toEqual([]);
    expect(suggest("x", commands)).toEqual([]);
  });

  it("候補がなければ空", () => {
    expect(suggest("run", [])).toEqual([]);
  });
});
