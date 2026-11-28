/**
 * `aicoop init`（9.1、6.1）：~/.aicoop に雛形・.gitignore・置き場所のフォルダを作り、company.id を発行する。
 *
 * 決まり：
 * - すでにあるファイルは、どんな場合も上書きしない（`flag: "wx"` で作る）。`--force` は設けない
 * - `--only-missing` は、足りない雛形のファイルだけを作る。aicoop.yaml がないのに state.db・secrets.json が
 *   あるときは、会社の ID が変わってしまうので作らない
 * - home を新しく作るときは 0700（Linux・macOS）。本物の資格と state.db が入るため
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { aicoopPaths, resolveAicoopHome } from "@aicoop/daemon";
import { COMPANY_ID_PATTERN, initTemplateFiles, newId, renderInitTemplate } from "@aicoop/shared";
import { parse as parseYaml } from "yaml";
import type { CommandInput } from "../command.ts";
import { CliError, UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { shortPath } from "../home.ts";

export const DEFAULT_COMPANY_NAME = "わたしの会社";
const MAX_NAME_LENGTH = 100;

function companyName(value: string | boolean | undefined): string {
  if (value === undefined) return DEFAULT_COMPANY_NAME;
  const name = String(value).trim();
  if (name === "") {
    throw new UsageError("--name の会社の名前が空です", [
      '--name "サンプル商会" のように書いてください',
    ]);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を見つけるための式
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(name)) {
    throw new UsageError("--name の会社の名前に、改行や制御文字は使えません");
  }
  if ([...name].length > MAX_NAME_LENGTH) {
    throw new UsageError(`--name の会社の名前は${MAX_NAME_LENGTH}文字までにしてください`);
  }
  return name;
}

/** --only-missing のとき、いまの aicoop.yaml の会社（ほかの雛形の置き換えにも使う） */
function existingCompany(path: string): { id: string; name: string } | undefined {
  try {
    const doc = parseYaml(readFileSync(path, "utf8")) as {
      company?: { id?: unknown; name?: unknown };
    };
    const id = doc?.company?.id;
    const name = doc?.company?.name;
    if (
      typeof id === "string" &&
      COMPANY_ID_PATTERN.test(id) &&
      typeof name === "string" &&
      name.trim() !== ""
    ) {
      return { id, name };
    }
  } catch {
    // 読めなければ使わない
  }
  return undefined;
}

/**
 * 雛形のファイルと置き場所のフォルダを作る（すでにあるファイルは上書きしない）。作ったファイルを返す。
 * `aicoop open` も、設定がないときにこれで作る（5.14 の2の1）
 */
