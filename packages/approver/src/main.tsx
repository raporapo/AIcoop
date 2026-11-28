/**
 * 承認アプリの入口。Service Worker を登録し（新しい版は知らせるだけ）、画面を描く。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { safeLocalStorage } from "./lib/cache.ts";
import type { AppDeps } from "./lib/context.tsx";
import { createPasskeys } from "./lib/passkeys.ts";
import { POLL_MS } from "./lib/polling.ts";
import { registerServiceWorker } from "./lib/pwa.ts";
import "./styles.css";

async function deps(): Promise<AppDeps> {
  const real: AppDeps = {
    fetch: (input, init) => window.fetch(input, init),
    passkeys: createPasskeys(),
    storage: safeLocalStorage(),
    now: Date.now,
    pollMs: POLL_MS,
  };
  // 開発用のサーバー（vite）で `?mock` を付けたときだけ、偽の API で画面を見る（本番のビルドには入らない）
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has("mock")) {
    const mock = await import("./dev/mock.ts");
    return { ...real, fetch: mock.mockFetch(), passkeys: mock.mockPasskeys, storage: null };
  }
  return real;
}

const base = import.meta.env.BASE_URL;
// 開発用のサーバー（vite）では Service Worker を使わない（古い画面が残って紛らわしい）
const update = import.meta.env.PROD ? registerServiceWorker(`${base}sw.js`, base) : undefined;

const root = document.getElementById("root");
if (root !== null) {
  const container = root;
  void deps().then((d) => {
    createRoot(container).render(
      <StrictMode>
        <App deps={d} {...(update !== undefined ? { update } : {})} />
      </StrictMode>,
    );
  });
}
