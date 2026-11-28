/**
 * 数秒ごとの読み直し。画面が見えていないとき（別のタブ・最小化）は止め、見えたらすぐ読み直す。
 * 前の読み込みが終わるまで次を始めない（setInterval ではなく、終わってから次を予約する）。
 */
import { useEffect, useRef, useState } from "react";

/** 読み直しの間隔（5.8 の4「数秒ごと」） */
export const POLL_MS = 5000;

function isVisible(): boolean {
  return document.visibilityState !== "hidden";
}

/**
 * @param load 読み込み（失敗しても止めない。失敗の表示は load の中で行う）
 * @param intervalMs 間隔。null なら最初の1回だけ
 * @param resetKey 変わったら、すぐ読み直して数え直す（画面の ID など）
 */
export function usePolling(
  load: () => Promise<void>,
  intervalMs: number | null = POLL_MS,
  resetKey?: unknown,
): void {
  const loadRef = useRef(load);
  loadRef.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: resetKey が変わったら数え直す
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let disposed = false;

    const schedule = () => {
      clearTimeout(timer);
      if (!disposed && intervalMs !== null && isVisible()) {
        timer = setTimeout(() => void tick(), intervalMs);
      }
    };
    const tick = async () => {
      if (disposed || running || !isVisible()) return;
      running = true;
      try {
        await loadRef.current();
      } catch {
        // 表示は load の中で行う。ここでは止めずに次を予約する
      } finally {
        running = false;
      }
      schedule();
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (isVisible()) void tick();
    };

    document.addEventListener("visibilitychange", onVisibility);
    void tick();
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, resetKey]);
}

/** 今の時刻（ミリ秒）。期限までの残りなどのために、間隔ごとに描き直す */
export function useNow(clock: () => number, intervalMs = 15_000): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const id = setInterval(() => setNow(clock()), intervalMs);
    setNow(clock());
    return () => clearInterval(id);
  }, [clock, intervalMs]);
  return now;
}
