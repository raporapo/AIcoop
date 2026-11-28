/**
 * この PC のブラウザの端末の登録（5.8 の2。`localhost`）の、コマンドどうしで使い回す部分。
 * `aicoop pair --local` と `aicoop open`（5.14 の2の3・4）が使う。
 *
 * 1. POST /pairing/local で1回限りのコード（10分で失効）をもらう
 * 2. GET /pairing/local/{code} で、ブラウザでパスキーが作られるのを待つ
 * 3. 確認コードをオーナーが見比べる（ここはコマンドごとに違う：`[y/N]` か、ランチャーの窓）
 * 4. 「はい」なら POST /pairing/local/{code}/activate。「いいえ」・中断なら POST /pairing/local/{code}/cancel
 */
import type {
  ActivatePairingResponse,
  DeviceView,
  LocalPairingStatusResponse,
  StartLocalPairingResponse,
} from "@aicoop/daemon";
import { ApiRequestError, apiFailure, type DaemonClient } from "./api/client.ts";
import { interruption } from "./commands/common.ts";
import type { CliContext } from "./context.ts";
import { CliError } from "./errors.ts";
import { EXIT } from "./exit-codes.ts";

const POLL_MS = 1000;

/** やり直すときに勧めるコマンド（既定は aicoop pair --local） */
export interface PairingRetry {
  readonly retry: string;
}

export async function startLocalPairing(
  client: DaemonClient,
  home: string,
): Promise<StartLocalPairingResponse> {
  try {
    return await client.post<StartLocalPairingResponse>("/pairing/local", {});
  } catch (e) {
    throw apiFailure(e, home);
  }
}

/** 取り消す。取り消せなくても、10分で失効する */
export async function cancelLocalPairing(client: DaemonClient, code: string): Promise<void> {
  try {
    await client.post(`/pairing/local/${encodeURIComponent(code)}/cancel`, {});
  } catch {
    // 失効を待つ
  }
}

function endedMessage(status: LocalPairingStatusResponse, retry: string): CliError {
  if (status.status === "expired") {
    return new CliError(EXIT.failure, "コードの期限（10分）が切れました。端末は登録していません", [
      `もう一度 ${retry} を実行してください`,
    ]);
  }
  switch (status.cancel_reason) {
    case "superseded":
      return new CliError(
        EXIT.failure,
        "ほかの aicoop pair --local が始まったので、このコードは使えなくなりました",
        ["登録は、新しく出したコードで続けてください"],
      );
    case "too_many_attempts":
      return new CliError(
        EXIT.failure,
        "違うコードが何度も送られたので、このコードを無効にしました。端末は登録していません",
        [
          "ほかのだれかがコードを当てようとしたのかもしれません",
          `もう一度 ${retry} を実行してください`,
        ],
      );
    default:
      return new CliError(EXIT.failure, "この登録は取り消されました。端末は登録していません", [
        `もう一度 ${retry} を実行してください`,
      ]);
  }
}

/**
 * ブラウザでパスキーが作られるまで待つ。Ctrl+C なら取り消して null。
 * 期限切れ・取り消し（ほかの登録が始まった・違うコードが何度も来た）なら CliError
 */
export async function waitForRegistration(
  ctx: CliContext,
  client: DaemonClient,
  home: string,
  code: string,
  options: PairingRetry,
): Promise<LocalPairingStatusResponse | null> {
  const stop = interruption(ctx);
  try {
    for (;;) {
      let status: LocalPairingStatusResponse;
      try {
        status = await client.get<LocalPairingStatusResponse>(
          `/pairing/local/${encodeURIComponent(code)}`,
        );
      } catch (e) {
        throw apiFailure(e, home);
      }
      if (status.status === "registered") return status;
      if (status.status !== "waiting") throw endedMessage(status, options.retry);
      await stop.sleep(POLL_MS);
      if (stop.interrupted) {
        await cancelLocalPairing(client, code);
        return null;
      }
    }
  } finally {
    stop.dispose();
  }
}

/** 端末を有効にする（オーナーが確認コードを見比べて「はい」を選んだあとだけ呼ぶ） */
export async function activateLocalPairing(
  client: DaemonClient,
  home: string,
  code: string,
  options: PairingRetry,
): Promise<DeviceView> {
  try {
    const activated = await client.post<ActivatePairingResponse>(
      `/pairing/local/${encodeURIComponent(code)}/activate`,
      {},
    );
    return activated.device;
  } catch (e) {
    if (
      e instanceof ApiRequestError &&
      (e.body?.error === "pairing_invalid" || e.body?.error === "invalid_state")
    ) {
      throw new CliError(
        EXIT.failure,
        `端末を有効にできませんでした（登録していません）：${e.body.message}`,
        [`もう一度 ${options.retry} を実行してください`],
      );
    }
    throw apiFailure(e, home);
  }
}

/** 端末から1行読む（`[y/N]`）。Ctrl+C なら null。入力が終わったら、それまでの文字 */
export function readAnswer(ctx: CliContext): Promise<string | null> {
  return new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      unsubscribe();
      offInterrupt();
      resolve(value);
    };
    const unsubscribe = ctx.stdin.subscribe(
      (chunk) => {
        text += chunk.toString("utf8");
        if (text.includes("\u0003")) return finish(null);
        const nl = text.search(/\r?\n|\r/);
        if (nl >= 0) finish(text.slice(0, nl));
      },
      () => finish(text),
    );
    const offInterrupt = ctx.deps.onInterrupt(() => finish(null));
  });
}

const YES = ["y", "yes", "はい"];

/** `[y/N]` の答え：y・yes・はい だけが「はい」。ほかはすべて「いいえ」 */
export function isYes(answer: string): boolean {
  return YES.includes(answer.trim().toLowerCase());
}
