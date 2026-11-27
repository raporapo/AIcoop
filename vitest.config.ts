import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // セキュリティの判定ロジックは、テストの取りこぼしが事故につながる。
    // テストが1件も見つからないときは失敗させる。
    passWithNoTests: false,
  },
});
