/**
 * `aicoop open [--launcher]`（9.1、5.14 の1・2）：承認アプリを開く。足りなければ準備から。
 *
 * 1. 設定（aicoop.yaml）がなければ、`aicoop init` と同じ雛形を作る（会社の名前は「わたしの会社」。D-30）。
 *    aicoop.yaml がないのに、ほかの設定・state.db・secrets.json があれば、作らずに止める（会社の ID が変わるため）
 * 2. 制御サーバーが動いていなければ、`aicoop start` と同じく裏で起こし、応答するまで待つ
 * 3. 有効な端末（GET /devices の revoked_at が null）が1台もなければ、端末の登録（5.8 の2。localhost）を始め、
 *    `http://localhost:<port>/app/#/pair?code=<コード>` を開く（フラグメントはサーバーに送られない）
 * 4. パスキーが作られたら確認コード（6桁）を出し、オーナーが「はい」と答えたときだけ有効にする（D-29）。
 *    「いいえ」・中断・期限切れなら有効にしない（取り消す）
 * 5. 有効な端末があれば `http://localhost:<port>/app/` を開く
 *
 * ブラウザ：--launcher なしでは、このコマンドが開く（browser.ts。開けなくても失敗にしない）。
 * --launcher では開かず、ランチャー（scripts/windows/aicoop-launcher.ps1）が Windows の既定のブラウザで開く。
 *
 * ## --launcher の形（標準出力。UTF-8、1行に JSON を1つ、`\n` で終わる）
 *
 * どの行にも `"v": 1`（形の版）と `"event"` がある。知らない event・知らないキーは読み飛ばしてよい。
 *
 * | event      | キー                                  | ランチャーがすること                                  |
 * |------------|---------------------------------------|-------------------------------------------------------|
 * | `progress` | `message`                             | なにもしなくてよい（進み具合）                        |
 * | `open`     | `url`                                 | 既定のブラウザで開く                                  |
 * | `confirm`  | `code`（6桁の数字）・`device_name`    | 「はい／いいえ」で聞き、標準入力に `yes` か `no` の1行 |
 * | `done`     | `url`・`device`（登録した端末 `{id, name}` か null） | 終わり（終了コード 0）                 |
 * | `cancelled`| `message`                             | 登録をやめた（「いいえ」・中断。終了コード 1・130）   |
 * | `error`    | `message`・`hints`（文字列の配列）    | メッセージを見せる（終了コード 1・2・3）              |
 *
 * confirm の答えは、`yes` の1行（前後の空白・CR は無視）だけが「はい」。それ以外の行・入力の終わりは
 * すべて「いいえ」として取り消す（拒否側）。TTY は要らない。標準エラーには人向けの進み具合が出る。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DeviceView, ListDevicesResponse } from "@aicoop/daemon";
import { aicoopPaths } from "@aicoop/daemon";
import { initTemplateFiles, newId } from "@aicoop/shared";
import { apiFailure, DaemonClient, probeDaemon } from "../api/client.ts";
import { openInBrowser } from "../browser.ts";
import type { CommandInput } from "../command.ts";
import type { CliContext } from "../context.ts";
import { CliError, UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { isInitialized, shortPath } from "../home.ts";
import {
  activateLocalPairing,
  cancelLocalPairing,
  isYes,
  type PairingRetry,
  readAnswer,
  startLocalPairing,
  waitForRegistration,
} from "../pairing.ts";
import { createPrinter, type Printer } from "../ui/printer.ts";
import { cleanLine } from "../ui/text.ts";
import { DEFAULT_COMPANY_NAME, writeScaffold } from "./init.ts";
import { launchDaemon } from "./start.ts";

const CONFIRM_CODE = /^\d{6}$/;
const DECLINED = "取りやめました（端末は登録していません）";

type Event =
  | { readonly event: "progress"; readonly message: string }
  | { readonly event: "open"; readonly url: string }
  | { readonly event: "confirm"; readonly code: string; readonly device_name: string }
  | {
      readonly event: "done";
      readonly url: string;
      readonly device: { readonly id: string; readonly name: string } | null;
    }
  | { readonly event: "cancelled"; readonly message: string }
  | { readonly event: "error"; readonly message: string; readonly hints: readonly string[] };

/** 出し方：ターミナル（人向け）か、ランチャー（JSON の行） */
interface Ui {
  readonly launcher: boolean;
  readonly retry: PairingRetry;
  /** 進み具合を出す先（launchDaemon の「起動しています…」も） */
  readonly progress: Printer;
  emit(event: Event): void | Promise<void>;
}

