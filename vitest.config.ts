import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // セキュリティの判定ロジックは、テストの取りこぼしが事故につながる。
    // テストが1件も見つからないときは失敗させる。
    passWithNoTests: false,
    // daemon・CLI の結合テストは、設定の読み込み・state.db・HTTP を本当に動かす。
    // PC が混んでいても時間切れで落ちないように、既定の5秒より長くする
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
