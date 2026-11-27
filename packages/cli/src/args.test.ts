import { describe, expect, it } from "vitest";
import { type ArgSpec, parseCommandArgs } from "./args.ts";
import { UsageError } from "./errors.ts";

const spec: ArgSpec = {
  options: [
    { name: "purpose", type: "string", value: "<文>", description: "目的" },
    { name: "done-when", type: "string", value: "<文>", description: "完了の条件" },
    { name: "timeout", type: "string", value: "<分>", description: "時間制限" },
    { name: "wait", type: "boolean", description: "終わるまで待つ" },
    { name: "help", short: "h", type: "boolean", description: "使い方" },
  ],
  positionals: [{ name: "member", required: true, description: "社員" }],
};

function parse(args: string[]) {
  return parseCommandArgs("run", spec, args);
}

function usageError(args: string[]): UsageError {
  try {
    parse(args);
  } catch (e) {
    if (e instanceof UsageError) return e;
    throw e;
  }
  throw new Error("UsageError になりませんでした");
}

describe("引数の読み取り（node:util の parseArgs）", () => {
  it("オプションと位置の引数を読む。= でつないでもよい", () => {
    const r = parse(["dev-implementer", "--purpose", "README を直す", "--done-when=PRを出した"]);
    expect(r.positionals).toEqual(["dev-implementer"]);
    expect(r.values.purpose).toBe("README を直す");
    expect(r.values["done-when"]).toBe("PRを出した");
    expect(r.values.wait).toBeUndefined();
  });

  it("-h は --help", () => {
    expect(parse(["-h"]).values.help).toBe(true);
  });

  it("-- のあとは、- で始まってもオプションとして読まない", () => {
    const r = parse(["--purpose", "p", "--", "-x"]);
    expect(r.positionals).toEqual(["-x"]);
  });

  it("値が - で始まる文（箇条書きなど）は受け付ける", () => {
    expect(parse(["m", "--purpose", "- 一つ目"]).values.purpose).toBe("- 一つ目");
  });

  it("help のときは、足りない引数を責めない", () => {
    expect(parse(["--help"]).values.help).toBe(true);
  });
});

describe("11.7：使い方の誤りは日本語で、直し方を添える（終了コード 2）", () => {
  it("知らないオプションには「もしかして」を出す", () => {
    const e = usageError(["m", "--purpse", "x"]);
    expect(e.exitCode).toBe(2);
    expect(e.headline).toContain("--purpse");
    expect(e.hints.join("\n")).toContain("もしかして --purpose");
  });

  it("知らない短いオプション", () => {
    expect(usageError(["m", "-x"]).headline).toContain("-x");
  });

  it("値の要るオプションに値がない", () => {
    expect(usageError(["m", "--purpose"]).headline).toContain("--purpose の値がありません");
    // 次のオプションを値として食べない
    expect(usageError(["m", "--purpose", "--done-when", "x"]).headline).toContain(
      "--purpose の値がありません",
    );
  });

  it("値をとらないオプションに値を付けた", () => {
    expect(usageError(["m", "--wait=yes"]).headline).toContain("--wait は値をとりません");
  });

  it("同じオプションを2回書いた", () => {
    expect(usageError(["m", "--purpose", "a", "--purpose", "b"]).headline).toContain("2回");
  });

  it("必須の位置の引数がない", () => {
    const e = usageError(["--purpose", "p"]);
    expect(e.headline).toContain("<member>");
  });

  it("必須のオプションがない", () => {
    const required: ArgSpec = {
      options: [
        { name: "kind", type: "string", value: "<kind>", description: "種類", required: true },
      ],
      positionals: [],
    };
    try {
      parseCommandArgs("secret set", required, []);
      throw new Error("通ってしまった");
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      expect((e as UsageError).headline).toContain("--kind がありません");
    }
    expect(parseCommandArgs("secret set", required, ["--kind", "x"]).values.kind).toBe("x");
  });

  it('余分な引数（空白を含む文を " で囲み忘れた）', () => {
    const e = usageError(["m", "--purpose", "README", "を直す"]);
    expect(e.headline).toContain("を直す");
    expect(e.hints.join("\n")).toContain('"');
  });

  it("全角の記号で書いたオプションを見つける（日本語入力のまま打った）", () => {
    const e = usageError(["m", "－－purpose", "x"]);
    expect(e.headline).toContain("全角");
    expect(e.hints.join("\n")).toContain("--purpose");
    const e2 = usageError(["m", "ーーwait"]);
    expect(e2.hints.join("\n")).toContain("--wait");
  });
});
