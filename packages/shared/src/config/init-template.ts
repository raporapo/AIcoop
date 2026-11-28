/**
 * `aicoop init` の雛形（リポジトリの `templates/`。6.1、9.1）。
 *
 * ファイルを書くのは CLI（既にあるファイルを上書きしないなどの判断も CLI）。
 * ここでは、複製するファイルの一覧と、置き換え（`{{company_id}}`・`{{company_name}}`）だけをする。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { templatesDir } from "./paths.ts";
import { COMPANY_ID_PATTERN } from "./schema.ts";

export interface InitTemplateFile {
  /** 雛形のファイル（絶対パス） */
  readonly source: string;
  /** `~/.aicoop/` からの相対パス（`/` 区切り）。`gitignore` は `.gitignore` になる */
  readonly target: string;
}

/** 雛形のファイルの一覧（パスの順） */
export function initTemplateFiles(dir: string = templatesDir()): InitTemplateFile[] {
  const files: InitTemplateFile[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), `${relative}/`);
      else if (entry.isFile()) {
        // npm などは .gitignore という名前のファイルを配らないので、雛形では gitignore にしておく
        const target = relative === "gitignore" ? ".gitignore" : relative;
        files.push({ source: join(current, entry.name), target });
      }
    }
  };
  walk(dir, "");
  return files.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
}

/** 名前を決めずに作った雛形の会社の名前（`aicoop init`・`aicoop open`。準備の画面で変える。D-30） */
export const DEFAULT_COMPANY_NAME = "わたしの会社";

export interface InitValues {
  /** `c_` + ULID（7.1） */
  readonly companyId: string;
  /** 承認アプリに出す会社の名前 */
  readonly companyName: string;
}

/**
 * 雛形の中の `{{company_id}}`・`{{company_name}}` を置き換える。
 * YAML では `"..."` の中に入るので、`"` や `\`、改行を壊れない形にする。
 */
export function renderInitTemplate(target: string, text: string, values: InitValues): string {
  if (!COMPANY_ID_PATTERN.test(values.companyId)) {
    throw new Error(`会社のIDは c_ と ULID にしてください（いまの値：${values.companyId}）`);
  }
  const name = values.companyName.trim();
  if (name === "") throw new Error("会社の名前が空です");
  const isYaml = target.endsWith(".yaml");
  const shownName = isYaml ? JSON.stringify(name).slice(1, -1) : name.replace(/[\r\n]+/g, " ");
  // 置き換える文字列の $ を特別扱いさせないため、関数で渡す
  return text
    .replaceAll("{{company_id}}", () => values.companyId)
    .replaceAll("{{company_name}}", () => shownName);
}
