/**
 * 実行の開始時に、箱へ渡す本物の資格を用意する（5.2.1 の1、5.2.8 の4、5.4.1）。
 *
 * - 資格の ID は、サービスの ID と同じ（`github`・`gmail`。Claude のログインは `anthropic`）
 * - 渡すのは、有効な許可 E(m) に入っている操作のサービスのうち、`secret` を持つものだけ
 * - 種類ごとの扱い：
 *   - `static_token`：そのまま使う（GitHub の fine-grained PAT もこれで使える）
 *   - `github_app`：JWT（RS256）を作り、インストールトークン（1時間）を発行する。
 *     権限は E(m) の操作の `github_permissions` の合併（`metadata: read` は常に）。
 *     リポジトリは、E(m) の `repo` がすべてワイルドカードなしの同じ owner のときだけ名前で絞る
 *     （それ以外は絞らず、資格プロキシの判定で守る）
 *   - `google_oauth`：リフレッシュトークンから、アクセストークン（1時間）を発行する
 * - 本物の値は、ログ・エラー・監査ログに出さない（5.2.8 の2、11.5）
 */
import { createPrivateKey, sign } from "node:crypto";
import type {
  BoxSecret,
  CompanyConfig,
  EffectivePermission,
  ServiceDefinition,
} from "@aicoop/shared";
import { matchesGlob } from "@aicoop/shared";
import { readSecret, type StoredSecret } from "./store.ts";

/** 資格を用意できなかった（利用者に見せる日本語。本物の値は含めない） */
export class CredentialError extends Error {
  override name = "CredentialError";
}

export interface PrepareSecretsInput {
  readonly config: CompanyConfig;
  /** その社員の有効な許可 E(m) */
  readonly effective: readonly EffectivePermission[];
  /** `~/.aicoop/secrets.json` */
  readonly secretsPath: string;
  readonly fetch: typeof fetch;
  readonly now: Date;
  /**
   * 発行先（GitHub・Google）の応答を待つ時間（ミリ秒、既定 30000）。答えないときに、
   * 実行を starting のまま止めないため（取り消しも、これを待つ）
   */
  readonly timeoutMs?: number;
  /**
   * GitHub App のインストールトークンの権限とリポジトリを、E(m) から決めずにこの値にする
   * （保留の要約のために PR を読むときなど、制御サーバー自身が使うトークンを、より狭くする）
   */
  readonly githubScope?: {
    readonly permissions: Readonly<Record<string, "read" | "write">>;
    /** 名前（owner を除いたもの）。null なら絞らない */
    readonly repositories: readonly string[] | null;
  };
}

export interface PreparedSecrets {
  /** 箱へ渡す資格（ドライバーが仮の札を作る） */
  readonly secrets: BoxSecret[];
  /** 資格を使うのに、資格が登録されていないサービス（渡さない） */
  readonly missing: string[];
  /** 伏せ字にする本物の値（11.5） */
  readonly realValues: string[];
}

const GITHUB_API = "https://api.github.com";
const ISSUE_TIMEOUT_MS = 30_000;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** 返ってきたトークンの形（ヘッダーに入れられる、見える ASCII だけ） */
const TOKEN = /^[\x21-\x7e]{8,4096}$/;

/** E(m) に入っている操作のサービスのうち、資格を使うもの（設定の順） */
function servicesWithSecret(
  config: CompanyConfig,
  effective: readonly EffectivePermission[],
): ServiceDefinition[] {
  const ids = new Set<string>();
  for (const p of effective) {
    const op = config.catalog.getOperation(p.op);
    if (op !== undefined) ids.add(op.service);
  }
  return config.services.filter((s) => ids.has(s.id) && s.secret !== null);
}

export async function prepareBoxSecrets(input: PrepareSecretsInput): Promise<PreparedSecrets> {
  const secrets: BoxSecret[] = [];
  const missing: string[] = [];
  const realValues: string[] = [];

  for (const service of servicesWithSecret(input.config, input.effective)) {
    const secretDef = service.secret;
    if (secretDef === null) continue;
    let stored: StoredSecret | undefined;
    try {
      stored = readSecret(input.secretsPath, service.id);
    } catch (e) {
      // 保管庫のエラーは中身を含まない（store.ts）
      throw new CredentialError(e instanceof Error ? e.message : "資格保管庫を読めません");
    }
    if (stored === undefined) {
      missing.push(service.id);
      continue;
    }
    const value = await issue(service, stored, input);
    realValues.push(value);
    secrets.push({
      env: secretDef.env,
      hosts: service.hosts.filter((h) => h !== "*"),
      value,
    });
  }
  return { secrets, missing, realValues };
}

