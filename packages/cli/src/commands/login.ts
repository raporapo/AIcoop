/**
 * `aicoop login`：Claude にログインして、そのトークンを資格 `anthropic` として保存する。
 *
 * `claude setup-token`（公式の、画面のない場所で使う1年の長期トークンを作るコマンド）を動かし、
 * 画面に出たトークンを受け取って `secrets.json` に保存する。コピーと貼り付けを要らなくするため。
 *
 * 守ること：
 * - トークンは AIcoop の出力・エラー・ログに出さない（11.5）。setup-token が画面に出したものは、保存のあとで画面と端末の履歴から消す
 * - setup-token は端末でだけ動く画面なので、`script` で擬似端末を用意して動かす。画面はそのまま見せ、記録はメモリだけに持つ
 * - 取り出せない・確かでないときは、保存せずに貼り付けに切り替える（拒否側に倒す）
 */
import type { CommandInput } from "../command.ts";
import { CliError, UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { requireInitialized } from "../home.ts";
import { extractSetupToken } from "../setup-token.ts";
import { readLine } from "../stdin.ts";
import { readPastedSecret, registeredKind, storeSecret } from "./secret.ts";

const SECRET_ID = "anthropic";
/** 画面を消し、端末の履歴（スクロールで戻れる分）も消す */
const CLEAR_SCREEN = "\x1b[H\x1b[2J\x1b[3J";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** setup-token を擬似端末で動かす argv（Linux は util-linux、macOS は BSD の script） */
export function setupTokenArgv(
  platform: NodeJS.Platform,
  script: string,
  claude: string,
): string[] {
  return platform === "darwin"
    ? [script, "-q", "/dev/null", claude, "setup-token"]
    : [script, "-q", "-e", "-f", "-c", `${shellQuote(claude)} setup-token`, "/dev/null"];
}

export async function run(input: CommandInput): Promise<number> {
  const { home, out, err, ctx } = input;
  if (ctx.platform === "win32") {
    throw new CliError(EXIT.failure, "Windows では aicoop login を使えません", [
      "WSL2 の Ubuntu の中で実行してください（AIcoop は WSL2 の中で動かします。設計書 4.3）",
    ]);
  }
  requireInitialized(home);
  if (!ctx.stdin.isTTY || !ctx.stdout.isTTY) {
    throw new UsageError(
      "aicoop login は端末から実行してください（ブラウザでのログインが要ります）",
      [
        "トークンを手元に持っているなら：aicoop secret set anthropic --kind anthropic_oauth < トークンのファイル",
      ],
    );
  }
  const claude = ctx.deps.which("claude");
  if (!claude) {
    throw new CliError(EXIT.failure, "Claude Code（claude コマンド）が見つかりません", [
      "公式のインストーラーで入れてください：curl -fsSL https://claude.ai/install.sh | bash",
      "入れたあと、~/.local/bin が PATH に入っているかを確かめてください",
    ]);
  }
  const script = ctx.deps.which("script");
  if (!script) {
    throw new CliError(
      EXIT.failure,
      "script コマンドが見つかりません（擬似端末を作るのに使います）",
      ["Debian・Ubuntu なら：sudo apt install util-linux"],
    );
  }

  const before = registeredKind(home, SECRET_ID);
  if (before) {
    err.write(
      `Claude のトークン（資格 ${SECRET_ID}）はもう登録されています。置き換えますか？ [y/N] `,
    );
    const answer = (await readLine(ctx.stdin)).trim().toLowerCase();
    if (!["y", "yes", "はい"].includes(answer)) {
      err.line("取りやめました（何も変えていません）");
      return EXIT.failure;
    }
  }

  err.line(
    "Claude にログインします。ブラウザが開くので、Claude のアカウントでログインしてください。",
  );
  err.line(err.style.dim("  ブラウザが開かなければ、画面に出る URL を開いてください。"));
  err.line(
    err.style.dim(
      "  できたトークン（1年有効）は、AIcoop が受け取って保存します。コピーは要りません。",
    ),
  );
  err.line("");

  const result = await ctx.deps.runInTerminal(setupTokenArgv(ctx.platform, script, claude));
  const token = extractSetupToken(result.output, ctx.stdout.columns);

  let value: unknown;
  if (token) {
    value = { token };
  } else if (result.exitCode !== 0) {
    throw new CliError(
      EXIT.failure,
      "claude setup-token が途中で終わりました。何も保存していません",
      ["もう一度 aicoop login を実行してください"],
    );
  } else {
    err.line("");
    err.line(
      "画面からトークンを読み取れませんでした。上に出たトークンをコピーして、貼り付けてください。",
    );
    value = await readPastedSecret(input, SECRET_ID, "anthropic_oauth");
  }

  // setup-token が画面に出したトークンを、画面と端末の履歴から消す
  ctx.stdout.write(CLEAR_SCREEN);
  storeSecret(input, SECRET_ID, "anthropic_oauth", value, before);
  out.line(`${out.style.green("✓")} Claude にログインしました`);
  out.line(out.style.dim("    画面に出ていたトークンは、画面と端末の履歴から消しました"));
  out.line(out.style.dim("    次は aicoop check で準備を確かめられます"));
  return EXIT.ok;
}
