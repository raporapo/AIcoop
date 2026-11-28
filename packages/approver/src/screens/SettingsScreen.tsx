/**
 * 5.8 の4 (10) 設定・5.14 の4：設定のファイル（6.1 の yaml と prompts の md）を一覧し、中身を書き換える。
 *
 * 流れ：ファイルを開く → テキストで編集 → 「確かめる」（daemon が、変えたファイルを重ねた設定の全体を検証する。
 * エラーなら保存できない、警告は見せてそのまま保存できる）→ 差分を見て、パスキーで署名して保存する。
 *
 * - PC のブラウザだけ（5.14 の6。daemon は Bearer・中継からは受けない）
 * - 一覧に出ないファイル（secrets.json・state.db など）は、この画面では開けない。新しいファイルのパスも、
 *   daemon と同じパターン（CONFIG_FILE_PATH_PATTERN）で確かめてから送る
 */
import {
  type ApprovalAssertResponse,
  CONFIG_FILE_PATH_PATTERN,
  type ConfigIssue,
  type CreateConfigChangeResponse,
} from "@aicoop/shared/api";
import { useId, useState } from "react";
import type { ApiFailure } from "../api/client.ts";
import { ConfigChangeReview } from "../components/ChangeReview.tsx";
import { IssueList } from "../components/IssueList.tsx";
import { SafeText } from "../components/text.tsx";
import { ErrorBox, LoadFailed, Loading, TimeText } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { toFailure, useResource } from "../lib/resource.ts";
import { formatBytes } from "../lib/summary.ts";

interface Editing {
  readonly path: string;
  /** もとにした中身の SHA-256（新しいファイルなら null） */
  readonly base: string | null;
  readonly original: string;
  readonly draft: string;
}

type Check =
  | { readonly kind: "none" }
  | { readonly kind: "checking" }
  | { readonly kind: "invalid"; readonly message: string; readonly issues: readonly ConfigIssue[] }
  | { readonly kind: "failed"; readonly error: ApiFailure }
  | { readonly kind: "change"; readonly change: CreateConfigChangeResponse };

