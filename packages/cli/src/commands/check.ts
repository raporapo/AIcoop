/**
 * `aicoop check`（9.1、6.10）：設定を検証し、エラーと警告を、ファイル・場所・直し方つきで出す。
 * 続けて「準備の確認」（エラーにはしない）を出す。
 *
 * 終了コード：エラーがあれば 1、警告だけなら 0。
 */
import { loadConfig } from "@aicoop/shared";
import type { CommandInput } from "../command.ts";
import { EXIT } from "../exit-codes.ts";
import { requireInitialized, shortPath } from "../home.ts";
import { checkReadiness } from "../readiness.ts";
import { errorsOf, issueJson, renderIssues, warningsOf } from "../ui/issues.ts";
import { readinessJson, renderReadiness } from "../ui/readiness.ts";

export async function run(input: CommandInput): Promise<number> {
  const { home, values, out, ctx } = input;
  requireInitialized(home);

  const result = loadConfig(home, { now: ctx.deps.now() });
  const issues = result.ok ? result.warnings : result.issues;
  const errors = errorsOf(issues);
  const warnings = warningsOf(issues);
  const readiness = await checkReadiness(ctx, home, result.ok ? result.config : undefined);

  if (values.json === true) {
    out.line(
      JSON.stringify(
        {
          ok: errors.length === 0,
          home,
          errors: errors.map(issueJson),
          warnings: warnings.map(issueJson),
          readiness: readiness.map(readinessJson),
        },
        null,
        2,
      ),
    );
    return errors.length > 0 ? EXIT.failure : EXIT.ok;
  }

  const style = out.style;
  out.line(`設定を確かめました（${shortPath(home, ctx.userHome)}）`);
  out.line("");
  if (issues.length === 0) {
    out.line(`${style.green("✓")} エラーも警告もありません`);
  } else {
    out.lines(renderIssues(issues, style, { errorNote: "直すまで daemon は起動しません" }));
  }
  out.line("");
  out.line(style.bold("準備の確認"));
  out.lines(renderReadiness(readiness, style));
  out.line("");
  if (errors.length > 0) {
    out.line(`${style.red("エラーを直してから")}、もう一度 aicoop check を実行してください。`);
  } else if (readiness.some((r) => !r.ok)) {
    out.line("設定は通りました。動かす前に、上の → の準備をしてください。");
  } else {
    out.line(`${style.green("準備ができています。")}aicoop start で起動できます。`);
  }
  return errors.length > 0 ? EXIT.failure : EXIT.ok;
}
