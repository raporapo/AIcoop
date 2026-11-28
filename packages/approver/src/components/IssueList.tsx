/**
 * 設定の誤り（6.10 の E-xxx）と警告（W-xxx）の一覧。設定の画面・準備の画面で使う。
 */
import type { ConfigIssue } from "@aicoop/shared/api";
import { SafeText } from "./text.tsx";

export function IssueList({
  issues,
  title,
}: {
  readonly issues: readonly ConfigIssue[];
  readonly title?: string;
}) {
  if (issues.length === 0) return null;
  const errors = issues.filter((i) => i.code.startsWith("E-"));
  const warnings = issues.filter((i) => !i.code.startsWith("E-"));
  const item = (i: ConfigIssue, n: number) => (
    <li key={`${i.code}-${n}`}>
      <strong>{i.code}</strong>
      {i.source !== undefined && (
        <>
          {" "}
          <code>
            <SafeText text={i.source} />
          </code>
        </>
      )}
      {i.path !== undefined && i.path !== "" && (
        <span className="muted">
          {" "}
          （<SafeText text={i.path} />）
        </span>
      )}
      ：<SafeText text={i.message} />
    </li>
  );
  return (
    <div className="issues">
      {title !== undefined && <h3>{title}</h3>}
      {errors.length > 0 && (
        <div className="notice notice-error" role="alert">
          <p>
            <span aria-hidden="true">✕ </span>
            <strong>エラー {errors.length}件</strong>（直すまで保存できません）
          </p>
          <ul>{errors.map(item)}</ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="notice notice-warn" role="status">
          <p>
            <span aria-hidden="true">⚠ </span>
            <strong>警告 {warnings.length}件</strong>（このまま保存できます）
          </p>
          <ul>{warnings.map(item)}</ul>
        </div>
      )}
    </div>
  );
}
