/**
 * 5.8 の4 (11) 資格・5.14 の5：資格の ID・種類・更新日時を一覧し（中身は出さない）、登録・置き換え・削除をする。
 * どれも、変更を作ってから、パスキーで署名して保存する（`type: "secret_change"`）。
 *
 * 資格の中身の扱い（5.2.8、11.5）：
 * - 貼り付け欄は type=password（自動入力・保存・スペルチェックなし）。React の状態に入れず、入力欄から直接読む
 * - 「変更を作る」を押したら、送る前に入力欄を空にする（画面に残さない）。中身は daemon のメモリの中だけに置かれ、
 *   要約（ID・種類・登録か置き換えか削除か）にも、応答にも出ない
 * - PC のブラウザだけ（5.14 の6）
 */
import type {
  ApprovalAssertResponse,
  CreateSecretChangeResponse,
  SecretKindName,
} from "@aicoop/shared/api";
import { useId, useRef, useState } from "react";
import type { ApiFailure } from "../api/client.ts";
import { SecretChangeReview } from "../components/ChangeReview.tsx";
import { ErrorBox, LoadFailed, Loading, TimeText } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { toFailure, useResource } from "../lib/resource.ts";
import {
  kindLabel,
  SECRET_FIELDS,
  SECRET_ID_PATTERN,
  SECRET_KINDS,
  secretValue,
} from "../lib/secret-form.ts";

export function SecretsScreen() {
  const app = useApp();
  const list = useResource(() => app.api.listSecrets(), { key: "secrets", poll: false });
  const [secretId, setSecretId] = useState("");
  const [kind, setKind] = useState<SecretKindName>("static_token");
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [change, setChange] = useState<CreateSecretChangeResponse | null>(null);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const idField = useId();
  const kindField = useId();
  const fieldId = useId();

  /** 入力欄を空にして、入っていた値を返す */
  const takeValues = (): Record<string, string> => {
    const values: Record<string, string> = {};
    for (const f of SECRET_FIELDS[kind]) {
      const el = inputs.current[f.key];
      values[f.key] = el?.value ?? "";
      if (el) el.value = "";
    }
    return values;
  };

  const propose = async (body: Parameters<typeof app.api.createSecretChange>[0]) => {
    setBusy(true);
    setFailure(null);
    setChange(null);
    try {
      setChange(await app.api.createSecretChange(body));
    } catch (e) {
      setFailure(toFailure(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    const values = takeValues();
    setProblem(null);
    if (!SECRET_ID_PATTERN.test(secretId)) {
      setProblem(
        "資格の ID は英小文字・数字・ハイフンで1〜40文字にしてください（例：github、anthropic）。入力した中身は消しました",
      );
      return;
    }
    const empty = SECRET_FIELDS[kind].filter((f) => (values[f.key] ?? "").trim() === "");
    if (empty.length > 0) {
      setProblem(`${empty.map((f) => f.label).join("・")}が空です。入力した中身は消しました`);
      return;
    }
    void propose({ id: secretId, kind, value: secretValue(kind, values) });
  };

  const onSettled = (_response: ApprovalAssertResponse | null) => {
    void list.reload();
  };

  return (
    <>
      <h1>資格</h1>
      <p>
        AI
        社員が使うサービスの資格（トークンなど）を登録・置き換え・削除します。資格の中身は、この画面にも
        記録にも出しません。どの変更も、パスキーで署名してから保存します。
      </p>

      <section aria-labelledby="secrets-heading">
        <h2 id="secrets-heading">登録されている資格</h2>
        {list.data === undefined ? (
          list.error !== undefined ? (
            <LoadFailed error={list.error} what="資格の一覧" />
          ) : (
            <Loading what="資格の一覧" />
          )
        ) : list.data.secrets.length === 0 ? (
          <p className="muted">資格はまだ登録されていません。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">種類</th>
                <th scope="col">更新</th>
                <th scope="col">
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.secrets.map((s) => (
                <tr key={s.id}>
                  <td>
                    <code>{s.id}</code>
                  </td>
                  <td>{kindLabel(s.kind)}</td>
                  <td>
                    <TimeText iso={s.updated_at} />
                  </td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="button-small"
                      aria-label={`${s.id} を置き換える`}
                      onClick={() => {
                        setSecretId(s.id);
                        setKind(s.kind);
                        setChange(null);
                        setProblem(null);
                      }}
                    >
                      置き換える
                    </button>
                    <button
                      type="button"
                      className="button-small"
                      aria-label={`${s.id} を消す…`}
                      disabled={busy}
                      onClick={() => void propose({ id: s.id, delete: true })}
                    >
                      消す…
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="secret-form-heading">
        <h2 id="secret-form-heading">登録・置き換え</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          autoComplete="off"
        >
          <div className="field">
            <label htmlFor={idField}>資格の ID</label>
            <input
              id={idField}
              type="text"
              value={secretId}
              spellCheck={false}
              autoComplete="off"
              placeholder="例：github"
              onChange={(e) => setSecretId(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor={kindField}>種類</label>
            <select
              id={kindField}
              value={kind}
              onChange={(e) => setKind(e.target.value as SecretKindName)}
            >
              {SECRET_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
          {SECRET_FIELDS[kind].map((f) => (
            <div className="field" key={`${kind}-${f.key}`}>
              <label htmlFor={`${fieldId}-${f.key}`}>{f.label}</label>
              <input
                id={`${fieldId}-${f.key}`}
                ref={(el) => {
                  inputs.current[f.key] = el;
                }}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                data-1p-ignore=""
                data-lpignore="true"
              />
              {f.hint !== undefined && <p className="muted small">{f.hint}</p>}
            </div>
          ))}
          <button type="submit" className="button-primary" disabled={busy}>
            変更を作る
          </button>
          <p className="muted small">
            押すと、入力した中身はすぐにこの画面から消します。そのあと、パスキーで署名するまで資格は変わりません。
          </p>
        </form>
        {problem !== null && (
          <p className="notice notice-error" role="alert">
            {problem}
          </p>
        )}
        {failure !== null && <ErrorBox error={failure} title="変更を作れませんでした" />}
      </section>

      {change !== null && (
        <SecretChangeReview
          key={change.id}
          id={change.id}
          summary={change.summary}
          expiresAt={change.expires_at}
          onSettled={onSettled}
        />
      )}
    </>
  );
}