/** ランチャーの答えを1行読む。改行まで届いた行だけを答えとし、入力の終わり・中断なら null */
function readLauncherLine(ctx: CliContext): Promise<string | null> {
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
        const nl = text.indexOf("\n");
        if (nl >= 0) finish(text.slice(0, nl));
        else if (text.length > 1024) finish("");
      },
      () => finish(null),
    );
    const offInterrupt = ctx.deps.onInterrupt(() => finish(null));
  });
}

/** 設定がなければ雛形を作る。作ったら true */
function ensureConfig(home: string, ctx: CliContext): boolean {
  if (isInitialized(home)) return false;
  const paths = aicoopPaths(home);
  const others = [
    ...initTemplateFiles().map((f) => join(home, f.target)),
    paths.stateDb,
    paths.secrets,
  ].filter((p) => existsSync(p));
  const first = others[0];
  if (first !== undefined) {
    throw new CliError(
      EXIT.failure,
      `aicoop.yaml がないのに、ほかの設定があります（${shortPath(first, ctx.userHome)}）。雛形は作っていません`,
      [
        "バックアップから aicoop.yaml を戻してください（git で管理しているなら git checkout aicoop.yaml）",
        "state.db・secrets.json がなければ、足りない雛形だけを aicoop init --only-missing で作れます",
      ],
    );
  }
  writeScaffold(home, { companyId: newId("company"), companyName: DEFAULT_COMPANY_NAME });
  return true;
}

async function connect(input: CommandInput, ui: Ui): Promise<DaemonClient> {
  const { home, ctx } = input;
  const probe = await probeDaemon(ctx, home);
  if (probe.running) return probe.client;
  ui.emit({ event: "progress", message: "制御サーバーを起動しています" });
  await launchDaemon({ home, ctx, err: ui.progress });
  return DaemonClient.connect(ctx, home);
}

