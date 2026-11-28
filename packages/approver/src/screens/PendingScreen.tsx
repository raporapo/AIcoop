/**
 * 5.8 の4 (1) 承認待ちの一覧：オーナーの承認を待っている保留（pending_owner）と一時権限の申請。
 * 期限の近いものを先に、目立たせて出す。部長のレビュー待ち（pending_manager）は別に、押せない形で。
 */
import type { GrantView, HoldView } from "@aicoop/shared/api";
import { SafeText } from "../components/text.tsx";
import { DeadlineText, LoadFailed, StaleNote, TimeText } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { grantParamsText } from "../lib/grant.ts";
import { operationLabel } from "../lib/labels.ts";
import { usePending } from "../lib/pending.tsx";
import { useNow } from "../lib/polling.ts";
import { hrefOf } from "../lib/router.ts";
import { shortSummary } from "../lib/summary.ts";
import { deadline, parseTime } from "../lib/time.ts";

type Item =
  | { readonly kind: "hold"; readonly hold: HoldView }
  | { readonly kind: "grant"; readonly grant: GrantView };

function sortKey(item: Item): [number, number] {
  if (item.kind === "hold") {
    return [parseTime(item.hold.expires_at) ?? 0, parseTime(item.hold.created_at) ?? 0];
  }
  // 一時権限の申請には、承認を待つ期限がない。保留のあとに、古い順
  return [Number.POSITIVE_INFINITY, parseTime(item.grant.created_at) ?? 0];
}

function byDeadline(a: Item, b: Item): number {
  const [a1, a2] = sortKey(a);
  const [b1, b2] = sortKey(b);
  return a1 === b1 ? a2 - b2 : a1 - b1;
}

function HoldLine({ hold }: { readonly hold: HoldView }) {
  const label = operationLabel(hold.operation);
  const short = shortSummary(hold.summary);
  return (
    <>
      <span className="pending-kind">
        保留：{label ?? <SafeText text={hold.operation} />}
        {label !== null && <span className="muted small">（{hold.operation}）</span>}
      </span>
      <span className="pending-what">
        {short !== "" ? short : <span className="muted">（要約は、この端末に残していません）</span>}
      </span>
      <span className="pending-who">
        社員 <strong>{hold.member_id}</strong>（部署 {hold.group_id}）
      </span>
    </>
  );
}

function GrantLine({ grant }: { readonly grant: GrantView }) {
  const params = grantParamsText(grant.params);
  return (
    <>
      <span className="pending-kind">
        一時権限の申請：
        <SafeText text={grant.operation} />
      </span>
      <span className="pending-what">
        {params ?? "⚠ パラメーターの制限なし（すべてに効く）"}・{grant.duration_hours}時間
      </span>
      <span className="pending-who">
        社員 <strong>{grant.member_id}</strong>・申請 <TimeText iso={grant.created_at} />
      </span>
    </>
  );
}

export function PendingScreen() {
  const app = useApp();
  const now = useNow(app.now);
  const pending = usePending();
  const owner: Item[] = [
    ...pending.ownerHolds.map((hold): Item => ({ kind: "hold", hold })),
    ...pending.ownerGrants.map((grant): Item => ({ kind: "grant", grant })),
  ].sort(byDeadline);
  const manager: Item[] = [
    ...pending.managerHolds.map((hold): Item => ({ kind: "hold", hold })),
    ...pending.managerGrants.map((grant): Item => ({ kind: "grant", grant })),
  ].sort(byDeadline);
  const loading = pending.holds.loading && pending.grants.loading;
  const stale = pending.holds.staleSince ?? pending.grants.staleSince;

  return (
    <>
      <h1>承認待ち</h1>
      <StaleNote since={stale} />
      {pending.errors.map((e) => (
        <LoadFailed key={e.what} error={e.error} what={e.what} />
      ))}

      <section aria-labelledby="owner-heading" className="section">
        <h2 id="owner-heading">あなたの承認を待っているもの（{loading ? "…" : owner.length}件）</h2>
        {!loading && owner.length === 0 && (
          <p className="empty">いま、あなたの承認を待っているものはありません。</p>
        )}
        {owner.length > 0 && (
          <ul className="pending-list">
            {owner.map((item) => {
              const level =
                item.kind === "hold" ? deadline(item.hold.expires_at, now).level : "normal";
              const href =
                item.kind === "hold"
                  ? hrefOf({ name: "hold", id: item.hold.id })
                  : hrefOf({ name: "grant", id: item.grant.id });
              return (
                <li key={href}>
                  <a href={href} className={`pending-item level-${level}`}>
                    {item.kind === "hold" ? (
                      <>
                        <HoldLine hold={item.hold} />
                        <span className="pending-deadline">
                          <DeadlineText iso={item.hold.expires_at} />
                        </span>
                      </>
                    ) : (
                      <GrantLine grant={item.grant} />
                    )}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="manager-heading" className="section">
        <h2 id="manager-heading">部長のレビュー待ち（{loading ? "…" : manager.length}件）</h2>
        <p className="muted">
          部長（AI）が見ています。部長が「オーナーに回す」と、上の一覧に移ります。ここからは承認できません。
        </p>
        {manager.length > 0 && (
          <ul className="pending-list">
            {manager.map((item) => (
              <li
                key={item.kind === "hold" ? item.hold.id : item.grant.id}
                className="pending-item pending-inert"
              >
                {item.kind === "hold" ? (
                  <>
                    <HoldLine hold={item.hold} />
                    <span className="pending-deadline">
                      <DeadlineText iso={item.hold.expires_at} />
                    </span>
                  </>
                ) : (
                  <GrantLine grant={item.grant} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
