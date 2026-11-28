/**
 * パスキーでのログイン（9.2）：`/auth/login/options` → パスキー → `/auth/login/verify`。
 * 通ると daemon がセッションのクッキー（aicoop_session）を付ける。
 */
import { useState } from "react";
import type { ApiFailure } from "../api/client.ts";
import { ErrorBox } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { localhostAppUrl, PasskeyFailure, passkeyMessage } from "../lib/passkeys.ts";
import { toFailure } from "../lib/resource.ts";

type Problem = { kind: "api"; error: ApiFailure } | { kind: "passkey"; message: string };

export function LoginScreen({ reason }: { readonly reason: string | null }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const supported = app.passkeys.supported();
  const wrongHost = window.location.hostname !== "localhost";

  const login = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const { options } = await app.api.loginOptions();
      const response = await app.passkeys.authenticate(options);
      const session = await app.api.loginVerify({ response });
      app.onLoggedIn(session);
    } catch (e) {
      if (e instanceof PasskeyFailure) {
        setProblem({ kind: "passkey", message: passkeyMessage(e, "login") });
      } else {
        setProblem({ kind: "api", error: toFailure(e) });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>パスキーでログイン</h1>
      {reason !== null && (
        <p className="notice notice-info" role="status">
          <span aria-hidden="true">ⓘ </span>
          {reason}
        </p>
      )}
      <p>
        この承認アプリは、登録した端末のパスキーでだけ使えます。承認・却下のたびにも、パスキーで署名します。
      </p>

      {wrongHost && (
        <div className="notice notice-warn" role="note">
          <p>
            <span aria-hidden="true">⚠ </span>
            パスキーは {localhostAppUrl()} でだけ使えます（いまは {window.location.origin}{" "}
            で開いています）。
          </p>
          <p>
            <a href={`${localhostAppUrl()}${window.location.hash}`}>localhost で開き直す</a>
          </p>
        </div>
      )}

      {!supported && (
        <div className="notice notice-error" role="note">
          <p>
            <span aria-hidden="true">✕ </span>
            このブラウザはパスキー（WebAuthn）に対応していません。最新の
            Chrome・Edge・Safari・Firefox で開いてください。
          </p>
        </div>
      )}

      <p>
        <button
          type="button"
          className="button-primary button-large"
          onClick={() => void login()}
          disabled={busy || !supported}
        >
          パスキーでログイン
        </button>
      </p>
      {busy && (
        <p className="notice notice-info" role="status">
          パスキーの確認を待っています…（指紋・顔・PIN など。ブラウザの表示に従ってください）
        </p>
      )}
      {problem?.kind === "api" && (
        <ErrorBox error={problem.error} title="ログインできませんでした" />
      )}
      {problem?.kind === "passkey" && (
        <div className="notice notice-error" role="alert">
          <p>
            <span aria-hidden="true">✕ </span>
            <strong>ログインできませんでした：</strong>
            {problem.message}
          </p>
        </div>
      )}

      <section className="card">
        <h2>まだ端末を登録していないとき</h2>
        <ol>
          <li>
            PC のターミナルで <code>aicoop pair --local</code> を実行します。
          </li>
          <li>表示された URL を開き、コードと端末の名前を入れて、この端末のパスキーを作ります。</li>
          <li>6桁の数字が PC のターミナルと同じか確かめて、ターミナルで y を押します。</li>
        </ol>
        <p>
          <a href="#/pair">端末の登録へ</a>
        </p>
      </section>
    </>
  );
}