async function body(input: CommandInput, ui: Ui): Promise<number> {
  const { home, ctx, out } = input;
  const style = out.style;

  if (ensureConfig(home, ctx)) {
    ui.emit({
      event: "progress",
      message: `設定がなかったので、会社「${DEFAULT_COMPANY_NAME}」の雛形を作りました（${shortPath(home, ctx.userHome)}。名前は準備の画面で変えられます）`,
    });
  }
  const client = await connect(input, ui);
  const appUrl = `http://localhost:${client.info.port}/app/`;

  let devices: readonly DeviceView[];
  try {
    devices = (await client.get<ListDevicesResponse>("/devices")).devices;
  } catch (e) {
    throw apiFailure(e, home);
  }
  if (devices.some((d) => d.revoked_at === null)) {
    await ui.emit({ event: "open", url: appUrl });
    ui.emit({ event: "done", url: appUrl, device: null });
    return EXIT.ok;
  }

  // 端末がない：確認コードを見比べる人が要る
  if (!ui.launcher && !ctx.stdin.isTTY) {
    throw new UsageError(
      "承認アプリの端末がまだないので、登録から始めます。端末から実行するか、--launcher を付けてください（確認コードを見比べて y を押します）",
    );
  }
  const started = await startLocalPairing(client, home);
  const pairUrl = `${appUrl}#/pair?code=${encodeURIComponent(started.code)}`;
  if (!ui.launcher) {
    out.lines([style.bold("承認アプリの端末を登録します（この PC のブラウザ）"), ""]);
  }
  await ui.emit({ event: "open", url: pairUrl });
  if (!ui.launcher) {
    out.lines([
      "",
      "  ブラウザの画面で、端末の名前を入れてパスキーを作ってください（コードは入れてあります。10分で失効します）",
      "",
    ]);
    ui.progress.line(
      ui.progress.style.dim("ブラウザでの登録を待っています…（Ctrl+C で取りやめます）"),
    );
  }

  const status = await waitForRegistration(ctx, client, home, started.code, ui.retry);
  if (status === null) {
    ui.emit({ event: "cancelled", message: DECLINED });
    return EXIT.interrupted;
  }
  const confirmCode = status.confirm_code ?? "";
  if (!CONFIRM_CODE.test(confirmCode)) {
    await cancelLocalPairing(client, started.code);
    throw new CliError(
      EXIT.failure,
      "制御サーバーから届いた確認コードが読めないので、登録をやめました（端末は登録していません）",
      [`もう一度 ${ui.retry.retry} を実行してください`],
    );
  }
  const deviceName = cleanLine(status.device_name ?? "");

  let answer: "yes" | "no" | "interrupted";
  if (ui.launcher) {
    ui.emit({ event: "confirm", code: confirmCode, device_name: deviceName });
    const line = await readLauncherLine(ctx);
    answer = line !== null && line.trim() === "yes" ? "yes" : "no";
  } else {
    out.lines([
      `ブラウザで、端末「${deviceName}」のパスキーが作られました。`,
      "",
      `  確認コード   ${style.bold(confirmCode)}`,
      "",
      "ブラウザに出ている確認コードと同じなら y を押してください。",
      "違うときは N（ほかのブラウザから、だれかが登録しようとしています）。",
    ]);
    ui.progress.write("確認コードは同じですか？ [y/N] ");
    const line = await readAnswer(ctx);
    if (line === null) ui.progress.line("");
    answer = line === null ? "interrupted" : isYes(line) ? "yes" : "no";
  }
  if (answer !== "yes") {
    await cancelLocalPairing(client, started.code);
    ui.emit({ event: "cancelled", message: DECLINED });
    return answer === "interrupted" ? EXIT.interrupted : EXIT.failure;
  }

  const device = await activateLocalPairing(client, home, started.code, ui.retry);
  if (!ui.launcher) {
    out.lines([
      "",
      `${style.green("✓")} 端末「${cleanLine(device.name)}」（${cleanLine(device.id)}）を登録しました`,
      `    ブラウザの画面で、パスキーでログインしてください（${style.cyan(appUrl)}）`,
      style.dim("    なくしたときは aicoop devices revoke <id> で取り消せます"),
    ]);
  }
  ui.emit({
    event: "done",
    url: appUrl,
    device: { id: cleanLine(device.id), name: cleanLine(device.name) },
  });
  return EXIT.ok;
}

function launcherUi(input: CommandInput): Ui {
  return {
    launcher: true,
    retry: { retry: "スタートメニューの「AIcoop」" },
    // ランチャーは標準エラーを読まないこともあるので、色の符号は付けない
    progress: createPrinter(input.ctx.stderr, false),
    emit: (event) => input.out.line(JSON.stringify({ v: 1, ...event })),
  };
}

function terminalUi(input: CommandInput): Ui {
  const { out, err, ctx } = input;
  return {
    launcher: false,
    retry: { retry: "aicoop open" },
    progress: err,
    emit: async (event) => {
      switch (event.event) {
        case "progress":
          err.line(event.message);
          return;
        case "open":
          out.line(`承認アプリを開きます：${out.style.cyan(event.url)}`);
          if (!(await openInBrowser(ctx, event.url))) {
            err.line("（ブラウザを開けませんでした。上の URL をブラウザで開いてください）");
          }
          return;
        case "cancelled":
          err.line(event.message);
          return;
        default:
          return;
      }
    },
  };
}

export async function run(input: CommandInput): Promise<number> {
  if (input.values.launcher !== true) return body(input, terminalUi(input));
  const ui = launcherUi(input);
  try {
    return await body(input, ui);
  } catch (e) {
    if (e instanceof CliError) {
      ui.emit({ event: "error", message: e.headline, hints: e.hints });
      return e.exitCode;
    }
    const message = e instanceof Error ? e.message : String(e);
    ui.emit({ event: "error", message: `思いがけないエラーが起きました：${message}`, hints: [] });
    return EXIT.failure;
  }
}
