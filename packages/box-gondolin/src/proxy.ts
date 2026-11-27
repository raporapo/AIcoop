import type { BoxSecret, NetworkPolicy, ProxiedRequest, ProxyDecision } from "@aicoop/shared";
import { createHttpHooks, type HttpHooks, type SecretDefinition } from "@earendil-works/gondolin";
import { isBlockedAddress } from "./address.ts";

/**
 * 資格プロキシのフック（5.2）。箱ごと（＝実行ごと）に作る（5.2.2 の1）。
 *
 * Gondolin の `createHttpHooks` は、利用者の `onRequest` を先に呼び、そのあとで仮の札を
 * 本物に置き換える（`@earendil-works/gondolin` 0.14.0 の `dist/src/http/hooks.js`）。
 * そのため、判定（`network.onRequest`）が見るヘッダーは仮の札のまま。
 * 判定が `forward` を返したときだけ、Gondolin が `hosts` 宛てのヘッダー（Basic 認証の中も）で置き換える。
 * 本文とクエリでは置き換えない（`replaceSecretsInQuery: false`）。
 *
 * ただし Gondolin はリダイレクトを箱の外で追いかけ、置き換えたあとのヘッダーのまま次の
 * リクエストでも `onRequest` を呼ぶ。判定に本物を見せないよう、判定の前に本物を仮の札へ戻す。
 */
export interface ProxyHooks {
  /** Gondolin の VM に渡すフック */
  readonly httpHooks: HttpHooks;
  /** 箱の環境変数に入れる仮の札（環境変数の名前 → 仮の札） */
  readonly placeholders: Readonly<Record<string, string>>;
  /** 仮の札を無効にする（5.1.3 の2）。以後は置き換えても空文字になる */
  revoke(): void;
}

export interface ProxyHooksInput {
  readonly network: Pick<NetworkPolicy, "onRequest">;
  readonly secrets: readonly BoxSecret[];
  /** 判定が例外を投げたときに呼ぶ（ログ用） */
  readonly onError?: (error: unknown) => void;
}

/** 拒否の理由（5.2.5 の `reason`）。資格プロキシの判定ではなく、箱のドライバーが拒否したもの */
export type DriverDenyReason = "proxy_error" | "invalid_request";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function createProxyHooks(input: ProxyHooksInput): ProxyHooks {
  const definitions: Record<string, SecretDefinition> = {};
  for (const secret of input.secrets) {
    validateSecret(secret, definitions);
    definitions[secret.env] = { hosts: [...secret.hosts], value: secret.value };
  }

  // createHttpHooks の結果（仮の札）が決まってから埋める
  const pairs: { readonly real: string; readonly placeholder: string }[] = [];

  const onRequest = async (request: Request): Promise<Response | undefined> => {
    try {
      maskRealSecrets(request.headers, pairs);
      const proxied = toProxiedRequest(request);
      if (proxied === null) return denyResponse("invalid_request");
      const decision: unknown = await input.network.onRequest(proxied);
      if (isForward(decision)) return undefined;
      if (isRespond(decision)) {
        return new Response(decision.body, { status: decision.status, headers: decision.headers });
      }
      throw new TypeError("資格プロキシの判定が forward でも respond でもない");
    } catch (error) {
      input.onError?.(error);
      return denyResponse("proxy_error");
    }
  };

  const created = createHttpHooks({
    secrets: definitions,
    secretPlaceholderMode: "unique",
    replaceSecretsInQuery: false,
    blockInternalRanges: true,
    isIpAllowed: (info) => !isBlockedAddress(info.ip),
    onRequest,
  });

  const placeholders: Record<string, string> = {};
  for (const secret of input.secrets) {
    const placeholder = created.env[secret.env];
    if (placeholder === undefined) throw new Error(`仮の札を作れなかった：${secret.env}`);
    placeholders[secret.env] = placeholder;
    pairs.push({ real: secret.value, placeholder });
  }

  return {
    httpHooks: created.httpHooks,
    placeholders: Object.freeze(placeholders),
    revoke() {
      for (const entry of created.secretManager.listSecrets()) {
        created.secretManager.deleteSecret(entry.name);
      }
    },
  };
}

