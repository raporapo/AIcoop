/**
 * テスト用：リポジトリの services/*.yaml（組み込みのサービス定義）を読む。
 * 本番の読み込み（~/.aicoop/services/ との重ね合わせ）は config/load.ts の loadConfig。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinServicesDir } from "../config/paths.ts";
import { parseServiceYaml, type ServiceDefinition } from "../service.ts";

export function loadBuiltinServices(): ServiceDefinition[] {
  const dir = builtinServicesDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((file) => {
      const result = parseServiceYaml(readFileSync(join(dir, file), "utf8"), file);
      if (!result.ok) {
        throw new Error(`${file} を読めません: ${JSON.stringify(result.issues, null, 2)}`);
      }
      return result.value;
    });
}
