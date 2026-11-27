/**
 * `runtime/` に置く、daemon が動いているあいだだけのファイル（6.1、9.2）。
 *
 * - `daemon.json`：CLI が daemon を見つけるための pid・ポート（`DaemonInfo`）
 * - `api_token`：ローカルAPI のトークン（0600。起動ごとに作り直す）
 * - `daemon.lock`：同じ home で2つの daemon が同時に起動しないための鍵（中身は pid）。
 *   `daemon.json` は待ち受けを始めてから書くので、それより前の二重起動はこの鍵で防ぐ
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { DaemonInfo } from "../api/contract.ts";

function errorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
    ? e.code
    : undefined;
}

/** 本人だけが読み書きできるファイル（0600）を、書きかけを見せずに置き換える */
export function writePrivateFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** `daemon.json` を読む。なければ・読めなければ null */
export function readDaemonInfo(path: string): DaemonInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const v = parsed as Record<string, unknown>;
  if (typeof v.pid !== "number" || typeof v.port !== "number") return null;
  return {
    pid: v.pid,
    port: v.port,
    started_at: typeof v.started_at === "string" ? v.started_at : "",
    home: typeof v.home === "string" ? v.home : "",
    version: typeof v.version === "string" ? v.version : "",
  };
}

/** その pid のプロセスが動いているか（権限がなくて確かめられないものは、動いているとみなす） */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === "EPERM";
  }
}

export interface DaemonLock {
  /** 鍵を外す（中身が自分の pid のときだけ消す） */
  release(): void;
}

export type AcquireLockResult =
  | { readonly ok: true; readonly lock: DaemonLock }
  | { readonly ok: false; readonly pid: number };

/**
 * 鍵を取る。ほかの動いているプロセス（同じプロセスの別の daemon も）が持っていれば取れない。
 * 持ち主のプロセスが動いていない古い鍵は、消してから取り直す。
 */
export function acquireDaemonLock(path: string): AcquireLockResult {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mine = String(process.pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, mine);
      } finally {
        closeSync(fd);
      }
      return {
        ok: true,
        lock: {
          release() {
            try {
              if (readFileSync(path, "utf8").trim() === mine) rmSync(path, { force: true });
            } catch {
              // すでにない
            }
          },
        },
      };
    } catch (e) {
      if (errorCode(e) !== "EEXIST") throw e;
    }
    let owner = Number.NaN;
    try {
      owner = Number(readFileSync(path, "utf8").trim());
    } catch {
      // 読めなければ古いものとして扱う
    }
    if (isProcessAlive(owner)) return { ok: false, pid: owner };
    rmSync(path, { force: true });
  }
  return { ok: false, pid: Number.NaN };
}
