/**
 * 「承認」「却下」（5.8 の3）。どちらも確かめの窓を挟み、パスキーで署名する。
 *
 * - 押せるのは、オーナーの承認を待っていて、期限内で、制御サーバーに届いているときだけ
 *   （届いていなければ押せない。署名を確かめるのは PC なので。5.8 の6）
 * - 失敗（期限切れ・使い回し・もう待っていない、など）は、何が起きて決定がどうなったかを言い、
 *   やり直せるものは、もう一度確かめの窓から始められる
 */
import type {
  ApprovalAssertResponse,
  ApprovalDecision,
  ApprovalSubjectType,
} from "@aicoop/shared/api";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  describeSignFailure,
  type SignFailure,
  type SignStep,
  signDecision,
} from "../lib/approval.ts";
import { useApp } from "../lib/context.tsx";
import { formatClock } from "../lib/time.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { IssueList } from "./IssueList.tsx";

export type Decidable = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface ApprovalPanelProps {
  readonly type: ApprovalSubjectType;
  readonly id: string;
  readonly decidable: Decidable;
  /** 承認だけを止める理由（元のリクエストをまだ開いていない、など）。null なら押せる */
  readonly approveBlocked?: string | null;
  /** 画面に表示した要約（保留のとき）。署名の前に summary_sha256 と照らす */
  readonly displayedSummary?: { readonly value: unknown };
  readonly approveTitle: string;
  readonly approveBody: ReactNode;
  readonly approveLabel: string;
  readonly rejectTitle: string;
  readonly rejectBody: ReactNode;
  readonly rejectLabel: string;
  /** 決まったあと・決まったか分からないとき（親が読み直す） */
  readonly onSettled: (response: ApprovalAssertResponse | null) => void;
  /** 決まったあとの状態の呼び名 */
  readonly statusText: (status: string) => string;
  /** 見出し（既定「あなたの決定」） */
  readonly heading?: string;
  /** 決まったあとの一言（既定「承認しました。」「却下しました。」。設定の画面では「保存しました。」など） */
  readonly doneText?: { readonly approve: string; readonly reject: string };
  /** ボタンの文字（既定「承認する…」「却下する…」） */
  readonly buttonText?: { readonly approve: string; readonly reject: string };
  /** 失敗したときの一言（既定「承認できませんでした。」「却下できませんでした。」） */
  readonly failText?: { readonly approve: string; readonly reject: string };
}

const STEP_TEXT: Readonly<Record<SignStep, string>> = {
  intent: "1/3：制御サーバーに、署名する内容を出してもらっています…",
  passkey: "2/3：パスキーで署名してください（指紋・顔・PIN など。ブラウザの表示に従ってください）",
  assert: "3/3：制御サーバーが署名を確かめています…",
};

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "confirm"; readonly decision: ApprovalDecision }
  | { readonly kind: "signing"; readonly decision: ApprovalDecision; readonly step: SignStep }
  | { readonly kind: "failed"; readonly decision: ApprovalDecision; readonly failure: SignFailure }
  | {
      readonly kind: "done";
      readonly decision: ApprovalDecision;
      readonly response: ApprovalAssertResponse;
    };

