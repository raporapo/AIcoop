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
import { DaemonClient } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { readTimezone, requireInitialized } from "../home.ts";
import {
  activateLocalPairing,
  cancelLocalPairing,
  isYes,
  readAnswer,
  startLocalPairing,
  waitForRegistration,
} from "../pairing.ts";
import { cleanLine } from "../ui/text.ts";
import { formatTime } from "../ui/time.ts";

const RETRY = { retry: "aicoop pair --local" };

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

  const started = await startLocalPairing(client, home);
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

  const cancel = () => cancelLocalPairing(client, started.code);

  err.line(err.style.dim("ブラウザでの登録を待っています…（Ctrl+C で取りやめます）"));
  const status = await waitForRegistration(ctx, client, home, started.code, RETRY);
  if (status === null) {
    err.line("取りやめました（端末は登録していません）");
    return EXIT.interrupted;
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
  if (!isYes(answer)) {
    await cancel();
    err.line("取りやめました（端末は登録していません）");
    return EXIT.failure;
  }

  const device = await activateLocalPairing(client, home, started.code, RETRY);
  const appUrl = cleanLine(started.url).replace(/#.*$/, "");
  out.lines([
    "",
    `${style.green("✓")} 端末「${cleanLine(device.name)}」（${cleanLine(device.id)}）を登録しました`,
    `    承認アプリ ${style.cyan(appUrl)} で、パスキーでログインできます`,
    style.dim("    なくしたときは aicoop devices revoke <id> で取り消せます"),
  ]);
  return EXIT.ok;
}
