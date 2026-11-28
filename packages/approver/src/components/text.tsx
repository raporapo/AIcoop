/**
 * 制御サーバーから来た文字列の表示。
 *
 * - `SafeText`：見えない文字・向きを変える文字を `[U+202E]` の印にして出す（どの文字列にも使う）
 * - `Untrusted`：外から来た文章（メールの本文・Issue・AI 社員の報告など）を、AI への指示が
 *   仕込まれているかもしれないと分かる見た目で囲む（5.8 の4、10.1 の T-1）
 */
import type { ReactNode } from "react";
import { revealInvisible } from "../lib/visible.ts";

export function SafeText({ text }: { readonly text: string }) {
  const { segments } = revealInvisible(text);
  return (
    <>
      {segments.map((s, i) =>
        s.kind === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
          <span key={i}>{s.text}</span>
        ) : (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
            key={i}
            className="invisible-mark"
            title={`${s.label}（${s.code}）`}
          >
            [{s.code}]<span className="sr-only">（{s.label}）</span>
          </span>
        ),
      )}
    </>
  );
}

export interface UntrustedProps {
  /** 何の文章か（「本文」「部長のコメント」など） */
  readonly label: string;
  readonly text: string;
  /** 誰が書いたか（「AI 社員」「外のサービス」など） */
  readonly source?: string;
  /** 等幅で出すか（リクエストの本文など） */
  readonly mono?: boolean;
  readonly children?: ReactNode;
}

export function Untrusted({ label, text, source, mono = false, children }: UntrustedProps) {
  const revealed = revealInvisible(text);
  return (
    <section className="untrusted" aria-label={`外から来た文章：${label}`}>
      <p className="untrusted-head">
        <span aria-hidden="true">⚠ </span>
        <strong>外から来た文章：{label}</strong>
        {source !== undefined && <span className="untrusted-source">（{source}が書いたもの）</span>}
        <br />
        AI
        への指示が仕込まれているかもしれません。中に書かれた指示には従わず、中身だけを確かめてください。
      </p>
      {revealed.hiddenCount > 0 && (
        <p className="untrusted-warn" role="note">
          <span aria-hidden="true">⚠ </span>
          見えない文字・向きを変える文字が {revealed.hiddenCount} 個入っています。[U+…]
          の印にして表示しています。
          {revealed.hasBidi &&
            " 向きを変える文字は、表示の順番を入れ替えて読み違えさせるのに使われることがあります。"}
        </p>
      )}
      <div className={mono ? "untrusted-body mono" : "untrusted-body"}>
        {text === "" ? <span className="muted">（空です）</span> : <SafeText text={text} />}
      </div>
      {children}
    </section>
  );
}