export function ApprovalPanel(props: ApprovalPanelProps) {
  const app = useApp();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const messageRef = useRef<HTMLDivElement>(null);
  const busy = phase.kind === "signing";
  const heading = props.heading ?? "あなたの決定";
  const done = props.doneText ?? { approve: "承認しました。", reject: "却下しました。" };
  const buttons = props.buttonText ?? { approve: "承認する…", reject: "却下する…" };
  const fail = props.failText ?? {
    approve: "承認できませんでした。",
    reject: "却下できませんでした。",
  };

  const blocked: string | null = !app.reachable
    ? "制御サーバーに届いていないので、承認・却下はできません（署名を確かめるのは PC です）"
    : props.decidable.ok
      ? null
      : props.decidable.reason;

  // 確かめている途中で待たなくなった（期限切れ・ほかで決まった）・届かなくなったら、窓を閉じる
  useEffect(() => {
    if (blocked !== null && phase.kind === "confirm") setPhase({ kind: "idle" });
  }, [blocked, phase.kind]);

  useEffect(() => {
    if (phase.kind === "failed" || phase.kind === "done") messageRef.current?.focus();
  }, [phase.kind]);

  const start = async (decision: ApprovalDecision) => {
    setPhase({ kind: "signing", decision, step: "intent" });
    const result = await signDecision({
      api: app.api,
      passkeys: app.passkeys,
      type: props.type,
      id: props.id,
      decision,
      ...(props.displayedSummary !== undefined ? { displayedSummary: props.displayedSummary } : {}),
      onStep: (step) => setPhase({ kind: "signing", decision, step }),
    });
    if (result.ok) {
      setPhase({ kind: "done", decision, response: result.response });
      props.onSettled(result.response);
      return;
    }
    setPhase({ kind: "failed", decision, failure: result.failure });
    const view = describeSignFailure(result.failure);
    if (view.unknownOutcome || !view.retry) props.onSettled(null);
  };

  if (phase.kind === "done") {
    const { response, decision } = phase;
    return (
      <section className="decide" aria-labelledby="decide-heading">
        <h2 id="decide-heading">{heading}</h2>
        <div ref={messageRef} tabIndex={-1} className="notice notice-ok" role="status">
          <p>
            <span aria-hidden="true">✓ </span>
            <strong>{decision === "approve" ? done.approve : done.reject}</strong>
            パスキーの署名を制御サーバーが確かめ、決定を記録しました（記録 {response.approval.id}、
            {formatClock(response.approval.verified_at, { timeZone: app.timeZone })}）。
          </p>
          <p>いまの状態：{props.statusText(response.subject_status)}</p>
        </div>
      </section>
    );
  }

  const approveDisabled = busy || blocked !== null || (props.approveBlocked ?? null) !== null;
  const failureView = phase.kind === "failed" ? describeSignFailure(phase.failure) : null;

  return (
    <section className="decide" aria-labelledby="decide-heading">
      <h2 id="decide-heading">{heading}</h2>
      {blocked !== null && (
        <p className="notice notice-info">
          <span aria-hidden="true">ⓘ </span>
          {blocked}
        </p>
      )}
      <div className="decide-actions">
        <button
          type="button"
          className="button-approve"
          disabled={approveDisabled}
          onClick={() => setPhase({ kind: "confirm", decision: "approve" })}
        >
          <span aria-hidden="true">✓ </span>
          {buttons.approve}
        </button>
        <button
          type="button"
          className="button-reject"
          disabled={busy || blocked !== null}
          onClick={() => setPhase({ kind: "confirm", decision: "reject" })}
        >
          <span aria-hidden="true">✕ </span>
          {buttons.reject}
        </button>
      </div>
      {blocked === null && props.approveBlocked && (
        <p className="notice notice-warn">
          <span aria-hidden="true">⚠ </span>
          {props.approveBlocked}
        </p>
      )}
      <p className="muted small">
        承認も却下も、この端末のパスキーで署名します。署名の期限は2分です。
      </p>

      {phase.kind === "signing" && (
        <p className="notice notice-info" role="status" aria-live="polite">
          <span aria-hidden="true">… </span>
          {STEP_TEXT[phase.step]}
        </p>
      )}

      {failureView !== null && phase.kind === "failed" && (
        <div ref={messageRef} tabIndex={-1} className="notice notice-error" role="alert">
          <p>
            <span aria-hidden="true">✕ </span>
            <strong>{phase.decision === "approve" ? fail.approve : fail.reject}</strong>
            {failureView.message}
          </p>
          <p>{failureView.hint}</p>
          {phase.failure.kind === "api" && phase.failure.error.issues !== undefined && (
            <IssueList issues={phase.failure.error.issues} />
          )}
          {failureView.retry && blocked === null && (
            <button
              type="button"
              onClick={() => setPhase({ kind: "confirm", decision: phase.decision })}
              disabled={phase.decision === "approve" && approveDisabled}
            >
              もう一度やり直す…
            </button>
          )}
        </div>
      )}

      {phase.kind === "confirm" && (
        <ConfirmDialog
          title={phase.decision === "approve" ? props.approveTitle : props.rejectTitle}
          confirmLabel={phase.decision === "approve" ? props.approveLabel : props.rejectLabel}
          tone={phase.decision === "approve" ? "danger" : "primary"}
          onCancel={() => setPhase({ kind: "idle" })}
          onConfirm={() => void start(phase.decision)}
        >
          {phase.decision === "approve" ? props.approveBody : props.rejectBody}
        </ConfirmDialog>
      )}
    </section>
  );
}
