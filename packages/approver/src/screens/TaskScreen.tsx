/**
 * 5.8 の4 (3) タスクの詳細（9.2 の `GET /tasks/{id}`）と取り消し（`POST /tasks/{id}/cancel`）。
 */
import type { CancelTaskResponse, RunView } from "@aicoop/shared/api";
import { useState } from "react";
import type { ApiFailure } from "../api/client.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { SafeText, Untrusted } from "../components/text.tsx";
import { Badge, ErrorBox, LoadFailed, Loading, StaleNote, TimeText } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { isTerminalTask, statusLabel, TASK_STATUS_LABELS, TRIGGER_LABELS } from "../lib/labels.ts";
import { toFailure, useResource } from "../lib/resource.ts";
import { hrefOf } from "../lib/router.ts";

const END_REASONS: Readonly<Record<string, string>> = {
  exited: "終わった",
  timeout: "時間切れ",
  killed: "止めた",
  daemon_restart: "制御サーバーの再起動",
};

function runEnd(run: RunView): string {
  if (run.ended_at === null) return "動いている";
  const reason = run.end_reason !== null ? (END_REASONS[run.end_reason] ?? run.end_reason) : "—";
  return run.exit_code !== null ? `${reason}（終了コード ${run.exit_code}）` : reason;
}

export function TaskScreen({ id }: { readonly id: string }) {
  const app = useApp();
  const res = useResource(() => app.api.getTask(id), { key: `task:${id}` });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelError, setCancelError] = useState<ApiFailure | null>(null);
  const [cancelled, setCancelled] = useState<CancelTaskResponse | null>(null);

  const back = (
    <p>
      <a href="#/status">← 稼働状況へ</a>
    </p>
  );
  if (res.data === undefined) {
    return (
      <>
        {back}
        <h1>タスクの詳細</h1>
        {res.error !== undefined ? (
          <LoadFailed error={res.error} what="タスク" />
        ) : (
          <Loading what="タスク" />
        )}
      </>
    );
  }
  const { task, runs } = res.data;

  const cancel = async () => {
    setBusy(true);
    setCancelError(null);
    try {
      setCancelled(await app.api.cancelTask(task.id));
      setConfirming(false);
      await res.reload();
    } catch (e) {
      setCancelError(toFailure(e));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {back}
      <h1>タスクの詳細</h1>
      <p className="status-line">
        <Badge status={statusLabel(TASK_STATUS_LABELS, task.status)} />
        <span className="mono small">{task.id}</span>
      </p>
      <StaleNote since={res.staleSince} />

      {cancelled !== null && (
        <p className="notice notice-ok" role="status">
          <span aria-hidden="true">✓ </span>
          取り消しました{cancelled.was_active ? "（動いていた箱を止めました）" : ""}。
        </p>
      )}
      {cancelError !== null && <ErrorBox error={cancelError} title="取り消せませんでした" />}

      <section aria-labelledby="purpose-heading" className="section">
        <h2 id="purpose-heading">目的</h2>
        <p className="prose">
          <SafeText text={task.purpose} />
        </p>
        <h2>完了の条件</h2>
        <p className="prose">
          <SafeText text={task.done_when} />
        </p>
        <h2>背景</h2>
        {task.context === "" ? (
          <p className="muted">（なし）</p>
        ) : task.context_untrusted ? (
          <Untrusted label="背景" text={task.context} source="外の人" />
        ) : (
          <p className="prose">
            <SafeText text={task.context} />
          </p>
        )}
      </section>

      <dl className="meta">
        <dt>社員</dt>
        <dd>
          <strong>{task.member_id}</strong>（部署 {task.group_id}）
        </dd>
        <dt>トリガー</dt>
        <dd>
          {TRIGGER_LABELS[task.trigger_kind] ?? task.trigger_kind}
          {task.trigger_id !== null && <span className="mono">（{task.trigger_id}）</span>}
        </dd>
        <dt>スレッド</dt>
        <dd>
          <SafeText text={task.thread} />
        </dd>
        {task.hold_id !== null && (
          <>
            <dt>保留</dt>
            <dd>
              <a href={hrefOf({ name: "hold", id: task.hold_id })}>{task.hold_id}</a>
            </dd>
          </>
        )}
        <dt>時間制限</dt>
        <dd>{task.timeout_minutes}分</dd>
        <dt>作った時刻</dt>
        <dd>
          <TimeText iso={task.created_at} />
        </dd>
        <dt>始まった時刻</dt>
        <dd>
          <TimeText iso={task.started_at} />
        </dd>
        <dt>終わった時刻</dt>
        <dd>
          <TimeText iso={task.ended_at} />
        </dd>
        {task.retry_at !== null && (
          <>
            <dt>再開の予定</dt>
            <dd>
              <TimeText iso={task.retry_at} />
            </dd>
          </>
        )}
      </dl>

      <section aria-labelledby="result-heading" className="section">
        <h2 id="result-heading">結果</h2>
        {task.result_summary !== null ? (
          <Untrusted label="AI 社員の報告" text={task.result_summary} source="AI 社員" />
        ) : (
          <p className="muted">報告はまだありません。</p>
        )}
        {task.result_files !== null && task.result_files.length > 0 && (
          <>
            <h3>ファイル（作業フォルダの中）</h3>
            <ul className="plain-list mono">
              {task.result_files.map((f, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
                <li key={i}>
                  <SafeText text={f} />
                </li>
              ))}
            </ul>
          </>
        )}
        {task.error !== null && (
          <p className="notice notice-error">
            <span aria-hidden="true">✕ </span>
            エラー：
            <SafeText text={task.error} />
          </p>
        )}
      </section>

      <section aria-labelledby="runs-heading" className="section">
        <h2 id="runs-heading">実行</h2>
        {runs.length === 0 ? (
          <p className="muted">まだ実行していません。</p>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label="実行">
              <thead>
                <tr>
                  <th scope="col">始まり</th>
                  <th scope="col">終わり</th>
                  <th scope="col">終わり方</th>
                  <th scope="col">箱</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <TimeText iso={r.started_at} relative={false} />
                    </td>
                    <td>
                      <TimeText iso={r.ended_at} relative={false} />
                    </td>
                    <td>{runEnd(r)}</td>
                    <td>{r.box_kind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">
          実行の記録（Claude Code の出力）は、PC のターミナルで <code>aicoop logs {task.id}</code>{" "}
          で見られます。
        </p>
      </section>

      {!isTerminalTask(task.status) && (
        <p>
          <button
            type="button"
            className="button-reject"
            disabled={busy || !app.reachable}
            onClick={() => setConfirming(true)}
          >
            このタスクを取り消す…
          </button>
        </p>
      )}
      {confirming && (
        <ConfirmDialog
          title="このタスクを取り消しますか？"
          confirmLabel="取り消す"
          tone="danger"
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void cancel()}
        >
          <p>
            動いているなら、箱を止めます。取り消したタスクは元に戻せません（同じスレッドで頼み直せます）。
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}
