/**
 * 実行ごとに書くファイル。
 *
 * - ホームの `.claude/CLAUDE.md`（5.4.3 の1）と、空の `.claude/settings.json`（5.4.4 の1）
 * - `runtime/<run_id>/`（5.1.7）：
 *   - `etc/mcp.json`（5.3.1 の5。道具ゲート1つだけ。その実行のゲートのトークンを含む）
 *   - `managed/managed-settings.json`（5.3.8）
 *   - `skills/<name>/`（5.3.6。役職の `skills` だけを `~/.aicoop/skills/` から複製する）
 *
 * `runtime/<run_id>/` は実行の終わりに消す（6.1）。
 */
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isId } from "@aicoop/shared";
import type { AicoopPaths } from "../paths.ts";
import { managedSettings, mcpConfig } from "./managed-settings.ts";

/** ホームの `.claude/` に CLAUDE.md と `{}` の settings.json を書く（毎回上書きする） */
export function writeHomeClaudeFiles(homeDir: string, claudeMd: string): void {
  const dir = join(homeDir, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), claudeMd);
  writeFileSync(join(dir, "settings.json"), "{}\n");
}

export interface RuntimeDirResult {
  /** 複製したスキル */
  readonly copied: readonly string[];
  /** `~/.aicoop/skills/` に無かった（またはフォルダでなかった）スキル */
  readonly missing: readonly string[];
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface RuntimeDirOptions {
  /** その実行の道具ゲートのトークン（mcp.json の Authorization ヘッダーに書く） */
  readonly gatewayToken: string;
}

/** `runtime/<run_id>/` を作り、MCP の設定・管理設定・スキルを置く */
export function prepareRuntimeDir(
  paths: AicoopPaths,
  runId: string,
  skills: readonly string[],
  options: RuntimeDirOptions,
): RuntimeDirResult {
  const etc = paths.runEtc(runId);
  const managed = paths.runManaged(runId);
  const skillsDir = paths.runSkills(runId);
  for (const dir of [etc, managed, skillsDir]) mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(etc, "mcp.json"),
    `${JSON.stringify(mcpConfig(options.gatewayToken), null, 2)}\n`,
  );
  writeFileSync(
    join(managed, "managed-settings.json"),
    `${JSON.stringify(managedSettings(), null, 2)}\n`,
  );

  const copied: string[] = [];
  const missing: string[] = [];
  for (const name of new Set(skills)) {
    const source = join(paths.skillsDir, name);
    const st = SKILL_NAME.test(name) ? lstatOrNull(source) : null;
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) {
      missing.push(name);
      continue;
    }
    copyTree(source, join(skillsDir, name));
    copied.push(name);
  }
  return { copied, missing };
}

/**
 * ふつうのファイルとフォルダだけを複製する。リンクは複製しない
 * （箱の中でリンクの先が読めてしまう・ホストのパスを指していることがあるので）。
 */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    const st = lstatSync(source);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) copyTree(source, join(to, name));
    else if (st.isFile()) copyFileSync(source, join(to, name));
  }
}

/** 実行の終わりに `runtime/<run_id>/` を消す。何度呼んでもよい */
export function removeRuntimeDir(paths: AicoopPaths, runId: string): void {
  rmSync(paths.runDir(runId), { recursive: true, force: true });
}

/**
 * 制御サーバーの起動のとき（まだどの実行も動いていないとき）に、前の制御サーバーが落ちて残した
 * `runtime/<run_id>/` をすべて消す（8.6）。消した実行の ID を返す。実行のフォルダ（`r_...`）以外は触らない
 */
export function removeStaleRuntimeDirs(paths: AicoopPaths): string[] {
  let names: string[];
  try {
    names = readdirSync(paths.runtimeDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!isId(name, "run")) continue;
    rmSync(join(paths.runtimeDir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
