/**
 * 設定の画面で扱うファイル（5.14 の4の1・4）：一覧・中身・原子的な書き込みと元に戻すこと。
 *
 * 守ること（拒否側に倒す。P-3）：
 * - パスは `CONFIG_FILE_PATH_PATTERN`（`@aicoop/shared/api`）に合うものだけ。`..`・`.`・絶対パス・`\`・
 *   `%2e` などの書き方は、パターンに合わないので、そのまま拒否する（デコードして読み直さない）
 * - home からファイルまでの途中のフォルダとファイルを、1つずつ lstat で確かめ、シンボリックリンクなら拒否する
 *   （ファイルを置き換えるときも、指す先を書き換えない）
 * - 1つのファイルは `MAX_CONFIG_FILE_BYTES` まで。UTF-8 として読めないものは扱わない
 * - 書くときは、同じフォルダの一時ファイルに書いてから rename で入れ替える
 *
 * 一覧に出すのは 6.1 の yaml、`services/<名前>.yaml`、`prompts/` の下の md だけ。
 * `secrets.json`・`state.db`・`data/`・`runtime/`・`logs/`・`skills/` などは、一覧にも出さず、読み書きもしない。
 */
import { createHash, randomBytes } from "node:crypto";
import {
  type Dirent,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE_NAMES } from "@aicoop/shared";
import {
  CONFIG_FILE_PATH_PATTERN,
  type ConfigFileView,
  type GetConfigFileResponse,
  MAX_CONFIG_FILE_BYTES,
} from "@aicoop/shared/api";

export type ConfigFileErrorCode =
  /** 設定の画面で扱えないパス */
  | "not_allowed"
  | "not_found"
  /** 途中のフォルダかファイルがシンボリックリンク（またはふつうのファイル・フォルダではない） */
  | "symlink"
  | "too_large"
  /** UTF-8 として読めない */
  | "not_text";

