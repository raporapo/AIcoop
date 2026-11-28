/**
 * `aicoop login`：`claude setup-token` の画面の記録から、作られたトークンを取り出す。
 *
 * `claude setup-token` は端末でだけ動く画面（TUI）で、トークンを画面に出すだけで、どこにも保存しない。
 * 画面は色・カーソルの移動（空白の代わり）・リンク（OSC 8）の制御の文字を含み、端末の幅で折り返される。
 * 取り出せないとき・確かでないときは null を返し、呼ぶ側は貼り付けに切り替える（拒否側に倒す）。
 */

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
