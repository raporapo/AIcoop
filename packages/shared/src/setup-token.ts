/**
 * `claude setup-token` の画面の記録から、作られたトークンとログイン用の URL を取り出す。
 * `aicoop login`（CL-24）と、準備の画面の Claude へのログイン（5.14 の3の2）で使う。
 *
 * `claude setup-token` は端末でだけ動く画面（TUI）で、トークンを画面に出すだけで、どこにも保存しない。
 * 画面は色・カーソルの移動（空白の代わり）・リンク（OSC 8）の制御の文字を含み、端末の幅で折り返される。
 * 取り出せないとき・確かでないときは null を返し、呼ぶ側は貼り付けに切り替える（拒否側に倒す）。
 */
import { isClaudeLoginUrl } from "./api.ts";

/** `claude setup-token` が作るトークンの頭（Claude のサブスクの長期トークン） */
const PREFIX = /sk-ant-oat\d{2}-/g;
const TOKEN_CHAR = /[A-Za-z0-9_-]/;
/** 頭のあとの最低の長さ（これより短ければ、途中で切れたか説明の文） */
const MIN_BODY = 40;
const MAX_TOKEN = 512;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 端末の制御の符号（ESC・BEL）を見つけるための式
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 端末の制御の符号（ESC）を見つけるための式
const CURSOR_FORWARD = /\x1b\[(\d*)C/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 端末の制御の符号（ESC）を見つけるための式
const CURSOR_COLUMN = /\x1b\[\d*G/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 端末の制御の符号（ESC）を見つけるための式
const CSI = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 端末の制御の符号（ESC）を見つけるための式
const ESC_PAIR = /\x1b[@-Z\\-_]/g;

/** 制御の文字を、画面に見える文字にする（カーソルを右へ動かすものは空白に） */
export function visibleText(raw: string): string {
  return (
    raw
      // OSC（リンク・題名など）：ESC ] … BEL か ESC \
      .replace(OSC, "")
      // カーソルを右へ（Ink は空白の代わりに使う）
      .replace(CURSOR_FORWARD, (_, n: string) => " ".repeat(Math.min(Number(n || "1"), 1000)))
      // 列への移動（Ink は語のあいだの空白の代わりにも使う）。語がつながらないよう空白1つにする
      .replace(CURSOR_COLUMN, " ")
      // そのほかの CSI（色・消去・移動・カーソルの表示）
      .replace(CSI, "")
      // そのほかの2文字のエスケープ
      .replace(ESC_PAIR, "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
  );
}

/** 枠の線（Ink の Box）と空白 */
const FRAME = /^[\s─-╿]*$/;
const TRIM_FRAME = /^[\s─-╿]+|[\s─-╿]+$/g;

/**
 * 画面の記録からトークンを取り出す。描き直されたときは最後に出たものを使う。
 * columns（端末の幅）が分かれば、行が幅いっぱいまで埋まっているときだけ次の行とつなぐ。
 */
export function extractSetupToken(raw: string, columns?: number): string | null {
  const text = visibleText(raw);
  let start = -1;
  for (const m of text.matchAll(PREFIX)) start = m.index;
  if (start < 0) return null;

  const lines = text.slice(start).split("\n");
  const first = lines[0] ?? "";
  const lineStart = text.lastIndexOf("\n", start) + 1;
  let token = "";
  let rest = first;
  let lineLength = start - lineStart + first.length;
  for (let i = 0; ; i++) {
    let j = 0;
    while (j < rest.length && TOKEN_CHAR.test(rest[j] as string)) j++;
    token += rest.slice(0, j);
    if (token.length > MAX_TOKEN) return null;
    // トークンのあとに、同じ行で文が続く（空白・枠の線だけではない）なら、そこで終わり
    if (!FRAME.test(rest.slice(j))) {
      if (i === 0 && j === 0) return null;
      break;
    }
    // 行の終わり。幅が分かれば、幅いっぱいまで埋まっていない行は折り返しではない
    if (columns !== undefined && lineLength < columns - 6) break;
    const next = lines[i + 1];
    if (next === undefined) break;
    const inner = next.replace(TRIM_FRAME, "");
    if (inner === "" || ![...inner].every((c) => TOKEN_CHAR.test(c))) break;
    rest = inner;
    lineLength = next.length;
  }
  const body = token.replace(/^sk-ant-oat\d{2}-/, "");
  return body.length >= MIN_BODY ? token : null;
}

// ---- ログイン用の URL（準備の画面。5.14 の3の2） ----

// biome-ignore lint/suspicious/noControlCharactersInRegex: 端末の制御の符号（OSC 8 のリンク）を見つけるための式
const OSC8 = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const URL_IN_TEXT = /https:\/\/[!-~]+/g;

/** ログイン用の URL か（承認アプリも同じもので確かめるので、`@aicoop/shared/api` に置いた） */
export { isClaudeLoginUrl };

/**
 * 画面の記録から、ログイン用の URL を取り出す。リンク（OSC 8）の行き先を先に見て、なければ画面の文字から探す。
 * 描き直されたときは最後に出たものを使う。見つからなければ null
 */
export function extractLoginUrl(raw: string): string | null {
  let found: string | null = null;
  for (const m of raw.matchAll(OSC8)) {
    const target = m[1] ?? "";
    if (isClaudeLoginUrl(target)) found = target;
  }
  if (found !== null) return found;
  for (const m of visibleText(raw).matchAll(URL_IN_TEXT)) {
    if (isClaudeLoginUrl(m[0])) found = m[0];
  }
  return found;
}

// ---- 擬似端末で動かす argv ----

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * `claude setup-token` を擬似端末（`script`。Linux は util-linux、macOS は BSD）の中で動かす argv。
 * `columns` を渡すと、先に擬似端末の幅を広げる（`stty`）。URL・トークンが折り返されないようにするため
 * （標準入力が端末でないと、擬似端末の幅は決まらない）
 */
export function setupTokenArgv(
  platform: NodeJS.Platform,
  script: string,
  claude: string,
  columns?: number,
): string[] {
  if (columns === undefined) {
    return platform === "darwin"
      ? [script, "-q", "/dev/null", claude, "setup-token"]
      : [script, "-q", "-e", "-f", "-c", `${shellQuote(claude)} setup-token`, "/dev/null"];
  }
  const cols = Math.max(20, Math.min(Math.trunc(columns), 10_000));
  const stty = `stty cols ${cols} rows 50 2>/dev/null`;
  return platform === "darwin"
    ? [script, "-q", "/dev/null", "/bin/sh", "-c", `${stty}; exec "$0" setup-token`, claude]
    : [
        script,
        "-q",
        "-e",
        "-f",
        "-c",
        `${stty}; exec ${shellQuote(claude)} setup-token`,
        "/dev/null",
      ];
}
