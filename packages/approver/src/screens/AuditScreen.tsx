/**
 * 5.8 の4 (5) 記録（監査ログの閲覧。`GET /audit?after=<seq>&limit=`、古い順）。
 *
 * API は `after` より新しいものを古い順に返すだけなので、いちばん新しい seq を問い合わせで探し
 * （after を倍々にしてから二分探索。数十回で済む）、そこから新しいもの順に読む。seq は保存期間で
 * 先頭が消えるほかは続いているので、古いほうへは after を下げて読む。種類での絞り込みは読み込んだ分の中で。
 */
import type { AuditEntryView } from "@aicoop/shared/api";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiFailure } from "../api/client.ts";
import { SafeText } from "../components/text.tsx";
import { LoadFailed, Loading, TimeText } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { AUDIT_KIND_LABELS, actorLabel } from "../lib/labels.ts";
import { usePolling } from "../lib/polling.ts";
import { toFailure } from "../lib/resource.ts";

const PAGE = 200;

/**
 * いちばん新しい seq（なければ 0）。`probe(after)` は after より大きい最初の seq（なければ null）
 */
export async function findLastSeq(
  probe: (after: number) => Promise<number | null>,
): Promise<number> {
  let lo = await probe(0);
  if (lo === null) return 0;
  let hi = Math.max(1024, lo * 2);
  for (let i = 0; i < 60; i++) {
    const s = await probe(hi);
    if (s === null) break;
    lo = s;
    hi = s * 2;
  }
  // lo はある seq、hi より大きい seq はない
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const s = await probe(mid - 1);
    if (s === null) hi = mid - 1;
    else lo = s;
  }
  return lo;
}

function newestFirst(entries: readonly AuditEntryView[]): AuditEntryView[] {
  return [...entries].sort((a, b) => b.seq - a.seq);
}

export function AuditScreen() {
  const app = useApp();
  const [entries, setEntries] = useState<AuditEntryView[] | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [noOlder, setNoOlder] = useState(false);
  const [kind, setKind] = useState("all");
  const newest = useRef(0);

  const loadInitial = useCallback(async () => {
    try {
      const last = await findLastSeq(async (after) => {
        const res = await app.api.audit({ after, limit: 1 });
        return res.entries[0]?.seq ?? null;
      });
      const res =
        last === 0
          ? { entries: [] }
          : await app.api.audit({ after: Math.max(0, last - PAGE), limit: PAGE });
      newest.current = last;
      setEntries(newestFirst(res.entries));
      setNoOlder(last <= PAGE);
      setError(null);
    } catch (e) {
      setError(toFailure(e));
    }
  }, [app]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  // 新しい記録を足す
  usePolling(
    async () => {
      if (entries === null) return;
      try {
        const res = await app.api.audit({ after: newest.current, limit: PAGE });
        if (res.entries.length === 0) return;
        newest.current = Math.max(newest.current, ...res.entries.map((e) => e.seq));
        setEntries((prev) => newestFirst([...res.entries, ...(prev ?? [])]));
      } catch (e) {
        setError(toFailure(e));
      }
    },
    app.pollMs,
    entries === null ? "waiting" : "ready",
  );

  const loadOlder = async () => {
    if (entries === null || entries.length === 0) return;
    const oldest = Math.min(...entries.map((e) => e.seq));
    setBusy(true);
    try {
      const after = Math.max(0, oldest - 1 - PAGE);
      const res = await app.api.audit({ after, limit: PAGE });
      const older = res.entries.filter((e) => e.seq < oldest);
      setEntries((prev) => newestFirst([...(prev ?? []), ...older]));
      if (older.length === 0 || after === 0) setNoOlder(true);
      setError(null);
    } catch (e) {
      setError(toFailure(e));
    } finally {
      setBusy(false);
    }
  };

  const kinds = new Set(Object.keys(AUDIT_KIND_LABELS));
  for (const e of entries ?? []) kinds.add(e.kind);
  const shown = (entries ?? []).filter((e) => kind === "all" || e.kind === kind);

  return (
    <>
      <h1>記録（監査ログ）</h1>
      <p className="muted">
        制御サーバーが追記だけで書いている記録です（5.10）。書き換えられていないかは、PC で{" "}
        <code>aicoop audit verify</code> で確かめられます。
      </p>
      {error !== null && <LoadFailed error={error} what="記録" />}
      {entries === null && error === null && <Loading what="記録" />}
      {entries !== null && (
        <>
          <label className="inline-label">
            種類で絞る
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="all">すべて</option>
              {[...kinds].map((k) => (
                <option key={k} value={k}>
                  {AUDIT_KIND_LABELS[k] ?? k}（{k}）
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">
            読み込んだ {entries.length} 件のうち {shown.length} 件を、新しいものから表示しています。
          </p>
          <ul className="audit-list" aria-label="記録">
            {shown.map((e) => (
              <li key={e.seq} className="audit-item">
                <p className="audit-head">
                  <span className="mono">#{e.seq}</span> <TimeText iso={e.ts} />{" "}
                  <strong>{AUDIT_KIND_LABELS[e.kind] ?? e.kind}</strong>
                  <span className="muted small">（{e.kind}）</span>
                </p>
                <p className="small">
                  {actorLabel(e.actor)}・対象 <span className="mono">{e.subject}</span>
                </p>
                <details>
                  <summary>中身</summary>
                  <pre className="mono data">
                    <SafeText text={JSON.stringify(e.data, null, 2) ?? "null"} />
                  </pre>
                </details>
              </li>
            ))}
          </ul>
          {noOlder ? (
            <p className="muted">これより古い記録はありません。</p>
          ) : (
            <button type="button" onClick={() => void loadOlder()} disabled={busy}>
              さらに古い記録を読む
            </button>
          )}
        </>
      )}
    </>
  );
}