export class ConfigFileError extends Error {
  override name = "ConfigFileError";
  readonly code: ConfigFileErrorCode;
  constructor(code: ConfigFileErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** パスが設定の画面で扱えるものか（パターンだけ。ファイルの形は見ない） */
export function isConfigFilePath(path: unknown): path is string {
  return typeof path === "string" && CONFIG_FILE_PATH_PATTERN.test(path);
}

function errorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (e) {
    if (errorCode(e) === "ENOENT" || errorCode(e) === "ENOTDIR") return null;
    throw e;
  }
}

const notAllowed = () =>
  new ConfigFileError(
    "not_allowed",
    "このファイルは設定の画面では扱えません（6.1 の yaml・services/*.yaml・prompts/ の md だけ）",
  );
const symlink = (path: string) =>
  new ConfigFileError(
    "symlink",
    `${path} は、シンボリックリンクか、ふつうのファイル・フォルダではないので扱いません`,
  );

interface Resolved {
  readonly absolute: string;
  /** ファイルの lstat（なければ null） */
  readonly stat: Stats | null;
  /** まだないフォルダ（home に近い順） */
  readonly missingDirs: readonly string[];
}

/**
 * パスを確かめて、本物の場所にする。home からの途中のフォルダは、あればふつうのフォルダでなければならない。
 * ファイルは、あればふつうのファイルでなければならない
 */
function resolvePath(home: string, path: string): Resolved {
  if (!isConfigFilePath(path)) throw notAllowed();
  const segments = path.split("/");
  const fileName = segments.pop() as string;
  let current = home;
  const missingDirs: string[] = [];
  for (const segment of segments) {
    current = join(current, segment);
    if (missingDirs.length > 0) {
      missingDirs.push(current);
      continue;
    }
    const stat = lstatOrNull(current);
    if (stat === null) missingDirs.push(current);
    else if (!stat.isDirectory()) throw symlink(path);
  }
  const absolute = join(current, fileName);
  const stat = missingDirs.length > 0 ? null : lstatOrNull(absolute);
  if (stat !== null && !stat.isFile()) throw symlink(path);
  return { absolute, stat, missingDirs };
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function readBytes(path: string, resolved: Resolved): Buffer {
  if (resolved.stat === null) throw new ConfigFileError("not_found", `${path} はありません`);
  if (resolved.stat.size > MAX_CONFIG_FILE_BYTES) {
    throw new ConfigFileError(
      "too_large",
      `${path} は大きすぎるので、設定の画面では扱えません（${MAX_CONFIG_FILE_BYTES / 1024} KiB まで）`,
    );
  }
  const bytes = readFileSync(resolved.absolute);
  if (bytes.length > MAX_CONFIG_FILE_BYTES) {
    throw new ConfigFileError(
      "too_large",
      `${path} は大きすぎるので、設定の画面では扱えません（${MAX_CONFIG_FILE_BYTES / 1024} KiB まで）`,
    );
  }
  return bytes;
}

/** 中身と SHA-256（5.14 の4の1） */
export function readConfigFile(home: string, path: string): GetConfigFileResponse {
  const bytes = readBytes(path, resolvePath(home, path));
  let content: string;
  try {
    content = decoder.decode(bytes);
  } catch {
    throw new ConfigFileError("not_text", `${path} は UTF-8 の文字として読めないので扱えません`);
  }
  return { path, content, sha256: sha256(bytes) };
}

/** いまの中身の SHA-256。なければ null（パス・シンボリックリンク・大きさは readConfigFile と同じく確かめる） */
export function currentSha256(home: string, path: string): string | null {
  const resolved = resolvePath(home, path);
  if (resolved.stat === null) return null;
  return sha256(readBytes(path, resolved));
}

/** いまの中身（なければ null）。元に戻すために覚えておく */
function currentBytes(home: string, path: string): Buffer | null {
  const resolved = resolvePath(home, path);
  return resolved.stat === null ? null : readBytes(path, resolved);
}

function entries(dir: string): Dirent[] {
  const stat = lstatOrNull(dir);
  if (stat === null || !stat.isDirectory()) return [];
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

function view(home: string, path: string): ConfigFileView | null {
  if (!isConfigFilePath(path)) return null;
  try {
    const resolved = resolvePath(home, path);
    if (resolved.stat === null) return null;
    const bytes = readFileSync(resolved.absolute);
    return {
      path,
      size: resolved.stat.size,
      sha256: sha256(bytes),
      modified_at: resolved.stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

/** 設定のファイルの一覧（5.14 の4の1）。yaml → services → prompts の順、それぞれ名前の順 */
export function listConfigFiles(home: string): ConfigFileView[] {
  const out: ConfigFileView[] = [];
  const push = (path: string) => {
    const v = view(home, path);
    if (v !== null) out.push(v);
  };
  for (const name of CONFIG_FILE_NAMES) push(name);
  for (const e of entries(join(home, "services"))) {
    if (e.isFile()) push(`services/${e.name}`);
  }
  const walk = (dir: string, prefix: string, depth: number) => {
    for (const e of entries(dir)) {
      if (e.isFile()) push(`${prefix}${e.name}`);
      else if (e.isDirectory() && depth < 2)
        walk(join(dir, e.name), `${prefix}${e.name}/`, depth + 1);
    }
  };
  const prompts = entries(join(home, "prompts"));
  if (prompts.length > 0) walk(join(home, "prompts"), "prompts/", 0);
  return out;
}

export interface ConfigFileWrite {
  readonly path: string;
  readonly content: string;
}

export interface WrittenFiles {
  /** 書く前の中身に戻す（新しく作ったファイルは消す）。失敗したものは投げずに数える */
  restore(): { readonly failed: readonly string[] };
}

function atomicWrite(absolute: string, bytes: Buffer): void {
  const tmp = `${absolute}.aicoop-${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, bytes, { flag: "wx", mode: 0o644 });
    renameSync(tmp, absolute);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * ファイルを原子的に書く（5.14 の4の4）。途中で失敗したら、それまでに書いたものを元に戻してから投げる。
 * 先にすべてのパスを確かめるので、許されないパスが1つでもあれば、何も書かない
 */
export function writeConfigFiles(home: string, files: readonly ConfigFileWrite[]): WrittenFiles {
  const plans = files.map((f) => ({
    path: f.path,
    bytes: Buffer.from(f.content, "utf8"),
    before: currentBytes(home, f.path),
  }));
  const done: typeof plans = [];
  const restore = () => {
    const failed: string[] = [];
    for (const p of [...done].reverse()) {
      try {
        const resolved = resolvePath(home, p.path);
        if (p.before === null) rmSync(resolved.absolute, { force: true });
        else atomicWrite(resolved.absolute, p.before);
      } catch {
        failed.push(p.path);
      }
    }
    done.length = 0;
    return { failed };
  };
  try {
    for (const p of plans) {
      // 確かめてから書くまでのあいだに、フォルダがリンクに変えられていないか、もう一度見る
      const resolved = resolvePath(home, p.path);
      for (const d of resolved.missingDirs) mkdirSync(d);
      if (resolved.missingDirs.length > 0) resolvePath(home, p.path);
      atomicWrite(resolved.absolute, p.bytes);
      done.push(p);
    }
  } catch (e) {
    restore();
    throw e;
  }
  return { restore };
}
