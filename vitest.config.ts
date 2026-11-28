import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // セキュリティの判定ロジックは、テストの取りこぼしが事故につながる。
    // テストが1件も見つからないときは失敗させる。
    passWithNoTests: false,
    // daemon・CLI の結合テストは、設定の読み込み・state.db・HTTP を本当に動かす。
    // PC が混んでいても時間切れで落ちないように、既定の5秒より長くする
    testTimeout: 20_000,
    hookTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["packages/*/src/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "packages/approver/**"],
        },
      },
      // 承認アプリ（PWA）の画面のテスト（.tsx）。DOM が要るので happy-dom で動かす
      {
        extends: true,
        test: {
          name: "approver",
          include: ["packages/approver/src/**/*.test.{ts,tsx}"],
          environment: "happy-dom",
          // daemon が配る場所と同じ（パスキーの RP ID は localhost。5.8 の1）
          environmentOptions: { happyDOM: { url: "http://localhost:7070/app/" } },
        },
      },
    ],
  },
});
