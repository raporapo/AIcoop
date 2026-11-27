import { describe, expect, it } from "vitest";
import { KILL_SCRIPT, killCommand, LineSplitter, pidFile, wrapCommand } from "./exec.ts";

describe("4.4：exec のコマンドの組み立て", () => {
  it("$PATH を探すため /bin/sh を通すが、コマンドと引数はシェルの文字列に入れず位置引数で渡す", () => {
    const argv = wrapCommand(
      ["claude", "-p", "a; rm -rf / $(id) `id` \"'"],
      "/run/aicoop-exec/1.pid",
    );
    expect(argv[0]).toBe("/bin/sh");
    expect(argv[1]).toBe("-c");
    const script = argv[2] ?? "";
    // スクリプトは固定の文字列で、引数の中身を含まない
    expect(script).not.toContain("claude");
    expect(script).not.toContain("rm -rf");
    expect(script).toContain('exec "$@"');
    expect(argv.slice(3)).toEqual([
      "aicoop-exec",
      "/run/aicoop-exec/1.pid",
      "claude",
      "-p",
      "a; rm -rf / $(id) `id` \"'",
    ]);
  });

  it("同じスクリプトは、どのコマンドでも変わらない", () => {
    expect(wrapCommand(["a"], "/p")[2]).toBe(wrapCommand(["b", "c"], "/q")[2]);
  });

  it("空のコマンドや NUL を含む引数は組み立てない", () => {
    expect(() => wrapCommand([], "/p")).toThrow();
    expect(() => wrapCommand([""], "/p")).toThrow();
    expect(() => wrapCommand(["echo", "a\0b"], "/p")).toThrow();
  });

  it("止めるスクリプトは、記録した PID とその子孫を TERM、そのあと KILL で止める", () => {
    expect(KILL_SCRIPT).toContain("/run/aicoop-exec/");
    expect(KILL_SCRIPT).toContain("-TERM");
    expect(KILL_SCRIPT).toContain("-KILL");
    // 数字でない PID は使わない
    expect(KILL_SCRIPT).toContain("*[!0-9]*");
  });

  it("止める exec の番号は、スクリプトに埋め込まず位置引数で渡す", () => {
    expect(killCommand([2, 5])).toEqual(["/bin/sh", "-c", KILL_SCRIPT, "aicoop-kill", "2", "5"]);
    expect(pidFile(7)).toBe("/run/aicoop-exec/7.pid");
  });
});

describe("4.4：exec の出力を行ごとに分ける LineSplitter", () => {
  const enc = (s: string) => Buffer.from(s, "utf8");

  it("改行で区切り、最後の改行のない行は終わりに出す", () => {
    const s = new LineSplitter();
    expect(s.push(enc("a\nb"))).toEqual(["a"]);
    expect(s.push(enc("c\n\nd"))).toEqual(["bc", ""]);
    expect(s.end()).toEqual(["d"]);
  });

  it("CRLF の CR は取る", () => {
    const s = new LineSplitter();
    expect(s.push(enc("a\r\nb\r\n"))).toEqual(["a", "b"]);
    expect(s.end()).toEqual([]);
  });

  it("UTF-8 の文字がチャンクの境目で割れても崩れない", () => {
    const bytes = enc("日本語\n");
    const s = new LineSplitter();
    const out = [...s.push(bytes.subarray(0, 4)), ...s.push(bytes.subarray(4))];
    expect(out).toEqual(["日本語"]);
  });

  it("出力がなければ何も出さない", () => {
    const s = new LineSplitter();
    expect(s.end()).toEqual([]);
  });
});
