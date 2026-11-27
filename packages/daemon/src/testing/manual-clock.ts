/**
 * テスト用：手で進める時計とタイマー。`advance` した分だけ時刻が進み、その間に来るタイマーを順に呼ぶ。
 */
import type { TimerHandle, Timers } from "../timers.ts";

export interface ManualClock extends Timers {
  now(): Date;
  /** 時刻を `ms` 進め、その間に来るタイマーを時刻の順に呼ぶ（呼ばれた中で足されたものも） */
  advance(ms: number): void;
  /** `iso` の時刻まで進める（戻すことはできない） */
  advanceTo(iso: string): void;
  /**
   * PCが眠っていたように、時刻を一気に `ms` 進めてから、その時点で来ているタイマーを1回ずつ呼ぶ
   * （呼ばれた中で足されたものは、新しい時刻から数える）
   */
  jump(ms: number): void;
  /** まだ呼ばれていないタイマーの数 */
  pending(): number;
}

interface Entry {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

export function manualClock(start = "2026-11-28T00:00:00.000Z"): ManualClock {
  let t = Date.parse(start);
  let nextId = 1;
  const entries = new Map<number, Entry>();

  const runUntil = (target: number) => {
    for (;;) {
      let first: Entry | undefined;
      for (const e of entries.values()) {
        if (
          e.at <= target &&
          (first === undefined || e.at < first.at || (e.at === first.at && e.id < first.id))
        ) {
          first = e;
        }
      }
      if (first === undefined) break;
      entries.delete(first.id);
      t = Math.max(t, first.at);
      first.fn();
    }
    t = target;
  };

  return {
    now: () => new Date(t),
    setTimeout(fn, ms): TimerHandle {
      const id = nextId++;
      entries.set(id, { id, at: t + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(handle) {
      if (typeof handle === "number") entries.delete(handle);
    },
    advance(ms) {
      runUntil(t + ms);
    },
    advanceTo(iso) {
      const target = Date.parse(iso);
      if (target < t) throw new Error("時計は戻せません");
      runUntil(target);
    },
    jump(ms) {
      t += ms;
      runUntil(t);
    },
    pending: () => entries.size,
  };
}
