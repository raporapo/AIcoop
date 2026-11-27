/**
 * テスト用：PC のブラウザで開いた承認アプリのように、ローカルAPI を呼ぶ（Host・Origin は
 * `localhost:<port>`、クッキーで認証、Authorization は付けない）。パスキーはソフトウェアの認証器。
 */
import { apiRequest, type TestRequest, type TestResponse } from "./http.ts";
import { type CeremonyOverrides, type SoftAuthenticator, softAuthenticator } from "./webauthn.ts";

export interface BrowserRequestOptions {
  /** Origin（既定：POST なら http://localhost:<port>。null なら付けない） */
  readonly origin?: string | null;
  /** クッキー（既定：ログインしたもの。null なら付けない） */
  readonly cookie?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Browser {
  readonly port: number;
  readonly origin: string;
  readonly auth: SoftAuthenticator;
  /** ログインしたセッションのクッキーの値 */
  session: string | null;
  get(path: string, options?: BrowserRequestOptions): Promise<TestResponse>;
  post(path: string, body?: unknown, options?: BrowserRequestOptions): Promise<TestResponse>;
  /** CLI（Bearer）でコードを出し、この端末を登録して y まで押す。端末の ID を返す */
  pair(bearer: string, name?: string): Promise<string>;
  /** パスキーでログインする（クッキーを覚える） */
  login(over?: CeremonyOverrides): Promise<TestResponse>;
}

export function sessionFromSetCookie(res: TestResponse): string | null {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  for (const line of list) {
    const m = /^aicoop_session=([^;]*)/.exec(line);
    if (m) return m[1] as string;
  }
  return null;
}

export function browser(port: number, auth?: SoftAuthenticator): Browser {
  const origin = `http://localhost:${port}`;
  const passkey = auth ?? softAuthenticator({ origin });
  passkey.defaultOrigin = origin;

  const send = (req: TestRequest, method: string, options: BrowserRequestOptions = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    const o = options.origin === undefined ? (method === "GET" ? null : origin) : options.origin;
    if (o !== null) headers.origin = o;
    const cookie = options.cookie === undefined ? b.session : options.cookie;
    if (cookie !== null) headers.cookie = `aicoop_session=${cookie}`;
    return apiRequest(port, { ...req, method, token: null, host: `localhost:${port}`, headers });
  };

  const b: Browser = {
    port,
    origin,
    auth: passkey,
    session: null,
    get: (path, options) => send({ path }, "GET", options),
    post: (path, body = {}, options) => send({ path, body }, "POST", options),
    async pair(bearer, name = "仕事のPC") {
      const cli = (method: string, path: string) =>
        apiRequest(port, { method, path, token: bearer, ...(method === "POST" && { body: {} }) });
      const started = await cli("POST", "/pairing/local");
      if (started.status !== 201) throw new Error(`pairing/local: ${started.text}`);
      const code = started.json.code as string;
      const opts = await b.post("/pairing/options", { code, device_name: name });
      if (opts.status !== 200) throw new Error(`pairing/options: ${opts.text}`);
      const response = passkey.createCredential(opts.json.options);
      const reg = await b.post("/pairing/register", { code, response });
      if (reg.status !== 200) throw new Error(`pairing/register: ${reg.text}`);
      const act = await cli("POST", `/pairing/local/${code}/activate`);
      if (act.status !== 200) throw new Error(`activate: ${act.text}`);
      return act.json.device.id as string;
    },
    async login(over = {}) {
      const opts = await b.post("/auth/login/options");
      if (opts.status !== 200) throw new Error(`login/options: ${opts.text}`);
      const response = passkey.getAssertion(opts.json.options, over);
      const res = await b.post("/auth/login/verify", { response });
      const value = sessionFromSetCookie(res);
      if (res.status === 200 && value !== null) b.session = value;
      return res;
    },
  };
  return b;
}
