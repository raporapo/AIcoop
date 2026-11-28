// テスト用：Ink の画面に似せた偽の `claude setup-token`（5.14 の3の2）。
//
// 本物（2.1.332）の画面に似せて、色・列への移動（ESC[nG）・OSC 8 のリンク・枠の線を出す。
// 標準入力からコードを受け取り（Enter＝\r まで）、FAKE_SETUP_TOKEN_MODE に従って終わる。
//   ok          トークンの画面を出して 0 で終わる（既定）
//   bad-exit    「Invalid code」を出して 1 で終わる
//   no-token    「Login successful」だけを出して 0 で終わる（トークンが読み取れない）
//   token-exit1 トークンの画面を出して 1 で終わる
//   no-url      URL を出さずに 1 で終わる
//   hang        コードを受けても何もせず、止められるまで待つ
// 受け取ったコードは FAKE_SETUP_TOKEN_RECORD のファイルに書く（テストが渡したものを確かめる）。
// 引数の最後が setup-token でなければ 2 で終わる。
import { writeFileSync } from "node:fs";

const ESC = "\x1b";
const mode = process.env.FAKE_SETUP_TOKEN_MODE ?? "ok";
const token = process.env.FAKE_SETUP_TOKEN_VALUE ?? "";
const url =
  process.env.FAKE_SETUP_TOKEN_URL ??
  "https://claude.ai/oauth/authorize?IMeNLHJMkrH2UN_V5CAd50YPtDYRKh0F903qpeiMx3cE";
const out = (s) => process.stdout.write(s);

if (process.argv.at(-1) !== "setup-token") {
  out("unknown command\r\n");
  process.exit(2);
}

out(`${ESC}[?25l${ESC}[38;5;174mWelcome${ESC}[9Gto${ESC}[12GClaude${ESC}[19GCode${ESC}[39m\r\r\n`);
out(`${ESC}[2GThis${ESC}[7Gwill${ESC}[12Gguide${ESC}[18Gyou${ESC}[22Gthrough${ESC}[30Gsetup\r\r\n`);
if (mode === "no-url") {
  out("Something went wrong\r\n");
  process.exit(1);
}
out(`${ESC}]8;id=1;${url}\x07${ESC}[38;5;246m${url}${ESC}[39m${ESC}]8;;\x07\r\r\n\r\r\n`);
out(`${ESC}[2GPaste${ESC}[8Gcode${ESC}[13Ghere${ESC}[18Gif${ESC}[21Gprompted\r\r\n`);
out(
  `${ESC}[2G${ESC}[38;5;153m╭${"─".repeat(60)}╮${ESC}[39m\r\r\n│ > │\r\r\n╰${"─".repeat(60)}╯\r\r\n`,
);

let typed = "";
// Ink と同じく、端末なら raw にする（Enter は \r のまま届き、打った文字は画面に出ない）
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  typed += chunk;
  const end = typed.indexOf("\r");
  if (end < 0) return;
  const code = typed.slice(0, end);
  if (process.env.FAKE_SETUP_TOKEN_RECORD) writeFileSync(process.env.FAKE_SETUP_TOKEN_RECORD, code);
  if (mode === "hang") return;
  if (mode === "bad-exit") {
    out(`${ESC}[31mInvalid${ESC}[10Gcode${ESC}[39m\r\r\n`);
    process.exit(1);
  }
  if (mode === "no-token") {
    out("Login successful\r\r\n");
    process.exit(0);
  }
  out(
    `${ESC}[2J${ESC}[H✓${ESC}[3GLong-lived${ESC}[14Gauthentication${ESC}[29Gtoken${ESC}[35Gcreated${ESC}[43Gsuccessfully!\r\r\n\r\r\n`,
  );
  out(
    `Your${ESC}[6GOAuth${ESC}[12Gtoken${ESC}[18G(valid${ESC}[25Gfor${ESC}[29G1${ESC}[31Gyear):\r\r\n\r\r\n`,
  );
  out(`${ESC}[33m${token}${ESC}[39m\r\r\n\r\r\n`);
  out(`Store${ESC}[7Gthis${ESC}[12Gtoken${ESC}[18Gsecurely.\r\r\n${ESC}[?25h`);
  process.exit(mode === "token-exit1" ? 1 : 0);
});
