import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ulid } from "ulid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { ConfigIssue } from "../config-issue.ts";
import { type InitValues, initTemplateFiles, renderInitTemplate } from "./init-template.ts";
import { loadConfig } from "./load.ts";

let userHome: string;
let home: string;
const values: InitValues = { companyId: `c_${ulid()}`, companyName: "サンプル商会" };

beforeEach(() => {
  userHome = mkdtempSync(join(tmpdir(), "aicoop-init-"));
  home = join(userHome, ".aicoop");
});

afterEach(() => {
  rmSync(userHome, { recursive: true, force: true });
});

/** aicoop init がするように、雛形を置き換えて home に置く */
function init(transform: (target: string, text: string) => string = (_, t) => t) {
  for (const file of initTemplateFiles()) {
    const text = renderInitTemplate(file.target, readFileSync(file.source, "utf8"), values);
    const path = join(home, file.target);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, transform(file.target, text));
  }
}

function load() {
  return loadConfig(home, { userHome, checkSecretsMode: false });
}

function issuesOf(result: ReturnType<typeof loadConfig>): readonly ConfigIssue[] {
  return result.ok ? result.warnings : result.issues;
}

/**
 * コメントにしてある後のフェーズの部分（「▼」の行から「▲」の行まで）の、各行の先頭の「# 」を1つ消す。
 * 雛形のコメントに書いた、利用者に頼む手順そのもの。
 */
function uncommentLaterPhases(text: string): string {
  let inside = false;
  return text
    .split("\n")
    .map((line) => {
      if (/^\s*# ▼/.test(line)) {
        inside = true;
        return line;
      }
      if (/^\s*# ▲/.test(line)) {
        inside = false;
        return line;
      }
      return inside ? line.replace(/^(\s*)# ?/, "$1") : line;
    })
    .join("\n");
}

describe("aicoop init の雛形（6.1、9.1）", () => {
  it("雛形を置き換えたものは、loadConfig でエラーも警告もなく読める（P1 でそのまま動く会社）", () => {
    init();
    const result = load();
    expect(issuesOf(result)).toEqual([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { config } = result;
    expect(config.aicoop.company).toEqual({ id: values.companyId, name: values.companyName });
    // P1 で有効なのは box: vm の部署だけ
    expect(Object.values(config.groups).map((g) => g.box)).toEqual(
      Object.values(config.groups).map(() => "vm"),
    );
    // cron トリガーの例は、止めた状態で入れておく
    expect(config.triggers.length).toBeGreaterThan(0);
    expect(config.triggers.every((t) => t.type === "cron" && !t.enabled)).toBe(true);
  });

  it("コメントにしてある P2〜P6 の部分を外しても、エラーにならない（警告は、コメントで理由を書いた W-002 だけ）", () => {
    init((target, text) => (target.endsWith(".yaml") ? uncommentLaterPhases(text) : text));
    const result = load();
    expect(result.ok, JSON.stringify(issuesOf(result), null, 2)).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.map((i) => `${i.code} ${i.path}`)).toEqual(["W-002 groups.sales"]);
    const boxes = new Set(Object.values(result.config.groups).map((g) => g.box));
    expect(boxes).toEqual(new Set(["vm", "srt", "none"]));
    expect(result.config.triggers.map((t) => t.type)).toEqual(["cron", "github"]);
  });

  it("雛形のYAMLは、コメントを外す前も後も、YAMLとして読める", () => {
    for (const file of initTemplateFiles().filter((f) => f.target.endsWith(".yaml"))) {
      const text = renderInitTemplate(file.target, readFileSync(file.source, "utf8"), values);
      expect(() => parseYaml(text), file.target).not.toThrow();
      expect(() => parseYaml(uncommentLaterPhases(text)), file.target).not.toThrow();
    }
  });

  it("▼ と ▲ は組になっている", () => {
    for (const file of initTemplateFiles().filter((f) => f.target.endsWith(".yaml"))) {
      const text = readFileSync(file.source, "utf8");
      const opens = text.match(/^\s*# ▼/gm)?.length ?? 0;
      const closes = text.match(/^\s*# ▲/gm)?.length ?? 0;
      expect(opens, file.target).toBe(closes);
    }
  });

  it('会社の名前に " や \\ や $ や改行があっても、YAML が壊れずにそのまま入る', () => {
    const tricky: InitValues = {
      companyId: values.companyId,
      companyName: '"株式会社" \\ $& テスト\n商会',
    };
    for (const file of initTemplateFiles()) {
      const text = renderInitTemplate(file.target, readFileSync(file.source, "utf8"), tricky);
      const path = join(home, file.target);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    const result = load();
    expect(result.ok && result.config.aicoop.company.name).toBe('"株式会社" \\ $& テスト\n商会');
  });

  it("置き換えたあとに {{company_id}}・{{company_name}} が残らない", () => {
    for (const file of initTemplateFiles()) {
      const text = renderInitTemplate(file.target, readFileSync(file.source, "utf8"), values);
      expect(text, file.target).not.toMatch(/\{\{\s*company_(id|name)\s*\}\}/);
    }
  });

  it("会社のIDが c_ + ULID でなければ、置き換えない（例外）", () => {
    expect(() => renderInitTemplate("aicoop.yaml", "", { ...values, companyId: "x" })).toThrow();
  });

  it("gitignore は .gitignore として置き、6.1 の「gitに入れない」ものを並べる", () => {
    const file = initTemplateFiles().find((f) => f.target === ".gitignore");
    expect(file).toBeDefined();
    const lines = readFileSync(file?.source ?? "", "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    for (const entry of ["secrets.json", "state.db", "state/", "data/", "runtime/", "logs/"]) {
      expect(lines).toContain(entry);
    }
  });

  it("使う役職すべてと、コメントにしてある役職の、やり方の md がある", () => {
    const targets = initTemplateFiles().map((f) => f.target);
    for (const role of [
      "implementer",
      "reviewer",
      "researcher",
      "mail-writer",
      "manager",
      "image",
      "ceo",
    ]) {
      expect(targets).toContain(`prompts/roles/${role}.md`);
    }
    expect(targets).toContain("prompts/company.md");
  });
});
