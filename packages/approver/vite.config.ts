import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// 承認アプリは daemon が http://localhost:<daemon.port>/app/ で配る（設計書 5.8 の1）。
// 配信の CSP は script-src 'self'・style-src 'self' なので、inline の script・style は使わない。
export default defineConfig({
  base: "/app/",
  plugins: [
    react(),
    VitePWA({
      // 承認の途中で勝手に読み込み直さないよう、新しい版は知らせるだけ（押したら入れ替える）
      registerType: "prompt",
      injectRegister: null,
      includeAssets: ["icon.svg"],
      manifest: {
        name: "AIcoop 承認",
        short_name: "AIcoop 承認",
        description: "AIcoop の承認アプリ。AI 社員の重い操作を、パスキーで署名して承認・却下します",
        lang: "ja",
        dir: "ltr",
        start_url: "/app/#/pending",
        scope: "/app/",
        display: "standalone",
        theme_color: "#1f3a5f",
        background_color: "#ffffff",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon-maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
      workbox: {
        // 画面のファイルだけを持っておく。API（/api/v1）の応答は Service Worker で控えない
        globPatterns: ["**/*.{js,css,html,svg,webmanifest}"],
        navigateFallback: "/app/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    // 開発用（vite）：daemon の API へ中継する。パスキーのオリジンは daemon と違うので、署名は通らない
    proxy: { "/api": { target: "http://localhost:7070", changeOrigin: true } },
  },
});