export function writeScaffold(
  home: string,
  company: { readonly companyId: string; readonly companyName: string },
): string[] {
  const paths = aicoopPaths(home);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  for (const file of initTemplateFiles()) {
    const target = join(home, file.target);
    if (existsSync(target)) continue;
    const text = renderInitTemplate(file.target, readFileSync(file.source, "utf8"), company);
    mkdirSync(join(target, ".."), { recursive: true });
    try {
      writeFileSync(target, text, { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    created.push(file.target);
  }
  for (const dir of [paths.dataDir, paths.logsDir, paths.runtimeDir, paths.holdsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return created;
}

export async function run(input: CommandInput): Promise<number> {
  const { home, values, out, err, ctx } = input;
  const style = out.style;

  if (values.force === true) {
    throw new UsageError("aicoop init は、すでにある設定を上書きしません（--force はありません）", [
      "足りないファイルだけを作るなら：aicoop init --only-missing",
      "作り直すなら：いまのフォルダを別の名前に移してから aicoop init",
    ]);
  }
  const onlyMissing = values["only-missing"] === true;
  const paths = aicoopPaths(home);
  const configPath = join(home, "aicoop.yaml");
  const files = initTemplateFiles();
  const existing = files.filter((f) => existsSync(join(home, f.target)));

  if (!onlyMissing && existing.length > 0) {
    const first = existing.find((f) => f.target === "aicoop.yaml") ?? existing[0];
    throw new CliError(
      EXIT.failure,
      `すでに設定があります（${shortPath(join(home, first?.target ?? ""), ctx.userHome)}）。何も上書きしていません`,
      [
        "設定を確かめるなら：aicoop check",
        "消してしまった雛形のファイルだけを作るなら：aicoop init --only-missing",
        "作り直すなら：いまのフォルダを別の名前に移してから aicoop init",
      ],
    );
  }
  if (
    onlyMissing &&
    !existsSync(configPath) &&
    (existsSync(paths.stateDb) || existsSync(paths.secrets))
  ) {
    throw new CliError(
      EXIT.failure,
      "aicoop.yaml がないのに、state.db か secrets.json があります。新しく作ると会社の ID が変わるので、作りません",
      [
        "バックアップから aicoop.yaml を戻してください（git で管理しているなら git checkout aicoop.yaml）",
      ],
    );
  }

  const kept = onlyMissing ? existingCompany(configPath) : undefined;
  const name = kept && values.name === undefined ? kept.name : companyName(values.name);
  const companyId = kept?.id ?? newId("company");

  const homeExisted = existsSync(home);
  const created = writeScaffold(home, { companyId, companyName: name });

  if (homeExisted && process.platform !== "win32") {
    const mode = statSync(home).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      err.line(
        `${err.style.yellow("注意：")}${shortPath(home, ctx.userHome)} はほかのユーザーも読めます（${mode.toString(8)}）。本物の資格が入るので chmod 700 ${home} をおすすめします`,
      );
    }
  }

  if (onlyMissing) {
    if (created.length === 0) {
      out.line(
        `${style.green("✓")} 足りない雛形のファイルはありませんでした（何も変えていません）`,
      );
    } else {
      out.line(`${style.green("✓")} 足りなかった雛形のファイルを ${created.length}個 作りました`);
      for (const f of created) out.line(`    ${f}`);
    }
    return EXIT.ok;
  }

  const prompts = created.filter((f) => f.startsWith("prompts/")).length;
  const yamls = created.filter((f) => f.endsWith(".yaml")).length;
  const isDefaultHome = resolve(home) === resolve(resolveAicoopHome(ctx.env, ctx.userHome));
  const homeFlag = isDefaultHome ? "" : ` --home ${home}`;
  const where = shortPath(home, ctx.userHome);
  const cmd = (text: string) => style.cyan(`aicoop${homeFlag} ${text}`);

  out.lines([
    `${style.green("✓")} 会社「${name}」を作りました`,
    `    場所        ${where}`,
    `    会社の ID   ${companyId}（変えないでください）`,
    `    作ったもの  設定ファイル ${yamls}個・プロンプト ${prompts}個・.gitignore・data/・logs/・runtime/・state/holds/`,
    "",
    style.bold("次にすること"),
    `  1. groups.yaml の「your-org」を、自分の GitHub のユーザー名か組織名に書き換える`,
    `       ${join(where, "groups.yaml")}`,
    "  2. Claude にログインする（ブラウザが開きます。トークンは AIcoop が受け取って保存します）",
    `       ${cmd("login")}`,
    "  3. GitHub App の資格（app_id・installation_id・private_key の JSON）を登録する",
    `       ${cmd("secret set github --kind github_app < github-app.json")}`,
    "  4. 設定と準備を確かめる",
    `       ${cmd("check")}`,
    "  5. 箱（vm）のイメージを作る（数分かかります）",
    `       ${cmd("image build")}`,
    "  6. 制御サーバーを起動する",
    `       ${cmd("start")}`,
    "  7. 仕事を頼んで、様子を見る",
    `       ${cmd('run dev-implementer --purpose "README の誤字を直す" --done-when "PR を出して URL を報告した"')}`,
    `       ${cmd("logs <task_id> --follow")}`,
  ]);
  if (!isDefaultHome) {
    out.line("");
    out.line(
      `この場所を使うときは、どのコマンドにも --home ${home} を付けるか、環境変数 AICOOP_HOME=${home} にします。`,
    );
  }
  if (ctx.platform === "win32") {
    out.line("");
    out.line(
      `${style.yellow("Windows では：")}vm の箱（Gondolin）は Windows では動きません。aicoop は WSL2 の中で動かしてください（設計書 4.3）。`,
    );
  }
  out.line("");
  out.line(
    style.dim(
      "設定（*.yaml・prompts/）は git で管理するのがおすすめです。.gitignore に、入れてはいけないものを書いてあります。",
    ),
  );
  return EXIT.ok;
}
