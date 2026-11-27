/**
 * 実行ごとの掃除（5.4.4）。箱を起こす前に、ホスト側のパスに対して行う。
 *
 * 乗っ取られた社員が、次の実行に仕掛け（設定・フック・指示ファイル）を残せないようにする（T-13）。
 *
 * 1. ホームの `.claude/` の中を、`projects/`（セッション）以外すべて消す
 *    - `projects/` の中でも、リンク（辿らない）と、プロジェクトごとの `memory/`
 *      （Claude Code が自動で読む指示ファイル）は消す
 * 2. 作業フォルダの直下の `CLAUDE.md`・`.claude/`・`.mcp.json`（と `CLAUDE.local.md`）を、
 *    `.aicoop-quarantine/<run_id>/` に移して、監査ログ `quarantine` を書く
 *    - 大文字・小文字の違う名前も移す（大文字・小文字を区別しないファイルシステムでは同じものとして読まれる）
 *    - リポジトリの中（例：`repos/app/CLAUDE.md`）にあるものは移さない
 * 3. ホームの `.claude.json` を消す
 *
 * 箱の中の者は、ホームと作業フォルダに何でも置ける（リンクも）。ホストのこのコードは
 * **リンクを決して辿らない**：`lstat` で見て、リンクならリンクそのものを消す・移す。
 */
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, type Stats } from "node:fs";
import { join } from "node:path";
import { appendAudit } from "../db/audit.ts";
import type { StateDb } from "../db/open.ts";
import type { AicoopPaths } from "../paths.ts";

/** 作業フォルダの直下で隔離する名前（小文字で比べる） */
const QUARANTINE_NAMES: ReadonlySet<string> = new Set([
  "claude.md",
  "claude.local.md",
  ".claude",
  ".mcp.json",
]);

export const QUARANTINE_DIR = ".aicoop-quarantine";

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** リンクを辿らずに消す（`rmSync` はリンクを辿らず、リンクそのものを消す） */
function remove(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/** 本物のディレクトリにする。リンク・ファイルなら、それを消して作り直す */
function ensureRealDir(path: string): void {
  const st = lstatOrNull(path);
  if (st?.isDirectory() && !st.isSymbolicLink()) return;
  if (st !== null) remove(path);
  mkdirSync(path);
}

/**
 * ホーム・作業フォルダそのもの（箱のマウントの根）を用意する。
 * 根がリンクになっていたら、掃除をすると先のものを消してしまうので、止める。
 */
function ensureMountRoot(path: string, what: string): void {
  const st = lstatOrNull(path);
  if (st === null) {
    mkdirSync(path, { recursive: true });
    return;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(
      `${what}（${path}）がディレクトリではありません（リンクかファイル）。掃除でリンクの先を消さないよう、実行を止めました。中身を確かめてから消してください`,
    );
  }
}

/** 5.4.4 の1・3：ホームの `.claude/`（projects/ 以外）と `.claude.json` を消す */
export function cleanMemberHome(homeDir: string): void {
  ensureMountRoot(homeDir, "社員のホーム");

  const claude = join(homeDir, ".claude");
  ensureRealDir(claude);
  for (const name of readdirSync(claude)) {
    const path = join(claude, name);
    if (name === "projects") {
      const st = lstatSync(path);
      if (st.isDirectory() && !st.isSymbolicLink()) {
        cleanProjects(path);
        continue;
      }
    }
    remove(path);
  }

  remove(join(homeDir, ".claude.json"));
}

/** `projects/` の中：リンクとふつうでないファイルを消し、`<project>/memory/` を消す */
function cleanProjects(dir: string, depth = 0): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !(st.isDirectory() || st.isFile())) {
      remove(path);
    } else if (st.isDirectory()) {
      if (depth === 1 && name === "memory") remove(path);
      else cleanProjects(path, depth + 1);
    }
  }
}

/**
 * 5.4.4 の2：作業フォルダの直下の設定・指示ファイルを `.aicoop-quarantine/<run_id>/` に移す。
 * 移したものの名前（作業フォルダからの相対パス）を返す。
 */
export function quarantineWorkFiles(workDir: string, runId: string): string[] {
  ensureMountRoot(workDir, "部署の作業フォルダ");
  const targets = readdirSync(workDir).filter((name) => QUARANTINE_NAMES.has(name.toLowerCase()));
  if (targets.length === 0) return [];

  const root = join(workDir, QUARANTINE_DIR);
  ensureRealDir(root);
  const dest = join(root, runId);
  ensureRealDir(dest);

  const moved: string[] = [];
  for (const name of targets) {
    const from = join(workDir, name);
    try {
      // rename はリンクを辿らず、リンクそのものを移す
      renameSync(from, join(dest, name));
    } catch {
      // 移せなくても、次の実行に残さない
      remove(from);
    }
    moved.push(name);
  }
  return moved;
}

export interface CleanupInput {
  readonly db: StateDb;
  readonly paths: AicoopPaths;
  readonly runId: string;
  /** 箱の部署（作業フォルダ） */
  readonly groupId: string;
  readonly memberId: string;
}

export interface CleanupResult {
  /** 作業フォルダから隔離したもの（作業フォルダからの相対パス） */
  readonly quarantined: readonly string[];
}

/** 5.4.4 の1〜3 をすべて行う。隔離したら監査ログ `quarantine` を書く */
export function cleanupBeforeRun(input: CleanupInput): CleanupResult {
  const { db, paths, runId } = input;
  cleanMemberHome(paths.memberHome(input.memberId));
  const quarantined = quarantineWorkFiles(paths.groupWork(input.groupId), runId);
  if (quarantined.length > 0) {
    appendAudit(db, {
      actor: "system",
      kind: "quarantine",
      subject: runId,
      data: { paths: quarantined },
    });
  }
  return { quarantined };
}
