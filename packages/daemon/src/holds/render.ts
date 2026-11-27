/**
 * 要約を、部長のレビューのタスク本文（5.7.1 の2）に入れる文章にする。
 *
 * この文章は、AI社員が書いた中身（メールの本文・申請の理由など）を含むので、タスクでは
 * 外から来た文章として囲む（`context_untrusted`）。
 */
import type { HoldSummary } from "./prepare.ts";

export interface GrantSummary {
  readonly kind: "grant";
  readonly member_id: string;
  /** `<service>.<operation>` */
  readonly operation: string;
  readonly params: Readonly<Record<string, readonly string[]>>;
  readonly mode: "allow" | "hold";
  readonly duration_hours: number;
  readonly reason: string;
  readonly manager_comment: string | null;
}

const list = (values: readonly string[]) => (values.length === 0 ? "（なし）" : values.join(" / "));

export function renderHoldSummary(summary: HoldSummary): string {
  const lines: string[] = [];
  switch (summary.kind) {
    case "gmail_message":
      lines.push(
        "要約の種類：メールの送信（gmail_message）",
        summary.source === "draft"
          ? `送る中身：下書き ${summary.draft_id ?? ""} の、保留にした時点の中身（承認のあとで下書きを書き換えても、送る中身は変わりません）`
          : "送る中身：messages/send の本文（raw）",
        `From：${list(summary.from)}`,
        `To：${list(summary.to)}`,
        `Cc：${list(summary.cc)}`,
        `Bcc：${list(summary.bcc)}`,
        `件名：${list(summary.subject)}`,
        `添付ファイル：${list(summary.attachments)}`,
        `本文（${summary.body_kind === "html" ? "HTML" : "テキスト"}${summary.body_truncated ? "、先頭4000文字" : ""}）：`,
        summary.body_text === "" ? "（なし）" : summary.body_text,
      );
      break;
    case "github_pr_merge":
      lines.push(
        "要約の種類：Pull Request のマージ（github_pr_merge）",
        `リポジトリ：${summary.repo}`,
        `PR：#${summary.number}「${summary.title}」`,
        `変更ファイル数：${summary.changed_files}`,
        `マージする head：${summary.head_sha}（${summary.head_ref ?? "?"} → ${summary.base_ref ?? "?"}）`,
        `マージの方法：${summary.merge_method ?? "（指定なし）"}`,
      );
      break;
    case "default":
      lines.push(
        "要約の種類：指定なし",
        `メソッド：${summary.method}`,
        `URL：${summary.url}`,
        `本文：${summary.body_bytes} バイト。先頭${summary.body_truncated ? "2KB" : ""}（${summary.body_head_encoding === "text" ? "テキスト" : "base64"}）：`,
        summary.body_head === "" ? "（なし）" : summary.body_head,
      );
      break;
  }
  if (summary.warnings.length > 0) {
    lines.push("注意：", ...summary.warnings.map((w) => `- ${w}`));
  }
  return lines.join("\n");
}

export function renderGrantSummary(summary: GrantSummary): string {
  const params = Object.entries(summary.params);
  return [
    `申請した社員：${summary.member_id}`,
    `操作：${summary.operation}（${summary.mode === "hold" ? "承認が要る操作として" : "そのまま使える操作として"}）`,
    `対象：${params.length === 0 ? "部署の上限の範囲すべて" : params.map(([k, v]) => `${k} = ${v.join(" / ")}`).join("、")}`,
    `時間：${summary.duration_hours}時間（オーナーが承認した時刻から）`,
    "理由：",
    summary.reason,
  ].join("\n");
}
