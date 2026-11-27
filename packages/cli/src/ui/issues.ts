/**
 * 設定の誤り（6.10 の E-xxx・W-xxx）の表示。`aicoop check`・`aicoop reload`・`aicoop start`・
 * `aicoop daemon` で同じ形にする。
 */
import type { ConfigIssue } from "@aicoop/shared";
import type { Style } from "./style.ts";
import { cleanBlock } from "./text.ts";

/** ID ごとに、決まった直し方（メッセージに書ききれないもの） */
const FIX_HINTS: Readonly<Record<string, string>> = {
  "E-002": "box: none の部署（ceo）には、役職 ceo の社員を1人だけ置いてください",
  "E-003":
    "box: srt の部署の社員には、サービスの操作を許可できません。操作が要るなら、その部署を box: vm にしてください",
  "E-004":
    "部長（role: manager）は group: executives に置き、manages に担当の部署を1つ書いてください",
  "E-005":
    "github.git.push は mode: hold にできません。main への取り込み（github.pr.merge）を hold にしてください",
  "E-006": "時間制限は55分までです（実行のたびに発行するトークンの有効期限が1時間のため）",
  "E-012": "部長を置くなら、groups.yaml に executives（box: vm）を足してください",
  "E-014": "ceo・executives の部署の ceiling は空（[]）にしてください",
  "W-002":
    "社内のデータを読む社員と、外へ送れる操作を持つ社員を別の部署に分けるか、送る操作を mode: hold にしてください",
  "W-003": "依頼票の can_request が輪になっています。どこかで切ってください",
};

/** メッセージの先頭の「<ファイル> の <場所>：」は、別の列に出すので取る */
function bodyOf(issue: ConfigIssue): string {
  const where = [issue.source, issue.path].filter((s) => s !== undefined && s !== "").join(" の ");
  const prefix = `${where}：`;
  return where !== "" && issue.message.startsWith(prefix)
    ? issue.message.slice(prefix.length)
    : issue.message;
}

export function errorsOf(issues: readonly ConfigIssue[]): ConfigIssue[] {
  return issues.filter((i) => i.code.startsWith("E-"));
}

export function warningsOf(issues: readonly ConfigIssue[]): ConfigIssue[] {
  return issues.filter((i) => !i.code.startsWith("E-"));
}

function renderOne(issue: ConfigIssue, style: Style): string[] {
  const isErr = issue.code.startsWith("E-");
  const mark = isErr ? style.red("✗") : style.yellow("!");
  const code = isErr ? style.red(issue.code) : style.yellow(issue.code);
  const where = [issue.source, issue.path].filter((s) => s !== undefined && s !== "").join("  ");
  const lines = [`  ${mark} ${code}  ${where === "" ? "" : style.bold(where)}`.trimEnd()];
  for (const l of cleanBlock(bodyOf(issue)).split("\n")) lines.push(`           ${l}`);
  const hint = FIX_HINTS[issue.code];
  if (hint) lines.push(`           ${style.dim(`→ ${hint}`)}`);
  return lines;
}

/** エラーと警告を分けて、見出しつきで並べる */
export function renderIssues(
  issues: readonly ConfigIssue[],
  style: Style,
  options: { readonly errorNote?: string } = {},
): string[] {
  const errors = errorsOf(issues);
  const warnings = warningsOf(issues);
  const lines: string[] = [];
  if (errors.length > 0) {
    lines.push(
      style.bold(style.red(`エラー ${errors.length}件`)) +
        (options.errorNote ? `（${options.errorNote}）` : ""),
    );
    for (const e of errors) lines.push(...renderOne(e, style));
  }
  if (warnings.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${style.bold(style.yellow(`警告 ${warnings.length}件`))}（動きますが、確かめてください）`,
    );
    for (const w of warnings) lines.push(...renderOne(w, style));
  }
  return lines;
}

/** JSON 向け：ConfigIssue をそのまま（キーをそろえる） */
export function issueJson(issue: ConfigIssue): Record<string, string | null> {
  return {
    code: issue.code,
    message: issue.message,
    source: issue.source ?? null,
    path: issue.path ?? null,
  };
}