export function SettingsScreen() {
  const app = useApp();
  const files = useResource(() => app.api.listConfigFiles(), { key: "config-files", poll: false });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [opening, setOpening] = useState<{ path: string; error: ApiFailure | null } | null>(null);
  const [check, setCheck] = useState<Check>({ kind: "none" });
  const [saved, setSaved] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newPathError, setNewPathError] = useState<string | null>(null);
  const newPathId = useId();
  const editorId = useId();

  const open = async (path: string) => {
    setCheck({ kind: "none" });
    setSaved(false);
    setEditing(null);
    setOpening({ path, error: null });
    try {
      const got = await app.api.getConfigFile(path);
      setEditing({ path, base: got.sha256, original: got.content, draft: got.content });
      setOpening(null);
    } catch (e) {
      setOpening({ path, error: toFailure(e) });
    }
  };

  const startNew = () => {
    const path = newPath.trim();
    if (!CONFIG_FILE_PATH_PATTERN.test(path)) {
      setNewPathError(
        "このパスは、設定の画面では作れません（6.1 の yaml・services/<名前>.yaml・prompts/ の下の .md だけ。secrets.json・state.db・.. を含むパスは扱えません）",
      );
      return;
    }
    setNewPathError(null);
    if (files.data?.files.some((f) => f.path === path)) {
      void open(path);
      return;
    }
    setCheck({ kind: "none" });
    setSaved(false);
    setOpening(null);
    setEditing({ path, base: null, original: "", draft: "" });
  };

  const runCheck = async () => {
    if (editing === null) return;
    setCheck({ kind: "checking" });
    try {
      const change = await app.api.createConfigChange({
        files: [{ path: editing.path, content: editing.draft, base_sha256: editing.base }],
      });
      setCheck({ kind: "change", change });
    } catch (e) {
      const failure = toFailure(e);
      if (failure.code === "config_invalid") {
        setCheck({ kind: "invalid", message: failure.message, issues: failure.issues ?? [] });
      } else {
        setCheck({ kind: "failed", error: failure });
      }
    }
  };

  const onSettled = (response: ApprovalAssertResponse | null) => {
    if (response?.subject_status === "applied") setSaved(true);
    void files.reload();
  };

  const changed = editing !== null && editing.draft !== editing.original;
  const locked = check.kind === "change" || check.kind === "checking" || saved;

  return (
    <>
      <h1>設定</h1>
      <p>
        設定のファイル（<code>~/.aicoop</code> の yaml と <code>prompts/</code> の
        md）を書き換えます。保存の前に設定の全体を確かめ、差分を見てから、パスキーで署名して保存します。
        保存したら、設定を読み直します（<code>aicoop reload</code> と同じ）。
      </p>

      <section aria-labelledby="files-heading">
        <h2 id="files-heading">ファイル</h2>
        {files.data === undefined ? (
          files.error !== undefined ? (
            <LoadFailed error={files.error} what="設定のファイルの一覧" />
          ) : (
            <Loading what="設定のファイルの一覧" />
          )
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">ファイル</th>
                <th scope="col">大きさ</th>
                <th scope="col">更新</th>
              </tr>
            </thead>
            <tbody>
              {files.data.files.map((f) => (
                <tr key={f.path} aria-current={editing?.path === f.path ? "true" : undefined}>
                  <td>
                    <button type="button" className="link-button" onClick={() => void open(f.path)}>
                      {f.path}
                    </button>
                  </td>
                  <td>{formatBytes(f.size)}</td>
                  <td>
                    <TimeText iso={f.modified_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="field">
          <label htmlFor={newPathId}>新しいファイルのパス</label>
          <input
            id={newPathId}
            type="text"
            value={newPath}
            placeholder="例：prompts/members/dev-implementer.md"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setNewPath(e.target.value)}
          />
          <button type="button" onClick={startNew}>
            新しいファイルを作る
          </button>
          {newPathError !== null && (
            <p className="notice notice-error" role="alert">
              {newPathError}
            </p>
          )}
        </div>
      </section>

      {opening !== null &&
        (opening.error === null ? (
          <Loading what={`${opening.path} の中身`} />
        ) : (
          <ErrorBox error={opening.error} title={`${opening.path} を開けませんでした`} />
        ))}

      {editing !== null && (
        <section aria-labelledby="editor-heading">
          <h2 id="editor-heading">
            <code>
              <SafeText text={editing.path} />
            </code>
            {editing.base === null && <span className="muted">（新しいファイル）</span>}
          </h2>
          <label htmlFor={editorId}>{editing.path} の中身</label>
          <textarea
            id={editorId}
            className="editor"
            value={editing.draft}
            rows={20}
            spellCheck={false}
            readOnly={locked}
            onChange={(e) => {
              setEditing({ ...editing, draft: e.target.value });
              setCheck({ kind: "none" });
            }}
          />
          <div className="actions">
            <button
              type="button"
              className="button-primary"
              disabled={!changed || locked}
              onClick={() => void runCheck()}
            >
              確かめる
            </button>
            {check.kind === "change" && !saved && (
              <button
                type="button"
                onClick={() => setCheck({ kind: "none" })}
                title="この変更は使わずに、編集に戻ります（作った変更は10分で消えます）"
              >
                編集に戻る
              </button>
            )}
          </div>
          {check.kind === "checking" && (
            <p className="muted" role="status">
              設定の全体を確かめています…
            </p>
          )}
          {check.kind === "invalid" && (
            <>
              <p className="notice notice-error">
                <span aria-hidden="true">✕ </span>
                {check.message}
              </p>
              <IssueList issues={check.issues} />
            </>
          )}
          {check.kind === "failed" && (
            <ErrorBox error={check.error} title="確かめられませんでした" />
          )}
        </section>
      )}

      {check.kind === "change" && (
        <ConfigChangeReview
          key={check.change.id}
          id={check.change.id}
          summary={check.change.summary}
          warnings={check.change.warnings}
          expiresAt={check.change.expires_at}
          onSettled={onSettled}
        />
      )}
    </>
  );
}
