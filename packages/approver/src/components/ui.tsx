/**
 * 小さな部品：状態の印（記号＋文。色だけに頼らない）、時刻、期限、エラーの表示。
 */
import type { ApiFailure } from "../api/client.ts";
import { useApp } from "../lib/context.tsx";
import type { StatusLabel } from "../lib/labels.ts";
import { useNow } from "../lib/polling.ts";
import { deadline, formatDateTime, parseTime, relativeTime } from "../lib/time.ts";

export function Badge({ status }: { readonly status: StatusLabel }) {
  return (
    <span className={`badge tone-${status.tone}`}>
      <span aria-hidden="true">{status.symbol}</span> {status.label}
    </span>
  );
}

/** 「11月28日(土) 12:04（3分前）」 */
export function TimeText({
  iso,
  relative = true,
}: {
  readonly iso: string | null;
  readonly relative?: boolean;
}) {
  const app = useApp();
  const now = useNow(app.now);
  if (iso === null) return <span className="muted">—</span>;
  const t = parseTime(iso);
  const abs = formatDateTime(iso, { now, timeZone: app.timeZone });
  return (
    <time dateTime={iso} title={iso}>
      {abs}
      {relative && t !== null && <span className="muted">（{relativeTime(t, now)}）</span>}
    </time>
  );
}

const DEADLINE_SYMBOL = { past: "✕", urgent: "⚠", soon: "◔", normal: "◷" } as const;

/** 期限。1時間を切ったら「⚠」と強い見た目、6時間を切ったら「◔」 */
export function DeadlineText({ iso }: { readonly iso: string | null }) {
  const app = useApp();
  const now = useNow(app.now);
  const d = deadline(iso, now);
  return (
    <span className={`deadline level-${d.level}`}>
      <span aria-hidden="true">{DEADLINE_SYMBOL[d.level]} </span>
      {d.text}
      {iso !== null && d.level !== "past" && (
        <span className="muted">（{formatDateTime(iso, { now, timeZone: app.timeZone })}）</span>
      )}
    </span>
  );
}

export function ErrorBox({
  error,
  title,
}: {
  readonly error: ApiFailure;
  readonly title?: string;
}) {
  return (
    <div className="notice notice-error" role="alert">
      <p>
        <span aria-hidden="true">✕ </span>
        {title !== undefined && <strong>{title}：</strong>}
        {error.message}
      </p>
    </div>
  );
}

/** 表示が古い（控え・届かなくなる前のもの）ことを言う */
export function StaleNote({ since }: { readonly since: number | null }) {
  const app = useApp();
  if (since === null) return null;
  return (
    <p className="notice notice-stale" role="status">
      <span aria-hidden="true">◌ </span>
      制御サーバーに届いていないので、
      {formatDateTime(new Date(since).toISOString(), {
        now: app.now(),
        timeZone: app.timeZone,
      })}{" "}
      の時点で受け取った状態を表示しています。
    </p>
  );
}

export function Loading({ what }: { readonly what: string }) {
  return (
    <p className="muted" role="status">
      {what}を読み込んでいます…
    </p>
  );
}

/** 画面を読み込めなかったとき（offline で控えもないときを含む） */
export function LoadFailed({ error, what }: { readonly error: ApiFailure; readonly what: string }) {
  return <ErrorBox error={error} title={`${what}を読み込めませんでした`} />;
}
