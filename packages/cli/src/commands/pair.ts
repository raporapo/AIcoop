/**
 * `aicoop pair [--local]`（9.1、5.8 の2）：承認アプリの端末を登録する。
 *
 * P2 は `--local`（この PC のブラウザ、http://localhost）だけ。スマホの登録（QRコード・中継）は P3。
 *
 * 1. POST /pairing/local で1回限りのコード（10分で失効）をもらい、URL とともに表示する
 * 2. GET /pairing/local/{code} で、ブラウザでパスキーが作られるのを待つ
 * 3. 確認コード（パスキーの公開鍵から決まる6桁）と端末の名前を出し、`[y/N]` で確かめる
 * 4. y なら POST /pairing/local/{code}/activate で端末を有効にする。N・Ctrl+C なら取り消す
 *
 * 確認コードを見比べるのはオーナー本人なので、端末（TTY）から実行したときだけ動く（`--yes` はない）。
 */
import type {
  ActivatePairingResponse,
  LocalPairingStatusResponse,
  StartLocalPairingResponse,
} from "@aicoop/daemon";
import { ApiRequestError, apiFailure, DaemonClient } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import type { CliContext } from "../context.ts";
import { CliError, UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { readTimezone, requireInitialized } from "../home.ts";
import { cleanLine } from "../ui/text.ts";
import { formatTime } from "../ui/time.ts";
import { interruption } from "./common.ts";

const POLL_MS = 1000;
const YES = ["y", "yes", "はい"];

/** 端末から1行読む。Ctrl+C なら null */
function readAnswer(ctx: CliContext): Promise<string | null> {
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

function endedMessage(status: LocalPairingStatusResponse): CliError {
  if (status.status === "expired") {
    return new CliError(EXIT.failure, "コードの期限（10分）が切れました。端末は登録していません", [
      "もう一度 aicoop pair --local を実行してください",
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
          "もう一度 aicoop pair --local を実行してください",
        ],
      );
    default:
      return new CliError(EXIT.failure, "この登録は取り消されました。端末は登録していません", [
        "もう一度 aicoop pair --local を実行してください",
      ]);
  }
}

export async function run(input: CommandInput): Promise<number> {
  const { home, values, out, err, ctx } = input;
  if (values.local !== true) {
    throw new UsageError(
      "スマホの登録は P3（中継）でできるようになります。いまは aicoop pair --local で、この PC のブラウザを登録してください",
      ["aicoop pair --local"],
    );
  }
  requireInitialized(home);
  if (!ctx.stdin.isTTY) {
    throw new UsageError(
      "aicoop pair --local は、端末から実行してください（確認コードを見比べて y を押します）",
    );
  }
  const client = DaemonClient.connect(ctx, home);
  const tz = await readTimezone(home);

  let started: StartLocalPairingResponse;
  try {
    started = await client.post<StartLocalPairingResponse>("/pairing/local", {});
  } catch (e) {
    throw apiFailure(e, home);
  }
  const code = cleanLine(started.code);
  const style = out.style;
  out.lines([
    style.bold("承認アプリの端末を登録します（この PC のブラウザ）"),
    "",
    `  1. ブラウザで開く   ${style.cyan(cleanLine(started.url))}`,
    `  2. コードを入れる   ${style.bold(code)}（${formatTime(started.expires_at, tz, { timeOnly: true })} まで。1回だけ使えます）`,
    "  3. 端末の名前を入れて、パスキーを作る（指紋・顔・PIN などで本人確認します）",
    "",
  ]);

  const cancel = async () => {
    try {
      await client.post(`/pairing/local/${encodeURIComponent(started.code)}/cancel`, {});
    } catch {
      // 取り消せなくても、10分で失効する
    }
  };

  const stop = interruption(ctx);
  let status: LocalPairingStatusResponse;
  try {
    err.line(err.style.dim("ブラウザでの登録を待っています…（Ctrl+C で取りやめます）"));
    for (;;) {
      try {
        status = await client.get<LocalPairingStatusResponse>(
          `/pairing/local/${encodeURIComponent(started.code)}`,
        );
      } catch (e) {
        throw apiFailure(e, home);
      }
      if (status.status === "registered") break;
      if (status.status !== "waiting") throw endedMessage(status);
      await stop.sleep(POLL_MS);
      if (stop.interrupted) {
        await cancel();
        err.line("取りやめました（端末は登録していません）");
        return EXIT.interrupted;
      }
    }
  } finally {
    stop.dispose();
  }

  out.lines([
    `ブラウザで、端末「${cleanLine(status.device_name ?? "")}」のパスキーが作られました。`,
    "",
    `  確認コード   ${style.bold(cleanLine(status.confirm_code ?? ""))}`,
    "",
    "ブラウザに出ている確認コードと同じなら y を押してください。",
    "違うときは N（ほかのブラウザから、だれかが登録しようとしています）。",
  ]);
  err.write("確認コードは同じですか？ [y/N] ");
  const answer = await readAnswer(ctx);
  if (answer === null) {
    err.line("");
    await cancel();
    err.line("取りやめました（端末は登録していません）");
    return EXIT.interrupted;
  }
  if (!YES.includes(answer.trim().toLowerCase())) {
    await cancel();
    err.line("取りやめました（端末は登録していません）");
    return EXIT.failure;
  }

  let activated: ActivatePairingResponse;
  try {
    activated = await client.post<ActivatePairingResponse>(
      `/pairing/local/${encodeURIComponent(started.code)}/activate`,
      {},
    );
  } catch (e) {
    if (
      e instanceof ApiRequestError &&
      (e.body?.error === "pairing_invalid" || e.body?.error === "invalid_state")
    ) {
      throw new CliError(
        EXIT.failure,
        `端末を有効にできませんでした（登録していません）：${e.body.message}`,
        ["もう一度 aicoop pair --local を実行してください"],
      );
    }
    throw apiFailure(e, home);
  }
  const device = activated.device;
  const appUrl = cleanLine(started.url).replace(/#.*$/, "");
  out.lines([
    "",
    `${style.green("✓")} 端末「${cleanLine(device.name)}」（${cleanLine(device.id)}）を登録しました`,
    `    承認アプリ ${style.cyan(appUrl)} で、パスキーでログインできます`,
    style.dim("    なくしたときは aicoop devices revoke <id> で取り消せます"),
  ]);
  return EXIT.ok;
}
