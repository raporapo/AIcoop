/**
 * 標準入力の読み方：パイプ・リダイレクトは全部読み、端末は1行ずつ（資格は画面に出さずに）読む。
 */
import type { InputStream, OutputStream } from "./context.ts";
import { CliError, UsageError } from "./errors.ts";
import { EXIT } from "./exit-codes.ts";

/** パイプ・リダイレクトを、終わりまで読む。`limit` バイトを超えたら止める */
export function readAll(stdin: InputStream, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const stop = stdin.subscribe(
      (chunk) => {
        size += chunk.length;
        if (size > limit) {
          stop();
          reject(
            new UsageError(
              `入力が大きすぎます（${Math.floor(limit / 1024)} KiB まで）。中身は読んでいません`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      },
      () => {
        stop();
        resolve(Buffer.concat(chunks));
      },
    );
  });
}

/** 端末から1行読む（打った文字は端末が表示する。確かめの y/N に使う） */
export function readLine(stdin: InputStream): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    const stop = stdin.subscribe(
      (chunk) => {
        text += chunk.toString("utf8");
        const nl = text.search(/\r?\n|\r/);
        if (nl >= 0) {
          stop();
          resolve(text.slice(0, nl));
        }
      },
      () => {
        stop();
        resolve(text);
      },
    );
  });
}

/** `{` で始まる JSON の、まだ閉じていない括弧の数（文字列の中は数えない） */
function openBraces(text: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return depth;
}

/**
 * 端末から、打った文字を画面に出さずに読む（raw モード）。
 * Enter で終わる。ただし `{` で始めた JSON は、括弧が閉じるまで改行として読む（複数行の貼り付け）。
 * Backspace・Ctrl+U が効く。Ctrl+C で取りやめる（何も返さない）。矢印キーなどの符号は捨てる。
 */
export function readHidden(
  stdin: InputStream,
  stderr: OutputStream,
  limit: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    let inEscape = false;
    let finished = false;
    stdin.setRawMode?.(true);
    const finish = (error?: CliError) => {
      if (finished) return;
      finished = true;
      stop();
      stdin.setRawMode?.(false);
      stderr.write("\n");
      if (error) reject(error);
      else resolve(text);
    };
    const stop = stdin.subscribe(
      (chunk) => {
        for (const ch of chunk.toString("utf8")) {
          if (finished) return;
          if (inEscape) {
            // ESC [ ... の符号は、英字か ~ で終わる
            if (/[A-Za-z~]/.test(ch)) inEscape = false;
            continue;
          }
          switch (ch) {
            case "\u0003":
              finish(new CliError(EXIT.interrupted, "取りやめました（何も保存していません）"));
              return;
            case "\u0004":
              finish();
              return;
            case "\r":
            case "\n":
              if (text.trimStart().startsWith("{") && openBraces(text) > 0) {
                text += "\n";
                continue;
              }
              finish();
              return;
            case "\u007f":
            case "\b":
              text = [...text].slice(0, -1).join("");
              continue;
            case "\u0015":
              text = "";
              continue;
            case "\u001b":
              inEscape = true;
              continue;
            default:
              text += ch;
              if (text.length > limit) {
                finish(
                  new UsageError(`入力が長すぎます（${limit}文字まで）。中身は保存していません`),
                );
                return;
              }
          }
        }
      },
      () => finish(),
    );
  });
}
