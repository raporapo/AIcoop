/**
 * 5.8 の4 (2) 一時権限の申請の詳細（5.7.3）：誰が・何の操作を・どのパラメーターで・何時間・理由と、
 * 承認・却下（5.8 の3）。`GET /grants/{id}` がないので、一覧から探す。
 */
import { useState } from "react";
import { ApprovalPanel, type Decidable } from "../components/ApprovalPanel.tsx";
import { SafeText, Untrusted } from "../components/text.tsx";
import { Badge, LoadFailed, Loading, StaleNote, TimeText } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { GRANT_MODE_TEXT, grantParamsText } from "../lib/grant.ts";
import { deciderLabel, GRANT_STATUS_LABELS, statusLabel } from "../lib/labels.ts";
import { useResource } from "../lib/resource.ts";

export function GrantScreen({ id }: { readonly id: string }) {
  const app = useApp();
  const res = useResource(() => app.api.listGrants(), { key: `grants-all:${id}` });
  const [decidedHere, setDecidedHere] = useState(false);
  const back = (
    <p>
      <a href="#/pending">← 承認待ちの一覧へ</a>
    </p>
  );

  if (res.data === undefined) {
    return (
      <>
        {back}
        <h1>一時権限の申請</h1>
        {res.error !== undefined ? (
          <LoadFailed error={res.error} what="一時権限の申請" />
        ) : (
          <Loading what="一時権限の申請" />
        )}
      </>
    );
  }
  const grant = res.data.grants.find((g) => g.id === id);
  if (grant === undefined) {
    return (
      <>
        {back}
        <h1>一時権限の申請</h1>
        <p className="notice notice-info">その一時権限の申請は見つかりません（{id}）。</p>
      </>
    );
  }

  const status = statusLabel(GRANT_STATUS_LABELS, grant.status);
  const params = grantParamsText(grant.params);
  const decidable: Decidable =
    grant.status !== "pending_owner"
      ? { ok: false, reason: "この申請は、もうあなたの承認を待っていません" }
      : res.staleSince !== null
        ? { ok: false, reason: "最新の状態を確かめられていないので、承認・却下はできません" }
        : { ok: true };

  return (
    <>
      {back}
      <h1>
        一時権限の申請：
        <SafeText text={grant.operation} />
      </h1>
      <p className="status-line">
        <Badge status={status} />
      </p>
      <StaleNote since={res.staleSince} />

      <section aria-labelledby="grant-heading" className="section">
        <h2 id="grant-heading">申請の中身</h2>
        <dl className="meta">
          <dt>誰が</dt>
          <dd>
            社員 <strong>{grant.member_id}</strong>
          </dd>
          <dt>何の操作を</dt>
          <dd className="mono">
            <SafeText text={grant.operation} />
          </dd>
          <dt>どのパラメーターで</dt>
          <dd>
            {params === null ? (
              <span className="notice notice-warn">
                <span aria-hidden="true">⚠ </span>
                パラメーターの制限がありません。この操作のすべてに効きます（部署の上限の範囲で）。
              </span>
            ) : (
              <ul className="plain-list">
                {Object.entries(grant.params).map(([k, values]) => (
                  <li key={k}>
                    <span className="mono">
                      <SafeText text={k} />
                    </span>
                    ：
                    {values.map((v, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
                      <span key={i} className="mono">
                        {i > 0 && "、"}
                        <SafeText text={v} />
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
          </dd>
          <dt>何時間</dt>
          <dd>{grant.duration_hours}時間</dd>
          <dt>効き方</dt>
          <dd>{GRANT_MODE_TEXT[grant.mode] ?? grant.mode}</dd>
          <dt>申請の時刻</dt>
          <dd>
            <TimeText iso={grant.created_at} />
          </dd>
          <dt>決めた者</dt>
          <dd>{deciderLabel(grant.decided_by)}</dd>
          {grant.starts_at !== null && (
            <>
              <dt>効き始め</dt>
              <dd>
                <TimeText iso={grant.starts_at} />
              </dd>
            </>
          )}
          {grant.expires_at !== null && (
            <>
              <dt>期限</dt>
              <dd>
                <TimeText iso={grant.expires_at} />
              </dd>
            </>
          )}
        </dl>
        <Untrusted label="申請の理由" text={grant.reason} source="AI 社員" />
      </section>

      {grant.status === "pending_manager" && (
        <p className="notice notice-info">
          <span aria-hidden="true">ⓘ </span>
          部長のレビュー待ちです。部長が「オーナーに回す」と、ここで承認・却下できるようになります。
        </p>
      )}

      {(grant.status === "pending_owner" || decidedHere) && (
        <ApprovalPanel
          type="grant"
          id={grant.id}
          decidable={decidable}
          approveTitle="この一時権限を承認しますか？"
          approveLabel="パスキーで署名して承認する"
          approveBody={
            <>
              <p>
                承認すると、承認した時刻から<strong>{grant.duration_hours}時間</strong>、社員{" "}
                {grant.member_id} が次の操作を使えるようになります。期限が来たら元に戻ります。
              </p>
              <dl className="meta">
                <dt>操作</dt>
                <dd className="mono">
                  <SafeText text={grant.operation} />
                </dd>
                <dt>パラメーター</dt>
                <dd>{params ?? "⚠ 制限なし（すべてに効く）"}</dd>
                <dt>効き方</dt>
                <dd>{GRANT_MODE_TEXT[grant.mode] ?? grant.mode}</dd>
              </dl>
            </>
          }
          rejectTitle="この一時権限を却下しますか？"
          rejectLabel="パスキーで署名して却下する"
          rejectBody={
            <p>却下すると、権限は増えません。社員の次の実行に「却下」の結果が届きます。</p>
          }
          statusText={(s) => statusLabel(GRANT_STATUS_LABELS, s).label}
          onSettled={() => {
            setDecidedHere(true);
            void res.reload();
          }}
        />
      )}
    </>
  );
}
