/**
 * 設定・資格の変更の確かめと、パスキーでの署名（5.14 の4の3・5）。設定の画面・資格の画面と、
 * 準備の画面（Claude へのログイン・GitHub の登録）で使い回す。
 *
 * - 表示するのは、daemon が変更を作ったときに返した要約そのもの（`summary`）。署名の前に、その正規化JSON の
 *   SHA-256 が payload の `summary_sha256` と合うかを確かめる（ApprovalPanel → signDecision。合わなければ署名しない）
 * - 「保存する」が承認（approve）、「取り消す」が却下（reject）
 */
import type {
  ApprovalAssertResponse,
  ConfigChangeSummary,
  ConfigIssue,
  SecretChangeSummary,
} from "@aicoop/shared/api";
import { useApp } from "../lib/context.tsx";
import { formatDateTime } from "../lib/time.ts";
import { ApprovalPanel } from "./ApprovalPanel.tsx";
import { IssueList } from "./IssueList.tsx";
import { SafeText } from "./text.tsx";

const SAVE_TEXTS = {
  heading: "保存する",
  doneText: { approve: "保存しました。", reject: "取り消しました。" },
  buttonText: { approve: "保存する…", reject: "取り消す…" },
  failText: { approve: "保存できませんでした。", reject: "取り消せませんでした。" },
} as const;

const STATUS_TEXT: Readonly<Record<string, string>> = {
  applied: "保存しました（設定を読み直しました）",
  cancelled: "取り消しました（何も変えていません）",
};

function statusText(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

export interface ConfigChangeReviewProps {
  readonly id: string;
  readonly summary: ConfigChangeSummary;
  readonly warnings: readonly ConfigIssue[];
  readonly expiresAt: string;
  readonly onSettled: (response: ApprovalAssertResponse | null) => void;
}

/** 1行ずつ、足した・消した行に印を付けて出す */
function DiffView({ path, diff }: { readonly path: string; readonly diff: string }) {
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <figure className="diff-figure" aria-label={`${path} の差分`}>
      <pre className="diff">
        {lines.map((line, i) => {
          const kind = line.startsWith("+++") || line.startsWith("---") ? "head" : line[0];
          const cls =
            kind === "+"
              ? "diff-add"
              : kind === "-"
                ? "diff-del"
                : kind === "@"
                  ? "diff-hunk"
                  : kind === "head"
                    ? "diff-head"
                    : "";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
            <span key={i} className={cls}>
              <SafeText text={line} />
              {"\n"}
            </span>
          );
        })}
      </pre>
    </figure>
  );
}

export function ConfigChangeReview(props: ConfigChangeReviewProps) {
  const app = useApp();
  const { summary } = props;
  const paths = summary.files.map((f) => f.path);
  return (
    <section className="change-review" aria-labelledby="change-heading">
      <h2 id="change-heading">差分</h2>
      <p className="muted small">
        保存するには、この差分を確かめてから、パスキーで署名します（権限が広がるかどうかに関わらず、
        すべての保存で署名します）。この変更は{" "}
        {formatDateTime(props.expiresAt, { now: app.now(), timeZone: app.timeZone })} まで有効です。
      </p>
      {summary.files.map((f) => (
        <div key={f.path} className="change-file">
          <h3>
            <code>
              <SafeText text={f.path} />
            </code>
            {f.before_sha256 === null && <span className="muted">（新しいファイル）</span>}
          </h3>
          <DiffView path={f.path} diff={f.diff} />
        </div>
      ))}
      <IssueList issues={props.warnings} />
      <ApprovalPanel
        type="config_change"
        id={props.id}
        decidable={{ ok: true }}
        displayedSummary={{ value: summary }}
        approveTitle="この変更を保存しますか？"
        approveBody={
          <>
            <p>次のファイルを書き換え、設定を読み直します（aicoop reload と同じ）。</p>
            <ul>
              {paths.map((p) => (
                <li key={p}>
                  <code>
                    <SafeText text={p} />
                  </code>
                </li>
              ))}
            </ul>
            <p>
              動いているタスクは、始まったときの設定のまま最後まで動きます。読み直せなかったら、元に戻します。
            </p>
          </>
        }
        approveLabel="パスキーで署名して保存する"
        rejectTitle="この変更を取り消しますか？"
        rejectBody={<p>ファイルは書き換えません。</p>}
        rejectLabel="パスキーで署名して取り消す"
        onSettled={props.onSettled}
        statusText={statusText}
        {...SAVE_TEXTS}
      />
    </section>
  );
}

const ACTION_TEXT: Readonly<Record<SecretChangeSummary["action"], string>> = {
  create: "登録します",
  replace: "置き換えます（前の中身は消えます）",
  delete: "消します",
};

export interface SecretChangeReviewProps {
  readonly id: string;
  readonly summary: SecretChangeSummary;
  readonly expiresAt: string;
  readonly onSettled: (response: ApprovalAssertResponse | null) => void;
}

export function SecretChangeReview(props: SecretChangeReviewProps) {
  const app = useApp();
  const { summary } = props;
  const what = (
    <>
      資格 <code>{summary.id}</code>（{summary.kind}）を
      {ACTION_TEXT[summary.action] ?? summary.action}
    </>
  );
  return (
    <section className="change-review" aria-labelledby="change-heading">
      <h2 id="change-heading">変更の確かめ</h2>
      <p className="notice notice-info">
        <span aria-hidden="true">ⓘ </span>
        {what}。資格の中身は、この画面にも要約にも出しません。
      </p>
      <p className="muted small">
        パスキーで署名するまで、資格は変わりません。この変更は{" "}
        {formatDateTime(props.expiresAt, { now: app.now(), timeZone: app.timeZone })} まで有効です。
      </p>
      <ApprovalPanel
        type="secret_change"
        id={props.id}
        decidable={{ ok: true }}
        displayedSummary={{ value: summary }}
        approveTitle="この資格の変更を保存しますか？"
        approveBody={
          <p>
            {what}。
            {summary.action === "delete" &&
              "動いている実行には、すでに渡したトークンが残ります（最長1時間）。"}
          </p>
        }
        approveLabel="パスキーで署名して保存する"
        rejectTitle="この資格の変更を取り消しますか？"
        rejectBody={<p>資格は変えません。</p>}
        rejectLabel="パスキーで署名して取り消す"
        onSettled={props.onSettled}
        statusText={statusText}
        {...SAVE_TEXTS}
      />
    </section>
  );
}