function validateSecret(secret: BoxSecret, seen: Record<string, unknown>): void {
  // メッセージには環境変数の名前とホストだけを入れ、本物の値は入れない（5.2.8、11.5）
  if (!ENV_NAME.test(secret.env)) {
    throw new Error(`資格の環境変数の名前が不正です：${JSON.stringify(secret.env)}`);
  }
  if (Object.hasOwn(seen, secret.env)) {
    throw new Error(`資格の環境変数の名前が重なっています：${secret.env}`);
  }
  if (typeof secret.value !== "string" || secret.value.length === 0) {
    throw new Error(`資格 ${secret.env} の値が空です`);
  }
  for (const host of secret.hosts) {
    if (host.includes("*") || host.trim() === "") {
      throw new Error(`資格 ${secret.env} の hosts に * や空の値は書けません`);
    }
  }
}

/**
 * Gondolin の Request を、資格プロキシに渡す形にする。
 * Host ヘッダーと宛先が食い違うなど、判定したものと届くものがずれるおそれがあれば `null`。
 */
export function toProxiedRequest(request: Request): ProxiedRequest | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const protocol = url.protocol === "https:" ? "https" : url.protocol === "http:" ? "http" : null;
  if (protocol === null) return null;
  const port = url.port === "" ? (protocol === "https" ? 443 : 80) : Number(url.port);
  const host = normalizeUrlHost(url.hostname);
  if (host === "") return null;

  const hostHeader = request.headers.get("host");
  if (hostHeader !== null && !sameAuthority(hostHeader, protocol, host, port)) return null;

  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });

  const length = request.headers.get("content-length");
  const bodyBytes = length !== null && /^\d+$/.test(length) ? Number(length) : null;

  return Object.freeze({
    method: request.method,
    protocol,
    host,
    port,
    path: `${url.pathname}${url.search}`,
    headers: Object.freeze(headers),
    bodyBytes,
    readBody: async () => new Uint8Array(await request.clone().arrayBuffer()),
  });
}

function normalizeUrlHost(hostname: string): string {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

function sameAuthority(
  hostHeader: string,
  protocol: "http" | "https",
  host: string,
  port: number,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(`${protocol}://${hostHeader.trim()}/`);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/") return false;
  const headerPort = parsed.port === "" ? (protocol === "https" ? 443 : 80) : Number(parsed.port);
  return normalizeUrlHost(parsed.hostname) === host && headerPort === port;
}

/**
 * ヘッダーに本物の資格があれば、仮の札に戻す（その場で書き換える）。
 * Gondolin がリダイレクトを追うとき、置き換えたあとのヘッダーで次の `onRequest` を呼ぶため。
 */
function maskRealSecrets(
  headers: Headers,
  pairs: readonly { readonly real: string; readonly placeholder: string }[],
): void {
  if (pairs.length === 0) return;
  const updates: [string, string][] = [];
  headers.forEach((value, name) => {
    let next = replaceAll(value, pairs);
    if (/^(proxy-)?authorization$/i.test(name)) next = maskBasicAuth(next, pairs);
    if (next !== value) updates.push([name, next]);
  });
  for (const [name, value] of updates) headers.set(name, value);
}

function replaceAll(
  value: string,
  pairs: readonly { readonly real: string; readonly placeholder: string }[],
): string {
  let out = value;
  for (const { real, placeholder } of pairs) {
    if (out.includes(real)) out = out.split(real).join(placeholder);
  }
  return out;
}

function maskBasicAuth(
  value: string,
  pairs: readonly { readonly real: string; readonly placeholder: string }[],
): string {
  const match = /^(Basic)(\s+)(\S+)(\s*)$/i.exec(value);
  if (!match) return value;
  const [, scheme, space, token = "", trailing = ""] = match;
  const decoded = Buffer.from(token, "base64").toString("utf8");
  const masked = replaceAll(decoded, pairs);
  if (masked === decoded) return value;
  return `${scheme}${space}${Buffer.from(masked, "utf8").toString("base64")}${trailing}`;
}

function isForward(decision: unknown): boolean {
  return (
    typeof decision === "object" &&
    decision !== null &&
    (decision as { action?: unknown }).action === "forward"
  );
}

function isRespond(decision: unknown): decision is Extract<ProxyDecision, { action: "respond" }> {
  if (typeof decision !== "object" || decision === null) return false;
  const d = decision as Record<string, unknown>;
  return (
    d.action === "respond" &&
    typeof d.status === "number" &&
    typeof d.body === "string" &&
    typeof d.headers === "object" &&
    d.headers !== null
  );
}

/** 箱のドライバーが拒否したときの応答（5.2.5 の deny と同じ形） */
export function denyResponse(reason: DriverDenyReason): Response {
  return new Response(JSON.stringify({ aicoop: "deny", operation: null, reason }), {
    status: 403,
    headers: { "content-type": "application/json", "x-aicoop-decision": "deny" },
  });
}
