/**
 * テスト用：時計を進められる state.db と、一時ディレクトリ。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStateDb, type StateDb } from "../db/open.ts";

export interface FakeClock {
  now(): Date;
  advance(ms: number): void;
  set(iso: string): void;
}

export function fakeClock(start = "2026-11-28T00:00:00.000Z"): FakeClock {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
    },
    set(iso) {
      t = Date.parse(iso);
    },
  };
}

/** メモリの中の state.db（テストごとに新しい） */
export function memoryDb(start?: string): { db: StateDb; clock: FakeClock } {
  const clock = fakeClock(start);
  return { db: openStateDb(":memory:", { now: clock.now }), clock };
}

export interface TempDir {
  readonly path: string;
  cleanup(): void;
}

export function tempDir(): TempDir {
  const path = mkdtempSync(join(tmpdir(), "aicoop-test-"));
  return {
    path,
    cleanup() {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
