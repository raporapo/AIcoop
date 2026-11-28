/**
 * 5.8 の4 (2) 承認待ちの詳細（保留）：要約・部長のコメント・元のリクエスト全体（10.2）と、
 * 承認・却下（5.8 の3）。決まったら結果（再送のステータスと応答）を見せる。
 */
import type { HoldDetailView } from "@aicoop/shared/api";
import { useState } from "react";
import { ApprovalPanel, type Decidable } from "../components/ApprovalPanel.tsx";
import { SafeText, Untrusted } from "../components/text.tsx";
import {
  Badge,
  DeadlineText,
  LoadFailed,
  Loading,
  StaleNote,
  TimeText,
} from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { decodeGmailRaw } from "../lib/gmail.ts";
import {
  deciderLabel,
  HOLD_STATUS_LABELS,
  operationId,
  operationLabel,
  statusLabel,
} from "../lib/labels.ts";
import { useNow } from "../lib/polling.ts";
import { useResource } from "../lib/resource.ts";
import { hrefOf } from "../lib/router.ts";
import { describeSummary, formatBytes, type SummaryField, shortSummary } from "../lib/summary.ts";
import { deadline } from "../lib/time.ts";

function FieldValue({ field }: { readonly field: SummaryField }) {
  const { value } = field;
  if (field.prose && value.type === "text") {
    return <Untrusted label={field.label} text={value.text} source="AI 社員・外の人" />;
  }
  switch (value.type) {
    case "empty":
      return <span className="muted">（なし）</span>;
    case "text":
      return <SafeText text={value.text} />;
    case "list":
      return value.items.length === 0 ? (
        <span className="muted">（なし）</span>
      ) : (
        <ul className="plain-list">
          {value.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
            <li key={i}>
              <SafeText text={item} />
            </li>
          ))}
        </ul>
      );
    case "json":
      return <Untrusted label={field.label} text={value.text} mono />;
  }
}

function responseText(status: number): string {
  return status >= 200 && status < 300 ? `HTTP ${status}（成功）` : `HTTP ${status}（失敗）`;
}

