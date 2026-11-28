/**
 * テスト用：承認アプリ全体を、偽の API・偽のパスキー・決まった時計で描く。
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { App } from "../App.tsx";
import type { AppDeps } from "../lib/context.tsx";
import { createPasskeys } from "../lib/passkeys.ts";
import { createFakeApi, type FakeApi, type FakeHandler, memoryStorage, ok } from "./fake-api.ts";
import { ME, NOW } from "./fixtures.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

export interface RenderOptions {
  readonly hash?: string;
  readonly routes?: Record<string, FakeHandler>;
  /** ログインしていない（`/auth/me` が 401）なら null */
  readonly me?: typeof ME | null;
  readonly storage?: Storage;
  readonly now?: () => number;
  readonly api?: FakeApi;
  /** 読み直しの間隔（既定 null：読み直さない） */
  readonly pollMs?: number | null;
}

export function renderApp(options: RenderOptions = {}) {
  const api = options.api ?? createFakeApi();
  api.on(
    "GET /auth/me",
    options.me === null
      ? { status: 401, body: { error: "unauthorized", message: "ログインしてください" } }
      : ok(options.me ?? ME),
  );
  for (const [route, handler] of Object.entries(options.routes ?? {})) api.on(route, handler);
  window.location.hash = options.hash ?? "#/pending";
  const storage = options.storage ?? memoryStorage();
  const deps: AppDeps = {
    fetch: api.fetch,
    passkeys: createPasskeys(options.now ?? (() => NOW)),
    storage,
    now: options.now ?? (() => NOW),
    timeZone: "Asia/Tokyo",
    pollMs: options.pollMs ?? null,
  };
  const view = render(<App deps={deps} />);
  return { ...view, api, storage };
}

/** ハッシュを変えて、画面が切り替わるのを待つ */
export async function go(hash: string): Promise<void> {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
