/**
 * 時計とタイマー。cron・順番待ちの見直し・1日1回の片付けは、これを通して時刻を知り、待つ。
 * テストでは時計を進められるもの（`testing/manual-clock.ts`）に差し替える。
 */

export type TimerHandle = unknown;

export interface Timers {
  /** `ms` ミリ秒後に `fn` を1回呼ぶ */
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Node の setTimeout が待てる最大（約24.8日）。これより長く待つときは、区切って待ち直す */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** 本物のタイマー。daemon のプロセスを、タイマーだけで生かし続けない（unref） */
export const systemTimers: Timers = {
  setTimeout(fn, ms) {
    const delay = Math.min(Math.max(0, ms), MAX_TIMER_DELAY_MS);
    const handle = setTimeout(fn, delay);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