function RequestSection({
  hold,
  required,
  onOpened,
}: {
  readonly hold: HoldDetailView;
  readonly required: boolean;
  readonly onOpened: () => void;
}) {
  const { request } = hold;
  const mail = hold.service === "gmail" ? decodeGmailRaw(request.body_text) : null;
  return (
    <section aria-labelledby="request-heading" className="section">
      <h2 id="request-heading">元のリクエスト全体</h2>
      {required ? (
        <p className="notice notice-warn">
          <span aria-hidden="true">⚠ </span>
          送る前に、元のリクエストを開いて中身を確かめてください。要約に出ない部分（隠れた宛先・添付・HTML
          など）があるかもしれません（10.2）。開くまで「承認する」は押せません。
        </p>
      ) : (
        <p className="notice notice-info">
          <span aria-hidden="true">ⓘ </span>
          要約に出ない部分があるかもしれません。開いて確かめることをすすめます（10.2）。
        </p>
      )}
      <details
        className="request"
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open) onOpened();
        }}
      >
        <summary>
          元のリクエストを開く（{request.method}、本文 {formatBytes(request.body_bytes)}）
        </summary>
        <dl className="meta">
          <dt>メソッド</dt>
          <dd>
            <SafeText text={request.method} />
          </dd>
          <dt>URL</dt>
          <dd className="mono break">
            <SafeText text={request.url} />
          </dd>
          <dt>ヘッダー</dt>
          <dd>
            <table className="headers">
              <tbody>
                {Object.entries(request.headers).map(([k, v]) => (
                  <tr key={k}>
                    <th scope="row">
                      <SafeText text={k} />
                    </th>
                    <td className="mono break">
                      <SafeText text={v} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              認証のヘッダーは保存していません（資格プロキシが送るときに付けます）。
            </p>
          </dd>
        </dl>
        {request.body_text !== null ? (
          <Untrusted label="リクエストの本文" text={request.body_text} source="AI 社員" mono />
        ) : request.body_base64 !== null ? (
          <Untrusted
            label="リクエストの本文（文字として読めないので base64）"
            text={request.body_base64}
            source="AI 社員"
            mono
          />
        ) : (
          <p className="muted">本文はありません。</p>
        )}
        {request.truncated && (
          <p className="notice notice-warn">
            <span aria-hidden="true">⚠ </span>
            本文が大きいので、先頭 256 KiB だけを表示しています（全体は{" "}
            {formatBytes(request.body_bytes)}
            ）。残りの部分は、ここでは確かめられません。
          </p>
        )}
        {mail !== null && (
          <Untrusted
            label="メールの中身（raw を読める形にしたもの）"
            text={mail}
            source="AI 社員"
            mono
          />
        )}
      </details>
    </section>
  );
}

export function HoldScreen({ id }: { readonly id: string }) {
  const app = useApp();
  const now = useNow(app.now);
  const res = useResource(() => app.api.getHold(id), { key: `hold:${id}` });
  const [opened, setOpened] = useState(false);
  const [decidedHere, setDecidedHere] = useState(false);

  if (res.data === undefined) {
    return (
      <>
        <p>
          <a href="#/pending">← 承認待ちの一覧へ</a>
        </p>
        <h1>保留</h1>
        {res.error !== undefined ? (
          <LoadFailed error={res.error} what="保留" />
        ) : (
          <Loading what="保留" />
        )}
      </>
    );
  }

  const hold = res.data.hold;
  const opId = operationId(hold.operation, hold.service);
  const opName = operationLabel(hold.operation, hold.service) ?? opId;
  const summary = describeSummary(hold.summary);
  const status = statusLabel(HOLD_STATUS_LABELS, hold.status);
  const decided = ["approved", "rejected", "expired", "replayed", "replay_failed"].includes(
    hold.status,
  );
  const decidable: Decidable =
    hold.status !== "pending_owner"
      ? { ok: false, reason: "この保留は、もうあなたの承認を待っていません" }
      : deadline(hold.expires_at, now).level === "past"
        ? {
            ok: false,
            reason: "期限が過ぎています（期限切れは却下と同じ扱いです）。承認・却下はできません",
          }
        : res.staleSince !== null
          ? { ok: false, reason: "最新の状態を確かめられていないので、承認・却下はできません" }
          : { ok: true };
  const recap = shortSummary(hold.summary);

  return (
    <>
      <p>
        <a href="#/pending">← 承認待ちの一覧へ</a>
      </p>
      <h1>
        保留：{opName}
        {opName !== opId && <span className="muted small">（{opId}）</span>}
      </h1>
      <p className="status-line">
        <Badge status={status} />{" "}
        <DeadlineText iso={hold.status === "pending_owner" ? hold.expires_at : null} />
      </p>
      <StaleNote since={res.staleSince} />
      {res.error !== undefined && res.error.code !== "offline" && (
        <LoadFailed error={res.error} what="最新の状態" />
      )}

      <dl className="meta">
        <dt>社員</dt>
        <dd>
          <strong>{hold.member_id}</strong>（部署 {hold.group_id}）
        </dd>
        <dt>スレッド</dt>
        <dd>
          <SafeText text={hold.thread} />
        </dd>
        <dt>タスク</dt>
        <dd>
          <a href={hrefOf({ name: "task", id: hold.task_id })}>{hold.task_id}</a>
        </dd>
        <dt>保留にした時刻</dt>
        <dd>
          <TimeText iso={hold.created_at} />
        </dd>
        <dt>決めた者</dt>
        <dd>{deciderLabel(hold.decided_by)}</dd>
      </dl>

      <section aria-labelledby="summary-heading" className="section">
        <h2 id="summary-heading">要約：{summary.kindLabel}</h2>
        <p className="muted small">
          制御サーバーが元のリクエストから作った要約です。承認の署名には、この要約の SHA-256
          が入ります。
        </p>
        <dl className="summary">
          {summary.fields.map((f) => (
            <div key={f.key} className="summary-row">
              <dt>{f.label}</dt>
              <dd>
                <FieldValue field={f} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {hold.manager_comment !== null && (
        <section aria-labelledby="comment-heading" className="section">
          <h2 id="comment-heading">部長のコメント</h2>
          <Untrusted label="部長のコメント" text={hold.manager_comment} source="部長（AI）" />
        </section>
      )}

      <RequestSection
        hold={hold}
        required={summary.requireFullRequest}
        onOpened={() => setOpened(true)}
      />

      {decided && (
        <section aria-labelledby="result-heading" className="section">
          <h2 id="result-heading">結果</h2>
          <dl className="meta">
            <dt>状態</dt>
            <dd>
              <Badge status={status} />
            </dd>
            <dt>決めた時刻</dt>
            <dd>
              <TimeText iso={hold.decided_at} />
            </dd>
            {hold.response_status !== null && (
              <>
                <dt>送信の結果</dt>
                <dd>{responseText(hold.response_status)}</dd>
              </>
            )}
          </dl>
          {hold.response_text !== null && (
            <Untrusted
              label="再送の応答の本文"
              text={hold.response_text}
              source="外のサービス"
              mono
            />
          )}
        </section>
      )}

      {hold.status === "pending_manager" && (
        <p className="notice notice-info">
          <span aria-hidden="true">ⓘ </span>
          部長のレビュー待ちです。部長が「オーナーに回す」と、ここで承認・却下できるようになります。
        </p>
      )}

      {(hold.status === "pending_owner" || decidedHere) && (
        <ApprovalPanel
          type="hold"
          id={hold.id}
          decidable={decidable}
          approveBlocked={
            summary.requireFullRequest && !opened
              ? "承認する前に、上の「元のリクエスト全体」を開いて中身を確かめてください。開くまで「承認する」は押せません（10.2）"
              : null
          }
          displayedSummary={{ value: hold.summary }}
          approveTitle={`この${opName}を承認しますか？`}
          approveLabel="パスキーで署名して承認する"
          approveBody={
            <>
              <p>
                承認すると、資格プロキシが本物の資格を付けて、このリクエストを
                <strong>1回だけ送ります</strong>
                。送ったものは取り消せません。
              </p>
              <dl className="meta">
                <dt>社員</dt>
                <dd>
                  {hold.member_id}（部署 {hold.group_id}）
                </dd>
                <dt>中身</dt>
                <dd>{recap !== "" ? recap : opId}</dd>
                <dt>送り先</dt>
                <dd className="mono break">
                  <SafeText text={`${hold.request.method} ${hold.request.url}`} />
                </dd>
              </dl>
            </>
          }
          rejectTitle={`この${opName}を却下しますか？`}
          rejectLabel="パスキーで署名して却下する"
          rejectBody={
            <p>
              却下すると、このリクエストは送られません。社員の次の実行に「却下」の結果が届きます。
            </p>
          }
          statusText={(s) => statusLabel(HOLD_STATUS_LABELS, s).label}
          onSettled={() => {
            setDecidedHere(true);
            void res.reload();
          }}
        />
      )}
    </>
  );
}
