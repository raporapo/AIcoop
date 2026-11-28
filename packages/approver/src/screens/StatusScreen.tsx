/**
 * 5.8 の4 (3) 稼働状況：箱（動いているもの・上限）、状態ごとのタスクの数、トリガー、設定の警告、
 * タスクの一覧（状態で絞る。要約・ファイル）。手動のタスクもここから作れる。
 */
import { useState } from "react";
import { SafeText } from "../components/text.tsx";
import { Badge, LoadFailed, Loading, StaleNote, TimeText } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { statusLabel, TASK_STATUS_LABELS, TASK_STATUSES, type TaskStatus } from "../lib/labels.ts";
import { useResource } from "../lib/resource.ts";
import { hrefOf } from "../lib/router.ts";

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

function TaskList({ filter }: { readonly filter: TaskStatus | "all" }) {
  const app = useApp();
  const res = useResource(
    () => app.api.listTasks(filter === "all" ? { limit: 100 } : { statuses: [filter], limit: 100 }),
    { key: `tasks:${filter}` },
  );
  if (res.data === undefined) {
    return res.error !== undefined ? (
      <LoadFailed error={res.error} what="タスクの一覧" />
    ) : (
      <Loading what="タスクの一覧" />
    );
  }
  const tasks = res.data.tasks;
  if (tasks.length === 0) return <p className="empty">この状態のタスクはありません。</p>;
  return (
    <ul className="task-list">
      {tasks.map((t) => (
        <li key={t.id} className="task-item">
          <p className="task-head">
            <Badge status={statusLabel(TASK_STATUS_LABELS, t.status)} />{" "}
            <a href={hrefOf({ name: "task", id: t.id })}>{t.id}</a>{" "}
            <span className="muted small">
              社員 {t.member_id}・<TimeText iso={t.created_at} />
            </span>
          </p>
          <p className="task-purpose">
            <SafeText text={clip(t.purpose, 160)} />
          </p>
          {t.result_summary !== null && (
            <p className="task-result muted">
              報告：
              <SafeText text={clip(t.result_summary, 200)} />
            </p>
          )}
          {t.result_files !== null && t.result_files.length > 0 && (
            <p className="small muted">
              ファイル：
              {t.result_files.slice(0, 5).map((f, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
                <span key={i} className="mono">
                  {i > 0 && "、"}
                  <SafeText text={f} />
                </span>
              ))}
              {t.result_files.length > 5 && ` ほか${t.result_files.length - 5}件`}
            </p>
          )}
          {t.error !== null && (
            <p className="small">
              <span aria-hidden="true">✕ </span>エラー：
              <SafeText text={t.error} />
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function StatusScreen() {
  const app = useApp();
  const res = useResource(() => app.api.status(), { key: "status", cache: { name: "status" } });
  const [filter, setFilter] = useState<TaskStatus | "all">("all");
  const s = res.data;

  return (
    <>
      <h1>稼働状況</h1>
      <p>
        <a href="#/tasks/new" className="button-link">
          手動のタスクを作る
        </a>
      </p>
      <StaleNote since={res.staleSince} />
      {s === undefined && res.error !== undefined && (
        <LoadFailed error={res.error} what="稼働状況" />
      )}
      {s === undefined && res.error === undefined && <Loading what="稼働状況" />}
      {s !== undefined && (
        <>
          <section aria-labelledby="boxes-heading" className="section">
            <h2 id="boxes-heading">箱</h2>
            <p>
              動いている箱：{s.boxes.running.length} / 上限 {s.boxes.max_concurrent}
            </p>
            {s.boxes.running.length > 0 && (
              <ul className="plain-list">
                {s.boxes.running.map((b) => (
                  <li key={`${b.group_id}:${b.task_id}`}>
                    部署 <strong>{b.group_id}</strong>（{b.box_kind}）— 社員 {b.member_id}・タスク{" "}
                    <a href={hrefOf({ name: "task", id: b.task_id })}>{b.task_id}</a>・
                    <TimeText iso={b.started_at} />
                    から
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-label="状態ごとのタスクの数" className="section">
            <h2>タスクの数</h2>
            <ul className="counts">
              {TASK_STATUSES.map((st) => {
                const label = statusLabel(TASK_STATUS_LABELS, st);
                return (
                  <li key={st} className={s.tasks[st] > 0 ? "" : "muted"}>
                    <span aria-hidden="true">{label.symbol} </span>
                    {label.label}
                    <strong>{s.tasks[st]}</strong>
                  </li>
                );
              })}
            </ul>
          </section>

          {s.warnings.length > 0 && (
            <section aria-labelledby="warn-heading" className="section">
              <h2 id="warn-heading">設定の警告</h2>
              <ul className="plain-list">
                {s.warnings.map((w, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
                  <li key={i}>
                    <span aria-hidden="true">▲ </span>
                    <strong>{w.code}</strong>：<SafeText text={w.message} />
                    {w.source !== undefined && <span className="muted small">（{w.source}）</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="triggers-heading" className="section">
            <h2 id="triggers-heading">トリガー</h2>
            {s.triggers.length === 0 ? (
              <p className="muted">トリガーはありません。</p>
            ) : (
              <ul className="plain-list">
                {s.triggers.map((t) => (
                  <li key={t.id}>
                    <span className="mono">{t.id}</span>（{t.type}・社員 {t.member}）
                    {t.enabled ? "" : " — 動いていません"}
                    {t.next_run_at !== null && (
                      <>
                        {" "}
                        — 次は <TimeText iso={t.next_run_at} />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section aria-labelledby="tasks-heading" className="section">
        <h2 id="tasks-heading">タスクの一覧</h2>
        <label className="inline-label">
          状態で絞る
          <select value={filter} onChange={(e) => setFilter(e.target.value as TaskStatus | "all")}>
            <option value="all">すべて（新しい順に100件まで）</option>
            {TASK_STATUSES.map((st) => (
              <option key={st} value={st}>
                {statusLabel(TASK_STATUS_LABELS, st).label}
                {s !== undefined ? `（${s.tasks[st]}件）` : ""}
              </option>
            ))}
          </select>
        </label>
        <TaskList filter={filter} />
      </section>

      {s !== undefined && (
        <p className="muted small">
          会社：
          <SafeText text={s.company.name} />
          ・aicoop {s.daemon.version}・設定を読んだ時刻 <TimeText iso={s.daemon.config_loaded_at} />
        </p>
      )}
    </>
  );
}
