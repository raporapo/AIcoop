/**
 * Service Worker（vite-plugin-pwa が作る `/app/sw.js`）の登録。
 *
 * 新しい版は知らせるだけにし、オーナーが「読み込み直す」を押したときだけ入れ替える
 * （承認の途中で勝手に読み込み直さない）。workbox-window は使わず、ここで登録する（依存を増やさない）。
 */
import type { UpdateSignal } from "../App.tsx";

export function registerServiceWorker(scriptUrl: string, scope: string): UpdateSignal {
  const listeners = new Set<() => void>();
  let waiting: ServiceWorker | null = null;
  const notify = () => {
    for (const l of listeners) l();
  };

  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker
      .register(scriptUrl, { scope })
      .then((reg) => {
        const watch = (worker: ServiceWorker | null) => {
          if (worker === null) return;
          worker.addEventListener("statechange", () => {
            // 前の版が動いているときだけ「新しい版」（はじめての登録では知らせない）
            if (worker.state === "installed" && navigator.serviceWorker.controller !== null) {
              waiting = worker;
              notify();
            }
          });
        };
        if (reg.waiting !== null && navigator.serviceWorker.controller !== null) {
          waiting = reg.waiting;
          notify();
        }
        reg.addEventListener("updatefound", () => watch(reg.installing));
      })
      .catch(() => {
        // 登録できなくても（プライベートウィンドウなど）、画面は動く
      });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    available: () => waiting !== null,
    apply() {
      if (waiting === null) return;
      navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), {
        once: true,
      });
      waiting.postMessage({ type: "SKIP_WAITING" });
    },
  };
}
