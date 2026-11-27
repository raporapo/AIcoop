import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDaemon, type TestDaemon } from "../../testing/daemon.ts";
import { apiRequest } from "../../testing/http.ts";
import { type TempDir, tempDir } from "../../testing/state-db.ts";

let t: TestDaemon;
let missing: TestDaemon;
let files: TempDir;
let dist: string;
let symlinked = false;

const INDEX = '<!doctype html><title>承認アプリ</title><script src="/app/assets/app.js"></script>';

beforeAll(async () => {
  files = tempDir();
  dist = join(files.path, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), INDEX);
  writeFileSync(join(dist, "assets", "app.js"), "console.log('approver')");
  writeFileSync(join(dist, "assets", "app.css"), "body{}");
  writeFileSync(join(dist, "sw.js"), "self.addEventListener('fetch',()=>{})");
  writeFileSync(join(dist, "manifest.webmanifest"), "{}");
  writeFileSync(join(dist, ".env"), "SECRET=dist-dotfile");
  writeFileSync(join(files.path, "secrets.json"), '{"secret":"outside-dist"}');
  try {
    symlinkSync(join(files.path, "secrets.json"), join(dist, "assets", "link.json"));
    symlinked = true;
  } catch {
    // Windows で権限がなければ、シンボリックリンクの確かめは飛ばす
  }
  t = await startTestDaemon({ daemon: { approverDir: dist } });
  missing = await startTestDaemon({ daemon: { approverDir: join(files.path, "nothing") } });
});
afterAll(async () => {
  await t.cleanup();
  await missing.cleanup();
  files.cleanup();
});

/** ブラウザのように、トークンなしで送る */
const get = (path: string, daemon = t, extra: Record<string, string> = {}) =>
  apiRequest(daemon.daemon.port, {
    path,
    raw: true,
    token: null,
    host: `localhost:${daemon.daemon.port}`,
    headers: extra,
  });

describe("5.8 の1：承認アプリを http://localhost:<port>/app/ で配る（認証なし）", () => {
  it("/app/ は index.html。厳しい CSP・nosniff・枠に入れさせない", async () => {
    const res = await get("/app/");
    expect(res.status).toBe(200);
    expect(res.text).toBe(INDEX);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("部品のファイルは、拡張子の種類で返す", async () => {
    for (const [path, type] of [
      ["/app/assets/app.js", "text/javascript; charset=utf-8"],
      ["/app/assets/app.css", "text/css; charset=utf-8"],
      ["/app/sw.js", "text/javascript; charset=utf-8"],
      ["/app/manifest.webmanifest", "application/manifest+json; charset=utf-8"],
    ] as const) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.headers["content-type"], path).toBe(type);
    }
  });

  it("拡張子のないパスは index.html（SPA）。拡張子のあるパスでファイルがなければ 404", async () => {
    for (const path of ["/app/pair", "/app/holds/h_01JD6V8X3S0Q5W7KQ9M2T4R6YB", "/app/pair/"]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).toBe(INDEX);
    }
    const res = await get("/app/assets/nothing.js");
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("<!doctype");
  });

  it("/ と /app は /app/ へ転送する", async () => {
    for (const path of ["/", "/app"]) {
      const res = await get(path);
      expect([301, 302], path).toContain(res.status);
      expect(res.headers.location, path).toBe("/app/");
    }
  });

  it("127.0.0.1 で開いたら、同じパスの localhost へ転送する（パスキーの RP ID は localhost）", async () => {
    const res = await apiRequest(t.daemon.port, {
      path: "/app/pair?x=1",
      raw: true,
      token: null,
      host: `127.0.0.1:${t.daemon.port}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`http://localhost:${t.daemon.port}/app/pair?x=1`);
  });

  it("HEAD でも答える", async () => {
    const res = await apiRequest(t.daemon.port, {
      method: "HEAD",
      path: "/app/assets/app.js",
      raw: true,
      token: null,
      host: `localhost:${t.daemon.port}`,
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe("");
  });

  it("拒否：dist の外・隠しファイルには届かない（.. ・%2e%2e・%2f・%5c・ドットで始まる名前・シンボリックリンク）", async () => {
    const attempts = [
      "/app/../secrets.json",
      "/app/%2e%2e/secrets.json",
      "/app/assets/%2e%2e/%2e%2e/secrets.json",
      "/app/..%2fsecrets.json",
      "/app/assets/..%2f..%2fsecrets.json",
      "/app/..%5csecrets.json",
      "/app/assets/..%5c..%5csecrets.json",
      "/app/.env",
      "/app/%2eenv",
      "/app/assets//../../secrets.json",
      "/app/%00",
      "/app/assets/app.js%00.html",
      "/app/C:%5cWindows%5cwin.ini",
      "/app/%E0%A4%A",
    ];
    if (symlinked) attempts.push("/app/assets/link.json");
    for (const path of attempts) {
      const res = await get(path);
      expect(res.text, path).not.toContain("outside-dist");
      expect(res.text, path).not.toContain("dist-dotfile");
      expect(res.status, `${path} → ${res.status}`).not.toBe(500);
      if (res.status === 200) expect(res.text, path).toBe(INDEX);
    }
  });

  it("拒否：Host が違えば、画面も配らない（DNS リバインディング）", async () => {
    const res = await apiRequest(t.daemon.port, {
      path: "/app/",
      raw: true,
      token: null,
      host: `evil.example:${t.daemon.port}`,
    });
    expect(res.status).toBe(403);
  });

  it("dist が無ければ、作り方を書いた HTML（503）", async () => {
    const res = await get("/app/", missing);
    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(res.text).toContain("pnpm --filter @aicoop/approver build");
  });

  it("配るのは /app/ の下だけ。ほかのパスは認証が要る", async () => {
    expect((await get("/index.html")).status).toBe(401);
    expect((await get("/api/v1/status")).status).toBe(401);
  });
});
