/**
 * `aicoop reload`（9.1、6.1）：POST /reload。エラーなら 422 で、daemon は前の設定のまま。
 */
import type { ReloadResponse } from "@aicoop/daemon";
import { ApiRequestError, apiFailure, DaemonClient } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { EXIT } from "../exit-codes.ts";
import { requireInitialized } from "../home.ts";
import { issueJson, renderIssues } from "../ui/issues.ts";

export async function run(input: CommandInput): Promise<number> {
  const { home, values, out, err, ctx } = input;
  requireInitialized(home);
  const client = DaemonClient.connect(ctx, home);
  let result: ReloadResponse;
  try {
    result = await client.post<ReloadResponse>("/reload");
  } catch (e) {
    if (e instanceof ApiRequestError && e.body?.error === "config_invalid") {
      const issues = e.body.issues ?? [];
      if (values.json === true) {
        out.line(JSON.stringify({ ok: false, issues: issues.map(issueJson) }, null, 2));
      } else {
        err.line(
          `${err.style.red("読み直せませんでした。")}設定にエラーがあるので、daemon は前の設定のまま動いています。`,
        );
        err.line("");
        err.lines(renderIssues(issues, err.style));
        err.line("");
        err.line("直したら、aicoop check で確かめてから、もう一度 aicoop reload してください。");
      }
      return EXIT.failure;
    }
    throw apiFailure(e, home);
  }
  if (values.json === true) {
    out.line(
      JSON.stringify(
        { ok: true, warnings: result.warnings.map(issueJson), files: result.files },
        null,
        2,
      ),
    );
    return EXIT.ok;
  }
  const count = Object.keys(result.files ?? {}).length;
  out.line(`${out.style.green("✓")} 設定を読み直しました（${count}ファイル）`);
  out.line(out.style.dim("    動いている実行は、始まったときの設定のまま最後まで動きます"));
  if (result.warnings.length > 0) {
    out.line("");
    out.lines(renderIssues(result.warnings, out.style));
  }
  return EXIT.ok;
}
