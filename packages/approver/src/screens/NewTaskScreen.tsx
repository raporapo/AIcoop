/**
 * 5.8 の4 (3) 手動のタスクを作る（`POST /tasks`。トリガー manual、9.1 の aicoop run と同じ）。
 * 入力の上限は daemon と同じ（DM-7・B-20）。送る前にここでも確かめ、合わなければ送らない。
 */
import { type FormEvent, useState } from "react";
import type { ApiFailure } from "../api/client.ts";
import { ErrorBox } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { toFailure, useResource } from "../lib/resource.ts";
import { navigate } from "../lib/router.ts";

export interface TaskFormValues {
  readonly member: string;
  readonly purpose: string;
  readonly done_when: string;
  readonly context: string;
  readonly thread: string;
  readonly timeout: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くため
const CONTROL_EXCEPT_NL_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const THREAD_BAD = /[\p{Cc}\p{Cf}\u{2028}\u{2029}]/u;
const MEMBER_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function length(text: string): number {
  return Array.from(text).length;
}

/** 入力の誤り（日本語）。なければ空 */
export function taskFormProblems(v: TaskFormValues): string[] {
  const out: string[] = [];
  const member = v.member.trim();
  if (member === "") out.push("社員を入れてください");
  else if (!MEMBER_ID.test(member)) {
    out.push("社員の ID は、小文字の英数字とハイフン（40文字まで）で書いてください");
  }
  const text = (label: string, value: string, max: number, required: boolean) => {
    if (value.trim() === "") {
      if (required) out.push(`${label}を入れてください`);
      return;
    }
    if (length(value) > max) out.push(`${label}は${max}文字までにしてください`);
    if (CONTROL_EXCEPT_NL_TAB.test(value))
      out.push(`${label}に、改行・タブ以外の制御文字は使えません`);
  };
  text("目的", v.purpose, 2000, true);
  text("完了の条件", v.done_when, 2000, true);
  text("背景", v.context, 32000, false);
  if (v.thread !== "") {
    if (length(v.thread) > 200) out.push("スレッドは200文字までにしてください");
    if (THREAD_BAD.test(v.thread)) out.push("スレッドに、改行・制御文字・見えない文字は使えません");
  }
  if (v.timeout.trim() !== "") {
    const n = Number(v.timeout);
    if (!/^\d+$/.test(v.timeout.trim()) || n < 1 || n > 55) {
      out.push("時間制限は1〜55分の整数にしてください");
    }
  }
  return out;
}

export function NewTaskScreen() {
  const app = useApp();
  const status = useResource(() => app.api.status(), { key: "status", poll: false });
  const [v, setV] = useState<TaskFormValues>({
    member: "",
    purpose: "",
    done_when: "",
    context: "",
    thread: "",
    timeout: "",
  });
  const [problems, setProblems] = useState<string[]>([]);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const members = new Set<string>();
  for (const t of status.data?.triggers ?? []) members.add(t.member);
  for (const b of status.data?.boxes.running ?? []) members.add(b.member_id);

  const field = (key: keyof TaskFormValues) => (e: { target: { value: string } }) =>
    setV((prev) => ({ ...prev, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = taskFormProblems(v);
    setProblems(found);
    setError(null);
    if (found.length > 0) return;
    setBusy(true);
    try {
      const res = await app.api.createTask({
        member: v.member.trim(),
        purpose: v.purpose,
        done_when: v.done_when,
        ...(v.context.trim() !== "" ? { context: v.context } : {}),
        ...(v.thread !== "" ? { thread: v.thread } : {}),
        ...(v.timeout.trim() !== "" ? { timeout_minutes: Number(v.timeout) } : {}),
      });
      navigate({ name: "task", id: res.task.id });
    } catch (err) {
      setError(toFailure(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        <a href="#/status">← 稼働状況へ</a>
      </p>
      <h1>手動のタスクを作る</h1>
      <p>
        社員にタスクを頼み、順番待ちに入れます（トリガーは「手動」、優先度は一番先。5.5.1）。PC の{" "}
        <code>aicoop run</code> と同じです。
      </p>
      <form className="form form-wide" onSubmit={(e) => void submit(e)} noValidate>
        <label>
          社員
          <input
            value={v.member}
            onChange={field("member")}
            list="member-ids"
            spellCheck={false}
            autoComplete="off"
            required
          />
          <datalist id="member-ids">
            {[...members].map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label>
          目的（2000文字まで）
          <textarea value={v.purpose} onChange={field("purpose")} rows={3} required />
        </label>
        <label>
          完了の条件（2000文字まで）
          <textarea value={v.done_when} onChange={field("done_when")} rows={2} required />
        </label>
        <label>
          背景（任意。32000文字まで）
          <textarea value={v.context} onChange={field("context")} rows={4} />
        </label>
        <label>
          スレッド（任意。同じスレッドなら前の会話の続きから）
          <input value={v.thread} onChange={field("thread")} spellCheck={false} />
        </label>
        <label>
          時間制限（任意。1〜55分。書かなければ設定の既定）
          <input value={v.timeout} onChange={field("timeout")} inputMode="numeric" />
        </label>
        <button type="submit" className="button-primary" disabled={busy || !app.reachable}>
          タスクを作る
        </button>
      </form>
      {problems.length > 0 && (
        <div className="notice notice-error" role="alert">
          <p>
            <span aria-hidden="true">✕ </span>入力を直してください：
          </p>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {error !== null && <ErrorBox error={error} title="タスクを作れませんでした" />}
    </>
  );
}
