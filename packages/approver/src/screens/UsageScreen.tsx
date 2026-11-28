/**
 * 5.8 の4 (4) 利用枠（5.4.6 の4）：状態（使える・残り少ない・止まっている）、再開予定時刻、
 * 使用率（取れたときだけ）。
 */
import { Badge, LoadFailed, Loading, StaleNote, TimeText } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { statusLabel, USAGE_LABELS } from "../lib/labels.ts";
import { useResource } from "../lib/resource.ts";

const LIMIT_TYPES: Readonly<Record<string, string>> = {
  five_hour: "5時間の枠",
  seven_day: "7日の枠",
  seven_day_opus: "7日の枠（Opus）",
  seven_day_sonnet: "7日の枠（Sonnet）",
};

export function UsageScreen() {
  const app = useApp();
  const res = useResource(() => app.api.usage(), { key: "usage", cache: { name: "usage" } });
  const status = useResource(() => app.api.status(), { key: "status", cache: { name: "status" } });
  const waiting = status.data?.tasks.waiting_limit ?? null;

  if (res.data === undefined) {
    return (
      <>
        <h1>利用枠</h1>
        {res.error !== undefined ? (
          <LoadFailed error={res.error} what="利用枠" />
        ) : (
          <Loading what="利用枠" />
        )}
      </>
    );
  }
  const usage = res.data.usage;
  const util =
    usage !== null && usage.utilization !== null && usage.utilization >= 0 && usage.utilization <= 1
      ? usage.utilization
      : null;

  return (
    <>
      <h1>利用枠</h1>
      <StaleNote since={res.staleSince} />
      {usage === null ? (
        <p className="empty">
          まだ利用枠の情報がありません（AI 社員が一度動くと、Claude Code の知らせから記録します）。
        </p>
      ) : (
        <>
          <p className="usage-status">
            <Badge status={statusLabel(USAGE_LABELS, usage.status)} />
          </p>
          {usage.status === "rejected" && (
            <p className="notice notice-error">
              <span aria-hidden="true">■ </span>
              Claude の利用枠に達したので、再開予定の時刻まで、新しい実行は始めません（5.4.6 の3）。
              止まったタスクは、再開予定のあと自動で、同じ会話の続きから再開します。
            </p>
          )}
          <dl className="meta">
            <dt>枠の種類</dt>
            <dd>
              {usage.rate_limit_type === null
                ? "—"
                : (LIMIT_TYPES[usage.rate_limit_type] ?? usage.rate_limit_type)}
            </dd>
            <dt>再開予定</dt>
            <dd>
              <TimeText iso={usage.resets_at} />
            </dd>
            <dt>使用率</dt>
            <dd>
              {util === null ? (
                <span className="muted">
                  使用率は取れていません（Claude Code が知らせたときだけ出ます）
                </span>
              ) : (
                <span className="usage-meter">
                  <meter
                    min={0}
                    max={1}
                    low={0.7}
                    high={0.9}
                    optimum={0}
                    value={util}
                    aria-label="使用率"
                  />
                  <strong>{Math.round(util * 100)}%</strong>
                </span>
              )}
            </dd>
            <dt>更新</dt>
            <dd>
              <TimeText iso={usage.updated_at} />
            </dd>
          </dl>
        </>
      )}
      {waiting !== null && (
        <p>
          利用枠を待っているタスク：{waiting}件{" "}
          {waiting > 0 && <a href="#/status">（稼働状況で見る）</a>}
        </p>
      )}
      <p className="muted small">
        枠に達しても、ほかの AI（ローカルLLM）には切り替えません（5.4.6
        の5）。枠が戻るまで待ちます。
      </p>
    </>
  );
}
