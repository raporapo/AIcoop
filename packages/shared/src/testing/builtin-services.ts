/**
 * テスト用：リポジトリの services/*.yaml（組み込みのサービス定義）を読む。
 * 本番の読み込み（~/.aicoop/services/ との重ね合わせ）は、設定の読み込みを作るときに別に作る。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseServiceYaml, type ServiceDefinition } from "../service.ts";

export const BUILTIN_SERVICES_DIR = fileURLToPath(
  new URL("../../../../services/", import.meta.url),
);

export function loadBuiltinServices(): ServiceDefinition[] {
  return readdirSync(BUILTIN_SERVICES_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((file) => {
      const result = parseServiceYaml(readFileSync(join(BUILTIN_SERVICES_DIR, file), "utf8"), file);
      if (!result.ok) {
        throw new Error(`${file} を読めません: ${JSON.stringify(result.issues, null, 2)}`);
      }
      return result.value;
    });
}
