/**
 * 資格の画面の入力（5.14 の5、5.2.8 の4）。種類ごとの欄と、送る形（`POST /secrets/changes` の value）。
 *
 * 中身の確かめは daemon がする（CLI の `aicoop secret set` と同じ）。ここでは、画面の入力欄の都合で
 * 崩れるもの（1行の入力欄は改行を落とすので、PEM の改行）を直すだけにする。
 */
import type { SecretKindName } from "@aicoop/shared/api";

export interface SecretField {
  readonly key: string;
  readonly label: string;
  /** 中身（type=password で受け、画面に残さない） */
  readonly secret: boolean;
  readonly hint?: string;
}

export const SECRET_KINDS: ReadonlyArray<{
  readonly kind: SecretKindName;
  readonly label: string;
}> = [
  { kind: "static_token", label: "トークン1つ（static_token）" },
  { kind: "github_app", label: "GitHub App（github_app）" },
  { kind: "google_oauth", label: "Google のリフレッシュトークン（google_oauth）" },
  { kind: "anthropic_oauth", label: "Claude のトークン（anthropic_oauth）" },
];

export const SECRET_FIELDS: Readonly<Record<SecretKindName, readonly SecretField[]>> = {
  static_token: [{ key: "token", label: "トークン", secret: true }],
  anthropic_oauth: [
    {
      key: "token",
      label: "トークン",
      secret: true,
      hint: "claude setup-token で作ったもの",
    },
  ],
  github_app: [
    { key: "app_id", label: "App ID", secret: false },
    { key: "installation_id", label: "Installation ID", secret: false },
    {
      key: "private_key",
      label: "秘密鍵（.pem の中身）",
      secret: true,
      hint: "GitHub App の設定画面で作った .pem ファイルの中身を、そのまま貼り付けてください",
    },
  ],
  google_oauth: [
    { key: "client_id", label: "クライアント ID", secret: false },
    { key: "client_secret", label: "クライアントシークレット", secret: true },
    { key: "refresh_token", label: "リフレッシュトークン", secret: true },
  ],
};

/** 資格の ID（daemon の ID_PATTERN と同じ） */
export const SECRET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function kindLabel(kind: string): string {
  return SECRET_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

/**
 * PEM の改行を直す。1行の入力欄（type=password）は改行を落とすので、見出しと終わりの行のあいだを
 * 64文字ずつに折り直す。PEM の形でなければ、そのまま（前後の空白だけ除く）返す（daemon が確かめる）
 */
export function normalizePem(text: string): string {
  const t = text.trim();
  const m = /^(-----BEGIN [A-Z ]+-----)([\s\S]*?)(-----END [A-Z ]+-----)$/.exec(t);
  if (m === null) return t;
  const body = (m[2] ?? "").replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [];
  return `${m[1]}\n${lines.join("\n")}\n${m[3]}\n`;
}

/** 欄の値から、送る value を作る（前後の空白は除く。秘密鍵は PEM の改行を直す） */
export function secretValue(
  kind: SecretKindName,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of SECRET_FIELDS[kind]) {
    const raw = values[f.key] ?? "";
    out[f.key] = f.key === "private_key" ? normalizePem(raw) : raw.trim();
  }
  return out;
}
