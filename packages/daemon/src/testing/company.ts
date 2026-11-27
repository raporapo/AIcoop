/**
 * テスト用：一時ディレクトリに、`aicoop init` の雛形から会社を作る。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CompanyConfig,
  initTemplateFiles,
  loadConfig,
  newId,
  renderInitTemplate,
} from "@aicoop/shared";

export interface TestCompany {
  readonly home: string;
  readonly companyId: string;
  /** home からの相対パスのファイルを書く（設定を書き換えるとき） */
  write(relative: string, text: string): void;
  read(relative: string): string;
  /** いまのファイルを読んで検証した設定（エラーなら例外） */
  load(): CompanyConfig;
}

/**
 * `aicoop init` がするように、雛形を置き換えて `home` に置く。
 * `files` に書いたファイルは、雛形のかわりにその中身にする（home からの相対パス → 中身）。
 */
export function createTestCompany(
  home: string,
  opts: {
    readonly transform?: (target: string, text: string) => string;
    readonly files?: Readonly<Record<string, string>>;
  } = {},
): TestCompany {
  const companyId = newId("company");
  const values = { companyId, companyName: "テスト商会" };
  const write = (relative: string, text: string) => {
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  for (const file of initTemplateFiles()) {
    const text = renderInitTemplate(file.target, readFileSync(file.source, "utf8"), values);
    write(file.target, opts.transform ? opts.transform(file.target, text) : text);
  }
  for (const [relative, text] of Object.entries(opts.files ?? {})) write(relative, text);

  return {
    home,
    companyId,
    write,
    read: (relative) => readFileSync(join(home, relative), "utf8"),
    load() {
      const result = loadConfig(home, { checkSecretsMode: false });
      if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
      return result.config;
    },
  };
}

/** 雛形の cron トリガーの例（sales-morning-news）を有効にする */
export function enableTemplateCron(target: string, text: string): string {
  return target === "triggers.yaml"
    ? text.replace(/^(\s+)enabled: false$/m, "$1enabled: true")
    : text;
}

/**
 * 部署を `count` 個（g1, g2, …。どれも box: vm、社員は 1 人ずつ m1, m2, …、役職は researcher）にした
 * groups.yaml と members.yaml。同時に起動する箱の上限のテストに使う。
 */
export function manyGroupsFiles(count: number): Record<string, string> {
  const groups = ["groups:"];
  const members = ["members:"];
  for (let i = 1; i <= count; i++) {
    groups.push(`  g${i}:`, `    name: "部署${i}"`, "    box: vm", "    ceiling: []");
    members.push(`  m${i}: { name: "社員${i}", group: "g${i}", role: "researcher" }`);
  }
  return {
    "groups.yaml": `${groups.join("\n")}\n`,
    "members.yaml": `${members.join("\n")}\n`,
    "triggers.yaml": "triggers: []\n",
  };
}

/**
 * 雛形のコメントにしてある後のフェーズの部分（「▼」の行から「▲」の行まで）の、各行の先頭の「# 」を1つ消す
 * （雛形のコメントに書いた、利用者に頼む手順そのもの）
 */
export function uncommentLaterPhases(text: string): string {
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

/** 部署・役職・社員の後のフェーズの部分を外す（役員室・デザイン部（srt）・CEO（none）がそろう） */
export function withLaterPhaseMembers(target: string, text: string): string {
  return target === "groups.yaml" || target === "members.yaml" || target === "roles.yaml"
    ? uncommentLaterPhases(text)
    : text;
}
