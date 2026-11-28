/**
 * API から読んで、数秒ごとに読み直すデータ。
 *
 * - 届かないとき（offline）は、前に読めたものを出したまま（`stale`）にする。まだ何も読めていなければ、
 *   控え（`cache`）があればそれを出す
 * - `key`（画面の ID など）が変わったら、前の画面のデータは決して出さない（取り違えを防ぐ）
 */
import { useCallback, useRef, useState } from "react";
import { ApiFailure } from "../api/client.ts";
import { useApp } from "./context.tsx";
import { usePolling } from "./polling.ts";

export interface Resource<T> {
  readonly data: T | undefined;
  readonly error: ApiFailure | undefined;
  /** まだ1回も読み終えていない */
  readonly loading: boolean;
  /** 表示しているのが、制御サーバーから今読めたものでないとき（控え・前に読めたもの）の時刻 */
  readonly staleSince: number | null;
  readonly reload: () => Promise<void>;
}

export interface ResourceOptions<T> {
  readonly key: string;
  /** 読み直すか（既定 true） */
  readonly poll?: boolean;
  /** 届かないときの控え。`sanitize` で中身を除いてから書く */
  readonly cache?: { readonly name: string; readonly sanitize?: (value: T) => unknown };
}

export function toFailure(error: unknown): ApiFailure {
  if (error instanceof ApiFailure) return error;
  return new ApiFailure(
    0,
    "internal",
    "承認アプリの中で思わぬエラーが起きました。読み込み直してください",
  );
}

interface State<T> {
  readonly key: string;
  readonly data: T | undefined;
  readonly error: ApiFailure | undefined;
  readonly done: boolean;
  readonly staleSince: number | null;
}

export function useResource<T>(load: () => Promise<T>, options: ResourceOptions<T>): Resource<T> {
  const app = useApp();
  const { key } = options;
  const [state, setState] = useState<State<T>>({
    key,
    data: undefined,
    error: undefined,
    done: false,
    staleSince: null,
  });
  const loadRef = useRef(load);
  loadRef.current = load;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const keyRef = useRef(key);
  keyRef.current = key;

  const run = useCallback(async () => {
    const { cache } = optionsRef.current;
    try {
      const value = await loadRef.current();
      // 待っているあいだに別の画面（別の ID）に移っていたら、古い結果は捨てる
      if (keyRef.current !== key) return;
      if (cache !== undefined) {
        app.cache.write(cache.name, cache.sanitize ? cache.sanitize(value) : value, app.now());
      }
      setState({ key, data: value, error: undefined, done: true, staleSince: null });
    } catch (e) {
      if (keyRef.current !== key) return;
      const failure = toFailure(e);
      setState((prev) => {
        const same = prev.key === key;
        if (failure.code === "offline") {
          if (same && prev.data !== undefined) {
            return {
              ...prev,
              error: failure,
              done: true,
              staleSince: prev.staleSince ?? app.now(),
            };
          }
          const snap = cache !== undefined ? app.cache.read<T>(cache.name) : null;
          if (snap !== null) {
            return { key, data: snap.value, error: failure, done: true, staleSince: snap.savedAt };
          }
        }
        return {
          key,
          data: same && failure.code === "offline" ? prev.data : undefined,
          error: failure,
          done: true,
          staleSince: null,
        };
      });
    }
  }, [app, key]);

  usePolling(run, options.poll === false ? null : app.pollMs, key);

  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: !current || !state.done,
    staleSince: current ? state.staleSince : null,
    reload: run,
  };
}
