import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { usePolling } from "./polling.ts";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("数秒ごとに読み直す（画面が見えていないときは止める）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  test("はじめに1回、そのあと間隔ごとに呼ぶ", async () => {
    const load = vi.fn(async () => {});
    renderHook(() => usePolling(load, 5000));
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(load).toHaveBeenCalledTimes(3);
  });

  test("見えていないあいだは呼ばず、見えたらすぐ1回呼ぶ", async () => {
    const load = vi.fn(async () => {});
    renderHook(() => usePolling(load, 5000));
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    act(() => setVisibility("hidden"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => setVisibility("visible"));
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(load).toHaveBeenCalledTimes(3);
  });

  test("前の読み込みが終わるまで、次を始めない（遅い応答が重ならない）", async () => {
    let release: () => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    renderHook(() => usePolling(load, 1000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("画面を離れたら止める", async () => {
    const load = vi.fn(async () => {});
    const { unmount } = renderHook(() => usePolling(load, 1000));
    await act(async () => {});
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(load).toHaveBeenCalledTimes(1);
  });
});
