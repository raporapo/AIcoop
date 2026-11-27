/**
 * 資格保管庫 `~/.aicoop/secrets.json`（5.2.8）。
 *
 * - 本物の資格を置く唯一の場所。どの箱にもマウントしない。中継に送らない。ログに書かない
 * - Linux・macOS では権限を 0600 にする（6.10 の E-008）。書き込みは一時ファイルから入れ替える
 * - 誤りのメッセージに中身を出さない（11.5）。zod の既定のメッセージは値を含むことがあるので使わない
 *
 * ファイルの形：
 * ```json
 * { "version": 1, "secrets": { "<id>": { "kind": "static_token", "value": { "token": "..." }, "updated_at": "..." } } }
 * ```
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { ID_PATTERN, type SecretKind, secretKindSchema } from "@aicoop/shared";

export class SecretStoreError extends Error {
  override name = "SecretStoreError";
}

export type SecretValue =
  | { readonly token: string }
  | {
      readonly app_id: string | number;
      readonly installation_id: string | number;
      readonly private_key: string;
    }
  | { readonly client_id: string; readonly client_secret: string; readonly refresh_token: string };

export interface StoredSecret {
  readonly id: string;
  readonly kind: SecretKind;
  readonly value: SecretValue;
  readonly updatedAt: string;
}

export interface SecretListEntry {
  readonly id: string;
  readonly kind: SecretKind;
  readonly updatedAt: string;
}

/** 種類ごとの、要るキー（5.2.8 の4の表） */
const REQUIRED_KEYS: Readonly<Record<SecretKind, readonly string[]>> = {
  static_token: ["token"],
  github_app: ["app_id", "installation_id", "private_key"],
  google_oauth: ["client_id", "client_secret", "refresh_token"],
  anthropic_oauth: ["token"],
};

/** 数でもよいキー（GitHub App の ID は数で書かれることが多い） */
const NUMERIC_OK = new Set(["app_id", "installation_id"]);

const KIND_LABEL: Readonly<Record<SecretKind, string>> = {
  static_token: "static_token（トークン1つ）",
  github_app: "github_app（GitHub App）",
  google_oauth: "google_oauth（Google のリフレッシュトークン）",
  anthropic_oauth: "anthropic_oauth（claude setup-token で作ったトークン）",
};

function example(kind: SecretKind): string {
  switch (kind) {
    case "static_token":
    case "anthropic_oauth":
      return '{"token": "..."}';
    case "github_app":
      return '{"app_id": 123, "installation_id": 456, "private_key": "-----BEGIN ... KEY-----\\n..."}';
    case "google_oauth":
      return '{"client_id": "...", "client_secret": "...", "refresh_token": "..."}';
  }
}

/** 中身の形を確かめる（5.2.8 の4）。誤りのメッセージには、キーの名前だけを出す */
export function validateSecretValue(kind: SecretKind, value: unknown): SecretValue {
  const required = REQUIRED_KEYS[kind];
  const hint = `${KIND_LABEL[kind]} の資格は ${example(kind)} の形の JSON で渡してください`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SecretStoreError(`JSON のオブジェクトではありません。${hint}`);
  }
  const record = value as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((k) => !required.includes(k));
  if (unknownKeys.length > 0) {
    throw new SecretStoreError(
      `知らないキーがあります: ${unknownKeys.map(safeKeyName).join(", ")}。${hint}`,
    );
  }
  for (const key of required) {
    const v = record[key];
    const ok =
      (typeof v === "string" && v.trim() !== "") ||
      (NUMERIC_OK.has(key) && typeof v === "number" && Number.isSafeInteger(v) && v > 0);
    if (!ok) {
      throw new SecretStoreError(`${key} がない、または空です。${hint}`);
    }
  }
  if (kind === "github_app") {
    const pem = record.private_key as string;
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/.test(pem)) {
      throw new SecretStoreError(
        "private_key が PEM の形（-----BEGIN ... PRIVATE KEY----- から始まる）ではありません。GitHub App の設定画面で作った .pem ファイルの中身をそのまま入れてください",
      );
    }
  }
  return Object.fromEntries(required.map((k) => [k, record[k]])) as unknown as SecretValue;
}

/** キーの名前も外から来た値なので、長すぎるもの・変な文字は伏せる */
function safeKeyName(key: string): string {
  return /^[A-Za-z0-9_-]{1,40}$/.test(key) ? key : "（表示しないキー）";
}

function requireSecretId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new SecretStoreError(
      "資格の ID は英小文字・数字・ハイフンで1〜40文字にしてください（先頭はハイフン以外。例：github、anthropic）",
    );
  }
}

interface FileShape {
  version: 1;
  secrets: Record<string, { kind: SecretKind; value: SecretValue; updated_at: string }>;
}

function readFile(path: string): FileShape {
  if (!existsSync(path)) return { version: 1, secrets: Object.create(null) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SecretStoreError(
      `${path} を JSON として読めません。手で直したなら、形を確かめてください（中身は表示しません）`,
    );
  }
  const broken = () =>
    new SecretStoreError(
      `${path} の形が違います（中身は表示しません）。aicoop secret set で登録し直してください`,
    );
  if (typeof parsed !== "object" || parsed === null) throw broken();
  const { version, secrets } = parsed as { version?: unknown; secrets?: unknown };
  if (version !== 1 || typeof secrets !== "object" || secrets === null || Array.isArray(secrets)) {
    throw broken();
  }
  const out: FileShape["secrets"] = Object.create(null);
  for (const [id, entry] of Object.entries(secrets as Record<string, unknown>)) {
    if (!ID_PATTERN.test(id) || typeof entry !== "object" || entry === null) throw broken();
    const { kind, value, updated_at } = entry as Record<string, unknown>;
    const k = secretKindSchema.safeParse(kind);
    if (!k.success || typeof updated_at !== "string") throw broken();
    try {
      out[id] = { kind: k.data, value: validateSecretValue(k.data, value), updated_at };
    } catch {
      throw broken();
    }
  }
  return { version: 1, secrets: out };
}

function writeFile(path: string, data: FileShape): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    if (process.platform !== "win32") chmodSync(path, 0o600);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function setSecret(
  path: string,
  id: string,
  kind: SecretKind,
  value: unknown,
  now: Date = new Date(),
): StoredSecret {
  requireSecretId(id);
  const checked = validateSecretValue(kind, value);
  const data = readFile(path);
  const updatedAt = now.toISOString();
  data.secrets[id] = { kind, value: checked, updated_at: updatedAt };
  writeFile(path, data);
  return { id, kind, value: checked, updatedAt };
}

export function readSecret(path: string, id: string): StoredSecret | undefined {
  const entry = readFile(path).secrets[id];
  if (!entry) return undefined;
  return { id, kind: entry.kind, value: entry.value, updatedAt: entry.updated_at };
}

export function listSecrets(path: string): SecretListEntry[] {
  return Object.entries(readFile(path).secrets)
    .map(([id, e]) => ({ id, kind: e.kind, updatedAt: e.updated_at }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function removeSecret(path: string, id: string): boolean {
  const data = readFile(path);
  if (!Object.hasOwn(data.secrets, id)) return false;
  delete data.secrets[id];
  writeFile(path, data);
  return true;
}