async function issue(
  service: ServiceDefinition,
  stored: StoredSecret,
  input: PrepareSecretsInput,
): Promise<string> {
  const expected = service.secret?.kind;
  const value = stored.value as Record<string, unknown>;
  switch (stored.kind) {
    case "static_token":
      return value.token as string;
    case "github_app":
      if (expected !== "github_app") break;
      return issueGithubAppToken(service, value, input);
    case "google_oauth":
      if (expected !== "google_oauth") break;
      return issueGoogleAccessToken(service, value, input);
    case "anthropic_oauth":
      break;
  }
  throw new CredentialError(
    `資格 ${service.id} の種類（${stored.kind}）は、サービス ${service.id} には使えません。aicoop secret set ${service.id} --kind ${expected ?? "static_token"}（または static_token）で登録し直してください`,
  );
}

// ---- GitHub App ----

/** GitHub App の JWT（RS256）。有効期限は GitHub の上限の10分より短くし、時計のずれに1分の余裕を取る */
export function githubAppJwt(appId: string | number, privateKeyPem: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: typeof appId === "number" || /^\d+$/.test(appId) ? Number(appId) : appId,
      iat,
      exp: iat + 600,
    }),
  );
  const signingInput = `${header}.${payload}`;
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new CredentialError(
      "資格 github の private_key を鍵として読めません。GitHub App の設定画面で作った .pem ファイルの中身を、そのまま aicoop secret set github --kind github_app で登録し直してください",
    );
  }
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), key);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

type GithubPermission = "read" | "write";

/** E(m) の github の操作の `github_permissions` の合併（write は read に勝つ）。`metadata: read` は常に */
export function githubPermissionsFor(
  config: CompanyConfig,
  effective: readonly EffectivePermission[],
): Record<string, GithubPermission> {
  const result: Record<string, GithubPermission> = {};
  for (const p of effective) {
    const op = config.catalog.getOperation(p.op);
    if (op === undefined) continue;
    const def = config.services.find((s) => s.id === op.service);
    const perms = def?.operations[op.name]?.github_permissions ?? {};
    for (const [name, level] of Object.entries(perms)) {
      if (result[name] !== "write") result[name] = level;
    }
  }
  result.metadata ??= "read";
  return result;
}

const REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

/**
 * インストールトークンを絞るリポジトリの名前（owner を除いたもの）。
 * E(m) の github の項目がすべて、ワイルドカードのない `repo` の値で、同じ owner のときだけ返す。
 * それ以外（制限のない項目・`*` を含む値・複数の owner）は null（名前では絞らない）。
 */
export function githubRepositoriesFor(
  config: CompanyConfig,
  effective: readonly EffectivePermission[],
): string[] | null {
  const repos = new Set<string>();
  for (const p of effective) {
    const op = config.catalog.getOperation(p.op);
    if (op?.service !== "github") continue;
    const lists = p.params.repo;
    if (lists === undefined || lists.length === 0) return null;
    const literal = lists.find((l) => l.every((g) => !g.includes("*")));
    if (literal === undefined) return null;
    for (const value of literal) {
      if (lists.every((l) => l.some((g) => matchesGlob(g, value)))) repos.add(value);
    }
  }
  if (repos.size === 0) return null;
  const owners = new Set<string>();
  const names = new Set<string>();
  for (const repo of repos) {
    const m = REPO.exec(repo);
    if (!m) return null;
    owners.add(m[1] as string);
    names.add(m[2] as string);
  }
  return owners.size === 1 ? [...names] : null;
}

