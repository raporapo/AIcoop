/**
 * 端末の登録（5.8 の2。P2 は `aicoop pair --local`）：ペアリングのコードと端末の名前 →
 * `/pairing/options` → パスキーを作る → `/pairing/register` → 6桁の確認コードを大きく出す。
 * オーナーが PC のターミナルの数字と同じか確かめて、ターミナルで y を押すと端末が有効になる。
 */
import { type FormEvent, useState } from "react";
import type { ApiFailure } from "../api/client.ts";
import { ErrorBox } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { PasskeyFailure, passkeyMessage } from "../lib/passkeys.ts";
import { toFailure } from "../lib/resource.ts";

/** 端末の名前：1〜40文字、制御文字・向きを変える文字なし（CL-10 と同じ考え方） */
export function deviceNameProblem(name: string): string | null {
  const chars = Array.from(name.trim());
  if (chars.length === 0) return "端末の名前を入れてください";
  if (chars.length > 40) return "端末の名前は40文字までにしてください";
  if (/[\p{Cc}\p{Cf}\u{2028}\u{2029}]/u.test(name)) {
    return "端末の名前に、制御文字・見えない文字・向きを変える文字は使えません";
  }
  return null;
}

type Problem = { kind: "api"; error: ApiFailure } | { kind: "text"; message: string };

export function PairScreen({ code: initialCode }: { readonly code: string | null }) {
  const app = useApp();
  const [code, setCode] = useState(initialCode ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirmCode, setConfirmCode] = useState<string | null>(null);
  const supported = app.passkeys.supported();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    if (c === "") {
      setProblem({ kind: "text", message: "ペアリングのコードを入れてください" });
      return;
    }
    const nameProblem = deviceNameProblem(name);
    if (nameProblem !== null) {
      setProblem({ kind: "text", message: nameProblem });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const { options } = await app.api.pairingOptions({ code: c, device_name: name.trim() });
      const response = await app.passkeys.register(options);
      const res = await app.api.pairingRegister({ code: c, response });
      setConfirmCode(res.confirm_code);
    } catch (err) {
      setProblem(
        err instanceof PasskeyFailure
          ? { kind: "text", message: passkeyMessage(err, "pair") }
          : { kind: "api", error: toFailure(err) },
      );
    } finally {
      setBusy(false);
    }
  };

  if (confirmCode !== null) {
    const digits = confirmCode.replace(/(\d{3})(?=\d)/g, "$1 ");
    return (
      <>
        <h1>この端末を登録する</h1>
        <section className="card confirm-code" aria-labelledby="confirm-heading">
          <h2 id="confirm-heading">確認コード</h2>
          <p className="big-code">
            <span aria-hidden="true">{digits}</span>
            {/* 読み上げでは1桁ずつ */}
            <span className="sr-only">{confirmCode.split("").join(" ")}</span>
          </p>
          <p>
            PC の確かめの窓（スタートメニューの「AIcoop」から開いたときはメッセージボックス、
            ターミナルでは <code>aicoop pair --local</code>・<code>aicoop open</code>
            ）に出ている数字と同じか確かめて、「はい」（ターミナルでは <kbd>y</kbd>
            ）を押してください。
          </p>
          <p className="notice notice-warn">
            <span aria-hidden="true">⚠ </span>
            数字が違うときは「いいえ」（ターミナルでは <kbd>n</kbd>
            ）を押してください（ほかの誰かが登録しようとしているかもしれません）。
          </p>
          <p>
            「はい」を押したら、<a href="#/pending">パスキーでログイン</a>してください。
          </p>
        </section>
      </>
    );
  }

  return (
    <>
      <h1>この端末を登録する</h1>
      <p>
        PC のターミナルで <code>aicoop pair --local</code>{" "}
        を実行すると、1回限りのペアリングのコード（10分で失効）が出ます。
        そのコードと、この端末の名前を入れてください。この端末にパスキーを作ります。
      </p>
      {!supported && (
        <p className="notice notice-error" role="note">
          <span aria-hidden="true">✕ </span>
          このブラウザはパスキー（WebAuthn）に対応していません。最新の Chrome・Edge・Safari・Firefox
          で開いてください。
        </p>
      )}
      <form className="form" onSubmit={(e) => void submit(e)} noValidate>
        <label>
          ペアリングのコード
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            spellCheck={false}
            required
          />
        </label>
        <label>
          この端末の名前（40文字まで）
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例：自宅のPC（Edge）"
            maxLength={80}
            required
          />
        </label>
        <button type="submit" className="button-primary" disabled={busy || !supported}>
          パスキーを作って登録する
        </button>
      </form>
      {busy && (
        <p className="notice notice-info" role="status">
          パスキーを作っています…（ブラウザの表示に従ってください）
        </p>
      )}
      {problem?.kind === "api" && <ErrorBox error={problem.error} title="登録できませんでした" />}
      {problem?.kind === "text" && (
        <p className="notice notice-error" role="alert">
          <span aria-hidden="true">✕ </span>
          {problem.message}
        </p>
      )}
    </>
  );
}
