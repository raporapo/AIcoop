/**
 * 承認アプリの配信（5.8 の1：P2 は daemon が `http://localhost:<port>/app/` で配る）。
 *
 * - `packages/approver/dist/` の静的ファイルを、認証なしで配る（中身は誰が見てもよい画面だけ。
 *   データは API からログインのあとで取る）
 * - 拡張子のないパスは `index.html` を返す（SPA）。拡張子のあるパスでファイルがなければ 404
 * - `..`・`.` で始まる名前・`\`・`%2f` などで dist の外に出るものは 404。シンボリックリンクで外を指すものも 404
 * - 厳しい `Content-Security-Policy`（自分のオリジンのスクリプト・スタイルだけ、枠に入れさせない）と
 *   `X-Content-Type-Options: nosniff` を付ける
 * - dist が無ければ、作り方を書いた HTML（503）を返す
 * - `/` と `/app` は `/app/` へ転送する。`127.0.0.1` で開いたときは `localhost` へ転送する
 *   （パスキーの RP ID は localhost なので、127.0.0.1 の画面ではパスキーを使えない）
 * - Cache-Control は、server.ts の決まり（no-store）のまま
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Context, Hono } from "hono";

/** monorepo の中の `packages/approver/dist/` */
export function defaultApproverDir(): string {
  return fileURLToPath(new URL("../../../../approver/dist/", import.meta.url));
}

export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/** 1つのファイルの上限（承認アプリの部品は小さい） */
const MAX_FILE_BYTES = 16 * 1024 * 1024;

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を弾くため
const BAD_SEGMENT = /[\\/:*?"<>|\u0000-\u001f\u007f]/;

function securityHeaders(c: Context): void {
  c.header("Content-Security-Policy", APP_CSP);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
}

const NOT_BUILT = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><title>承認アプリがまだありません</title></head>
<body>
<h1>承認アプリがまだ作られていません</h1>
<p>リポジトリのフォルダで <code>pnpm --filter @aicoop/approver build</code> を実行して、承認アプリを作ってください。</p>
<p>作ったあとで、このページを読み込み直してください（制御サーバーを起動し直す必要はありません）。</p>
</body>
</html>
`;

function notFound(c: Context): Response {
  securityHeaders(c);
  c.header("Content-Type", "text/plain; charset=utf-8");
  return c.body("見つかりません", 404);
}

/** `/app/` からあとの、送られたままの（%xx のままの）パスを区切って読む。外に出るものは null */
function segmentsOf(c: Context): string[] | null {
  const pathname = new URL(c.req.url).pathname;
  if (!pathname.startsWith("/app/")) return null;
  const parts = pathname.slice("/app/".length).split("/");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (part === "") {
      // 末尾の / だけ許す（/app/、/app/pair/）
      if (i === parts.length - 1) continue;
      return null;
    }
    let s: string;
    try {
      s = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (s.startsWith(".") || BAD_SEGMENT.test(s) || s.length > 200) return null;
    out.push(s);
  }
  return out;
}

function inside(root: string, path: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function sendFile(c: Context, file: string): Response {
  const body = readFileSync(file);
  securityHeaders(c);
  c.header("Content-Type", TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
  return c.body(body, 200);
}

function serve(c: Context, dir: string): Response {
  let root: string;
  try {
    root = realpathSync(resolve(dir));
  } catch {
    root = "";
  }
  const index = root === "" ? "" : join(root, "index.html");
  if (root === "" || !existsSync(index)) {
    securityHeaders(c);
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(NOT_BUILT, 503);
  }
  const segments = segmentsOf(c);
  if (segments === null) return notFound(c);
  if (segments.length > 0) {
    const candidate = resolve(root, ...segments);
    if (!inside(root, candidate)) return notFound(c);
    let real: string | undefined;
    try {
      real = realpathSync(candidate);
    } catch {
      real = undefined;
    }
    if (real !== undefined) {
      if (!inside(root, real)) return notFound(c);
      const st = statSync(real);
      if (st.isFile() && st.size <= MAX_FILE_BYTES) return sendFile(c, real);
      if (!st.isDirectory()) return notFound(c);
    }
    // 拡張子のあるもの（.js など）は、なければ 404（HTML を返さない）
    if (extname(segments.at(-1) as string) !== "") return notFound(c);
  }
  return sendFile(c, index);
}

/** `127.0.0.1:<port>` で来たら、同じパスの `http://localhost:<port>` へ転送する（Host は server.ts で確かめ済み） */
function toLocalhost(c: Context): Response | undefined {
  const host = c.req.header("host")?.toLowerCase() ?? "";
  if (!host.startsWith("127.0.0.1:")) return undefined;
  const url = new URL(c.req.url);
  return c.redirect(
    `http://localhost:${host.slice("127.0.0.1:".length)}${url.pathname}${url.search}`,
    302,
  );
}

export function appRoutes(dir: string): Hono {
  const app = new Hono();
  app.get("/", (c) => toLocalhost(c) ?? c.redirect("/app/", 302));
  app.get("/app", (c) => toLocalhost(c) ?? c.redirect("/app/", 302));
  app.get("/app/*", (c) => toLocalhost(c) ?? serve(c, dir));
  return app;
}
