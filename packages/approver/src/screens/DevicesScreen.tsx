/**
 * 5.8 の4 (6) 端末：一覧・取り消し（確かめてから。T-12）・「この端末」の印・新しい端末の登録の案内。
 */
import type { DeviceView } from "@aicoop/shared/api";
import { useState } from "react";
import type { ApiFailure } from "../api/client.ts";
import { ConfirmDialog } from "../components/ConfirmDialog.tsx";
import { SafeText } from "../components/text.tsx";
import { ErrorBox, LoadFailed, Loading, StaleNote, TimeText } from "../components/ui.tsx";
import { useApp } from "../lib/context.tsx";
import { toFailure, useResource } from "../lib/resource.ts";
import { revealedString } from "../lib/visible.ts";

export function DevicesScreen() {
  const app = useApp();
  const res = useResource(() => app.api.devices(), { key: "devices" });
  const [target, setTarget] = useState<DeviceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const me = app.session?.device.id ?? null;

  const revoke = async (device: DeviceView) => {
    setBusy(true);
    setError(null);
    try {
      await app.api.revokeDevice(device.id);
      setTarget(null);
      if (device.id === me) {
        app.endSession("この端末を取り消しました。この端末のパスキーでは、もうログインできません");
        return;
      }
      await res.reload();
    } catch (e) {
      setError(toFailure(e));
      setTarget(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>端末</h1>
      <p>
        承認アプリを使える端末（パスキー）です。なくした端末・使わない端末は取り消してください。
      </p>
      <StaleNote since={res.staleSince} />
      {error !== null && <ErrorBox error={error} title="取り消せませんでした" />}
      {res.data === undefined ? (
        res.error !== undefined ? (
          <LoadFailed error={res.error} what="端末の一覧" />
        ) : (
          <Loading what="端末の一覧" />
        )
      ) : (
        <ul className="device-list" aria-label="端末の一覧">
          {res.data.devices.map((d) => {
            const name = revealedString(d.name);
            return (
              <li
                key={d.id}
                className={d.revoked_at !== null ? "device-item device-revoked" : "device-item"}
              >
                <p className="device-head">
                  <strong>
                    <SafeText text={d.name} />
                  </strong>{" "}
                  <span className="muted small">
                    （{d.kind === "pc" ? "PC" : "スマホ"}・{d.id}）
                  </span>
                  {d.id === me && (
                    <span className="badge tone-active">
                      <span aria-hidden="true">● </span>この端末
                    </span>
                  )}
                </p>
                <p className="small">
                  登録 <TimeText iso={d.created_at} />
                  {d.revoked_at !== null && (
                    <>
                      {" "}
                      — <span aria-hidden="true">✕ </span>取り消し済み（
                      <TimeText iso={d.revoked_at} />）
                    </>
                  )}
                </p>
                {d.revoked_at === null && (
                  <button
                    type="button"
                    className="button-reject button-small"
                    disabled={busy || !app.reachable}
                    onClick={() => setTarget(d)}
                  >
                    「{name}」を取り消す…
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <section className="card" aria-labelledby="pair-heading">
        <h2 id="pair-heading">新しい端末を登録する</h2>
        <ol>
          <li>
            PC のターミナルで <code>aicoop pair --local</code> を実行します。
          </li>
          <li>
            表示された URL（<code>http://localhost:7070/app/#/pair</code>
            ）を、登録したい端末のブラウザで開きます。
          </li>
          <li>
            コードと端末の名前を入れてパスキーを作り、6桁の数字が同じか確かめて、ターミナルで y
            を押します。
          </li>
        </ol>
        <p className="muted small">
          いまは PC のブラウザだけで使えます（スマホからは、中継ができる P3 から）。
        </p>
      </section>

      {target !== null && (
        <ConfirmDialog
          title={`「${revealedString(target.name)}」を取り消しますか？`}
          confirmLabel="取り消す"
          tone="danger"
          busy={busy}
          onCancel={() => setTarget(null)}
          onConfirm={() => void revoke(target)}
        >
          <p>
            取り消すと、この端末のパスキーでは、ログインも承認もできなくなります。元に戻せません（使うには登録し直します）。
          </p>
          {target.id === me && (
            <p className="notice notice-warn">
              <span aria-hidden="true">⚠ </span>
              この端末です。取り消すと、すぐにログアウトします。
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
