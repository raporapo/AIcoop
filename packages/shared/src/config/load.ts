/**
 * 設定の読み込み（6.1）：`~/.aicoop/` の下のファイルを読み、validate.ts で検証する。
 *
 * ここではファイルを読むことだけをする（YAML として読めるか、ファイルの権限、ハッシュ）。
 * 中身の検証は validateConfig（純粋な関数）に任せる。例外では落とさず、誤りは ConfigIssue で返す。
 */
import { createHash } from "node:crypto";
import { type Dirent, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { ConfigIssue } from "../config-issue.ts";
import { makeIssue } from "./messages.ts";
import { builtinServicesDir } from "./paths.ts";
import { CONFIG_FILE_NAMES } from "./schema.ts";
import { type ConfigResult, type ServiceSource, validateConfig } from "./validate.ts";

export interface LoadConfigOptions {
  /** `~` を展開するホームディレクトリ。既定は OS のホーム */
  readonly userHome?: string;
  /** 組み込みのサービス定義の場所。既定は builtinServicesDir() */
  readonly builtinServicesDir?: string;
  /** `secrets.json` の権限を確かめるか（E-008）。既定は Windows 以外で確かめる */
  readonly checkSecretsMode?: boolean;
  /** cron 式が一度でも起きるかを調べる基準の時刻（既定は今） */
  readonly now?: Date;
}

/**
 * 設定を読んで検証する。エラーが1つでもあれば `ok: false`（6.1：daemon は起動せず、reload は前の設定のまま）。
 */
export function loadConfig(home: string, options: LoadConfigOptions = {}): ConfigResult {
  const root = resolve(home);
  const reader = new Reader(root);

  const files: Record<string, unknown> = {};
  for (const name of CONFIG_FILE_NAMES) {
    const content = reader.readHomeYaml(name);
    if (content !== ABSENT && content !== FAILED) files[name] = content;
    reader.rejectYml(root, name.replace(/\.yaml$/, ".yml"), name);
  }

  const services: ServiceSource[] = [];
  const builtinDir = options.builtinServicesDir ?? builtinServicesDir();
  const builtinFiles = reader.listFiles(builtinDir, builtinDir, ".yaml");
  if (builtinFiles.length === 0) {
    reader.issues.push(
      makeIssue(
        "E-013",
        builtinDir,
        "",
        "組み込みのサービス定義（github・gmail・web）が見つかりません。aicoop を入れ直してください",
      ),
    );
  }
  for (const file of builtinFiles) {
    const path = join(builtinDir, file);
    const content = reader.readYaml(path, path, `builtin:services/${file}`);
    if (content !== ABSENT && content !== FAILED) {
      services.push({ source: join(builtinDir, file), builtin: true, content });
    }
  }
  const ownerDir = join(root, "services");
  for (const file of reader.listFiles(ownerDir, "services", ".yaml")) {
    const relative = `services/${file}`;
    const content = reader.readHomeYaml(relative);
    if (content !== ABSENT && content !== FAILED) {
      services.push({ source: relative, builtin: false, content });
    }
  }
  for (const file of reader.listFiles(ownerDir, "services", ".yml")) {
    reader.rejectYml(ownerDir, file, `services/${file.replace(/\.yml$/, ".yaml")}`);
  }

  const prompts = reader.readPrompts(join(root, "prompts"));
  const skills = reader.listDirectories(join(root, "skills"));
  const checkSecrets = options.checkSecretsMode ?? process.platform !== "win32";
  const secretsMode = checkSecrets ? reader.secretsMode(join(root, "secrets.json")) : undefined;

  if (reader.issues.length > 0) return { ok: false, issues: reader.issues };

  return validateConfig({
    home: root,
    userHome: options.userHome ?? homedir(),
    files,
    services,
    prompts,
    skills,
    ...(secretsMode !== undefined && { secretsMode }),
    fileHashes: reader.hashes,
    ...(options.now !== undefined && { now: options.now }),
  });
}

const ABSENT = Symbol("absent");
const FAILED = Symbol("failed");

/** YAML の誤りの種類を日本語にする（知らないものは、ライブラリの文をそのまま出す） */
const YAML_ERRORS: Readonly<Record<string, string>> = {
  DUPLICATE_KEY: "同じキーが2回書かれています。1つにまとめてください",
  BAD_INDENT: "字下げ（インデント）がそろっていません",
  TAB_AS_INDENT: "字下げにタブは使えません。空白にしてください",
  MULTIPLE_DOCS: "--- で区切った複数の文書は書けません。1つのファイルには1つだけ書いてください",
  MISSING_CHAR: '閉じる記号（] や } や "）が足りません',
  BLOCK_AS_IMPLICIT_KEY: "キーの書き方が正しくありません（字下げか : の位置を確かめてください）",
  MULTILINE_IMPLICIT_KEY:
    "キーを複数行にまたがって書けません（字下げか : の位置を確かめてください）",
  BAD_DQ_ESCAPE: '"..." の中の \\ の書き方が正しくありません',
};

class Reader {
  readonly issues: ConfigIssue[] = [];
  readonly hashes: Record<string, string> = {};
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private fail(source: string, detail: string): void {
    this.issues.push(makeIssue("E-013", source, "", detail));
  }

  /** ファイルを読む。なければ ABSENT、読めなければ FAILED */
  private readBytes(path: string, source: string): Buffer | typeof ABSENT | typeof FAILED {
    try {
      return readFileSync(path);
    } catch (e) {
      if (errorCode(e) === "ENOENT") return ABSENT;
      this.fail(source, `読めません（${errorCode(e) ?? String(e)}）`);
      return FAILED;
    }
  }

  /** home の下の YAML のファイル（`relative` は `/` 区切り）を読み、ハッシュを記録する */
  readHomeYaml(relative: string): unknown | typeof ABSENT | typeof FAILED {
    return this.readYaml(join(this.root, relative), relative, relative);
  }

  /**
   * YAML のファイルを読み、ハッシュを記録する。なければ ABSENT、読めなければ FAILED。
   * 中身が空のファイルは null になる。
   */
  readYaml(path: string, source: string, hashKey: string): unknown | typeof ABSENT | typeof FAILED {
    const bytes = this.readBytes(path, source);
    if (bytes === ABSENT || bytes === FAILED) return bytes;
    this.hashes[hashKey] = sha256(bytes);
    try {
      return parseYaml(bytes.toString("utf8")) ?? null;
    } catch (e) {
      this.issues.push({ code: "E-013", message: yamlErrorMessage(source, e), source });
      return FAILED;
    }
  }

  /** `.yml` のファイルは読まないので、名前の誤りとして知らせる */
  rejectYml(dir: string, file: string, expected: string): void {
    if (!file.endsWith(".yml")) return;
    if (!isFile(join(dir, file))) return;
    const source = dir === this.root ? file : `services/${file}`;
    this.fail(source, `.yml のファイルは読みません。名前を ${expected} にしてください`);
  }

  /** フォルダの中の、その拡張子のファイル（名前の順）。フォルダがなければ空 */
  listFiles(dir: string, label: string, extension: string): string[] {
    return this.entries(dir, label)
      .filter((e) => e.isFile() && e.name.endsWith(extension))
      .map((e) => e.name)
      .sort();
  }

  listDirectories(dir: string): Set<string> {
    return new Set(
      this.entries(dir, "skills")
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  }

  private entries(dir: string, label: string): Dirent[] {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (errorCode(e) !== "ENOENT")
        this.fail(label, `フォルダを読めません（${errorCode(e) ?? String(e)}）`);
      return [];
    }
  }

  /** prompts/ の下の md を、下のフォルダまで読む（シンボリックリンクは読まない） */
  readPrompts(dir: string): Map<string, string> {
    const prompts = new Map<string, string>();
    const walk = (current: string, prefix: string) => {
      for (const entry of this.entries(current, `prompts/${prefix}`)) {
        const relative = `${prefix}${entry.name}`;
        const path = join(current, entry.name);
        if (entry.isSymbolicLink()) {
          if (entry.name.endsWith(".md") || isDirectoryLink(path)) {
            this.fail(
              `prompts/${relative}`,
              "prompts の中にシンボリックリンクは置けません（プロンプトは箱の中に書き出すので、ほかのファイルを指せないようにする）。ふつうのファイルにしてください",
            );
          }
          continue;
        }
        if (entry.isDirectory()) {
          walk(path, `${relative}/`);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const bytes = this.readBytes(path, `prompts/${relative}`);
        if (bytes === ABSENT || bytes === FAILED) continue;
        this.hashes[`prompts/${relative}`] = sha256(bytes);
        prompts.set(relative, bytes.toString("utf8"));
      }
    };
    walk(dir, "");
    return prompts;
  }

  /** secrets.json の権限（下位9ビット）。ファイルがなければ null */
  secretsMode(path: string): number | null | undefined {
    try {
      return statSync(path).mode & 0o777;
    } catch (e) {
      if (errorCode(e) === "ENOENT") return null;
      this.fail("secrets.json", `権限を確かめられません（${errorCode(e) ?? String(e)}）`);
      return undefined;
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectoryLink(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function yamlErrorMessage(source: string, e: unknown): string {
  if (e instanceof YAMLParseError) {
    const line = e.linePos?.[0]?.line;
    const first = (e.message.split("\n")[0] ?? "").replace(/ at line \d+, column \d+:?$/, "");
    const detail = YAML_ERRORS[e.code] ?? first;
    return `${source} をYAMLとして読めません${line !== undefined ? `（${line}行目）` : ""}：${detail}`;
  }
  return `${source} をYAMLとして読めません：${e instanceof Error ? e.message : String(e)}`;
}