async function issueGithubAppToken(
  service: ServiceDefinition,
  value: Record<string, unknown>,
  input: PrepareSecretsInput,
): Promise<string> {
  const appId = value.app_id as string | number;
  const installationId = String(value.installation_id);
  if (!/^\d{1,20}$/.test(installationId) || !/^[A-Za-z0-9.]{1,64}$/.test(String(appId))) {
    throw new CredentialError(
      "資格 github の app_id・installation_id の形が違います（数字）。aicoop secret set github --kind github_app で登録し直してください",
    );
  }
  const jwt = githubAppJwt(appId, value.private_key as string, input.now);
  const repositories =
    input.githubScope !== undefined
      ? input.githubScope.repositories
      : githubRepositoriesFor(input.config, input.effective);
  const body = {
    permissions:
      input.githubScope !== undefined
        ? { ...input.githubScope.permissions }
        : githubPermissionsFor(input.config, input.effective),
    ...(repositories === null ? {} : { repositories: [...repositories] }),
  };

  const signal = AbortSignal.timeout(input.timeoutMs ?? ISSUE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await input.fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "user-agent": "aicoop",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new CredentialError(
      `GitHub App のインストールトークンを発行できませんでした（${GITHUB_API} と${signal.aborted ? "時間内に通信できませんでした" : "通信できません"}）。ネットワークを確かめてください`,
    );
  }
  if (res.status !== 201) {
    throw new CredentialError(
      `GitHub App のインストールトークンを発行できませんでした（HTTP ${res.status}）。資格 ${service.id} の app_id・installation_id・private_key と、App がリポジトリにインストールされているか、権限（${Object.keys(body.permissions).join("・")}）が App に付いているかを確かめてください`,
    );
  }
  const token = await readTokenField(res, "token");
  if (token === null) {
    throw new CredentialError("GitHub App のインストールトークンの応答が読めませんでした");
  }
  return token;
}

// ---- Google ----

async function issueGoogleAccessToken(
  service: ServiceDefinition,
  value: Record<string, unknown>,
  input: PrepareSecretsInput,
): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: String(value.client_id),
    client_secret: String(value.client_secret),
    refresh_token: String(value.refresh_token),
  });
  const signal = AbortSignal.timeout(input.timeoutMs ?? ISSUE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await input.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "aicoop" },
      body: form.toString(),
      signal,
    });
  } catch {
    throw new CredentialError(
      `Google のアクセストークンを発行できませんでした（${GOOGLE_TOKEN_URL} と${signal.aborted ? "時間内に通信できませんでした" : "通信できません"}）。ネットワークを確かめてください`,
    );
  }
  if (res.status !== 200) {
    throw new CredentialError(
      `Google のアクセストークンを発行できませんでした（HTTP ${res.status}）。資格 ${service.id} の client_id・client_secret・refresh_token を確かめ、必要なら aicoop secret set ${service.id} --kind google_oauth で登録し直してください`,
    );
  }
  const token = await readTokenField(res, "access_token");
  if (token === null) {
    throw new CredentialError("Google のアクセストークンの応答が読めませんでした");
  }
  return token;
}

async function readTokenField(res: Response, field: string): Promise<string | null> {
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed !== "object" || parsed === null) return null;
    const token = (parsed as Record<string, unknown>)[field];
    return typeof token === "string" && TOKEN.test(token) ? token : null;
  } catch {
    return null;
  }
}

// ---- Claude のログイン ----

export type AnthropicTokenResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly error: string };

const REGISTER_ANTHROPIC =
  'aicoop secret set anthropic --kind anthropic_oauth で、claude setup-token で作ったトークンを登録してください（標準入力に {"token": "..."} を渡します）';

/** 5.4.1：Claude のログインのトークン（資格 `anthropic`、種類 `anthropic_oauth`）を読む */
export function readAnthropicToken(secretsPath: string): AnthropicTokenResult {
  let stored: StoredSecret | undefined;
  try {
    stored = readSecret(secretsPath, "anthropic");
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "資格保管庫を読めません" };
  }
  if (stored === undefined) {
    return {
      ok: false,
      error: `Claude のログインの資格（anthropic）が登録されていません。${REGISTER_ANTHROPIC}`,
    };
  }
  if (stored.kind !== "anthropic_oauth") {
    return {
      ok: false,
      error: `資格 anthropic の種類が ${stored.kind} です。anthropic_oauth で登録し直してください。${REGISTER_ANTHROPIC}`,
    };
  }
  return { ok: true, token: (stored.value as { token: string }).token };
}
