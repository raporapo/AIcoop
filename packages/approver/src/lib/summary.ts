/**
 * 保留の要約（5.7.1 の2 の表）を、画面の項目にする。
 *
 * 要約の形は daemon が作る（`HoldView.summary` は unknown）。承認アプリは「表示した要約」の SHA-256 を
 * 署名するので（5.8 の3の3）、知らない項目・知らない種類も黙って捨てず、すべての項目を見せる。
 */
import { revealedString } from "./visible.ts";

export type SummaryValue =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "list"; readonly items: readonly string[] }
  | { readonly type: "json"; readonly text: string }
  | { readonly type: "empty" };

export interface SummaryField {
  readonly key: string;
  readonly label: string;
  readonly value: SummaryValue;
  /** AI 社員・外の人が書いた文章（件名・本文・タイトルなど）。囲んで見せる */
  readonly prose: boolean;
  /** 制御サーバーからの注意（読み違えのおそれなど）。目立たせて見せる */
  readonly warning?: boolean;
}

export interface DescribedSummary {
  readonly kind: string | null;
  readonly kindLabel: string;
  readonly fields: readonly SummaryField[];
  /**
   * 元のリクエスト全体を開いてからでないと承認できないか（10.2「要約だけを見て承認する」）。
   * 送信系（メール・投稿）と、要約の種類がない・知らないものは true。PR のマージは促すだけ
   */
  readonly requireFullRequest: boolean;
}

const KIND_LABELS: Readonly<Record<string, string>> = {
  gmail_message: "メール",
  github_pr_merge: "PR のマージ",
  social_post: "SNS への投稿",
  default: "リクエスト",
  grant: "一時権限",
};

/** 元のリクエストを開かなくても承認できる種類（中身が要約で決まるもの） */
const NO_FULL_REQUEST: ReadonlySet<string> = new Set(["github_pr_merge", "grant"]);

interface KeyInfo {
  readonly label: string;
  readonly prose?: boolean;
  readonly warning?: boolean;
  readonly format?: (value: unknown) => SummaryValue | null;
}

function enumValue(map: Readonly<Record<string, string>>) {
  return (value: unknown): SummaryValue | null =>
    typeof value === "string" && map[value] !== undefined
      ? { type: "text", text: `${map[value]}（${value}）` }
      : null;
}

function yesNo(yes: string, no: string) {
  return (value: unknown): SummaryValue | null =>
    typeof value === "boolean" ? { type: "text", text: value ? yes : no } : null;
}

function paramsValue(value: unknown): SummaryValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return { type: "text", text: "⚠ 制限なし（この操作のすべてに効く）" };
  }
  if (!entries.every(([, v]) => Array.isArray(v) && v.every((x) => typeof x === "string"))) {
    return null;
  }
  return {
    type: "list",
    items: entries.map(([k, v]) => `${k}=${(v as string[]).join(", ")}`),
  };
}

function bytesValue(value: unknown): SummaryValue | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { type: "text", text: formatBytes(value) }
    : null;
}

function prNumber(value: unknown): SummaryValue | null {
  return typeof value === "number" && Number.isInteger(value)
    ? { type: "text", text: `#${value}` }
    : null;
}

/** 決まった項目（この順に並べる）。ここにない項目は、そのあとにキーの名前で並べる */
const KEYS: ReadonlyArray<readonly [string, KeyInfo]> = [
  ["warnings", { label: "制御サーバーからの注意", warning: true }],
  ["member_id", { label: "社員" }],
  ["operation", { label: "操作" }],
  // メール（5.7.1 の2）
  [
    "source",
    { label: "送り方", format: enumValue({ message: "メールを送る", draft: "下書きを送る" }) },
  ],
  ["draft_id", { label: "下書きの ID" }],
  ["from", { label: "差出人" }],
  ["to", { label: "宛先（To）" }],
  ["cc", { label: "Cc" }],
  ["bcc", { label: "Bcc" }],
  ["subject", { label: "件名", prose: true }],
  // PR のマージ
  ["repo", { label: "リポジトリ" }],
  ["repository", { label: "リポジトリ" }],
  ["number", { label: "PR 番号", format: prNumber }],
  ["pr_number", { label: "PR 番号", format: prNumber }],
  ["title", { label: "タイトル", prose: true }],
  ["changed_files", { label: "変更ファイル数" }],
  ["base_ref", { label: "マージ先のブランチ" }],
  ["head_ref", { label: "マージするブランチ" }],
  ["head_sha", { label: "マージするコミット（この sha のときだけ）" }],
  ["merge_method", { label: "マージのしかた" }],
  // 一時権限（5.7.3 の2）
  ["params", { label: "パラメーター", format: paramsValue }],
  [
    "duration_hours",
    {
      label: "時間",
      format: (v) => (typeof v === "number" ? { type: "text", text: `${v}時間` } : null),
    },
  ],
  [
    "mode",
    {
      label: "効き方",
      format: enumValue({ allow: "承認なしで、そのまま通る", hold: "使うたびに承認が要る" }),
    },
  ],
  ["reason", { label: "理由", prose: true }],
  // 投稿・そのほか
  ["destination", { label: "投稿先" }],
  ["channel", { label: "投稿先" }],
  ["platform", { label: "投稿先" }],
  ["method", { label: "メソッド" }],
  ["url", { label: "URL" }],
  ["host", { label: "ホスト" }],
  ["path", { label: "パス" }],
  ["body_bytes", { label: "本文の大きさ", format: bytesValue }],
  ["body_kind", { label: "本文の種類", format: enumValue({ text: "テキスト", html: "HTML" }) }],
  ["body_text", { label: "本文", prose: true }],
  ["body", { label: "本文", prose: true }],
  ["text", { label: "本文", prose: true }],
  [
    "body_head_encoding",
    { label: "本文の先頭の形", format: enumValue({ text: "文字", base64: "base64" }) },
  ],
  ["body_head", { label: "本文の先頭", prose: true }],
  ["body_preview", { label: "本文の先頭", prose: true }],
  [
    "body_truncated",
    {
      label: "本文の切り詰め",
      format: yesNo("先頭だけを表示しています（全体は元のリクエストで）", "全体です"),
    },
  ],
  ["attachments", { label: "添付ファイル" }],
  ["truncated", { label: "切り詰め" }],
  ["manager_comment", { label: "部長のコメント", prose: true }],
];
const KEY_INFO: ReadonlyMap<string, KeyInfo> = new Map(KEYS);
const KEY_ORDER: ReadonlyMap<string, number> = new Map(KEYS.map(([k], i) => [k, i]));

function toValue(value: unknown): SummaryValue {
  if (value === null || value === undefined) return { type: "empty" };
  if (typeof value === "string") return { type: "text", text: value };
  if (typeof value === "number") return { type: "text", text: String(value) };
  if (typeof value === "boolean") return { type: "text", text: value ? "はい" : "いいえ" };
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return { type: "list", items: value as string[] };
  }
  return { type: "json", text: JSON.stringify(value, null, 2) ?? String(value) };
}

export function describeSummary(summary: unknown): DescribedSummary {
  if (summary === null || summary === undefined) {
    return { kind: null, kindLabel: "要約なし", fields: [], requireFullRequest: true };
  }
  if (typeof summary !== "object" || Array.isArray(summary)) {
    return {
      kind: null,
      kindLabel: "要約",
      fields: [{ key: "(値)", label: "値", value: toValue(summary), prose: true }],
      requireFullRequest: true,
    };
  }
  const record = summary as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : null;
  const keys = Object.keys(record).filter((k) => k !== "kind" || kind === null);
  keys.sort((a, b) => (KEY_ORDER.get(a) ?? 1000) - (KEY_ORDER.get(b) ?? 1000));
  const fields = keys.map((key): SummaryField => {
    const info = KEY_INFO.get(key);
    const raw = record[key];
    const value = info?.format?.(raw) ?? toValue(raw);
    // 決まっていない項目でも、長い文章・改行のある文章は外から来た文章として囲む
    const longText = value.type === "text" && (value.text.length > 80 || value.text.includes("\n"));
    return {
      key,
      label: info?.label ?? key,
      value,
      prose: info?.prose === true || longText,
      ...(info?.warning === true ? { warning: true } : {}),
    };
  });
  return {
    kind,
    kindLabel: (kind !== null ? KIND_LABELS[kind] : undefined) ?? kind ?? "リクエスト",
    fields,
    requireFullRequest: kind === null || !NO_FULL_REQUEST.has(kind),
  };
}

/** 文字列、または文字列の配列（件名は配列で来る）を1つの文字列に */
function str(value: unknown): string | null {
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === "string" && v !== "");
    return items.length === 0 ? null : revealedString(items.join(" / "));
  }
  return typeof value === "string" && value !== "" ? revealedString(value) : null;
}

function clip(text: string, max = 80): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** 一覧に出す1行の要約。見えない文字は印にする */
export function shortSummary(summary: unknown): string {
  if (typeof summary !== "object" || summary === null || Array.isArray(summary)) return "";
  const r = summary as Record<string, unknown>;
  const parts: string[] = [];
  switch (r.kind) {
    case "gmail_message": {
      const to = Array.isArray(r.to) ? r.to.filter((v): v is string => typeof v === "string") : [];
      const first = to[0];
      if (first !== undefined) {
        parts.push(
          `宛先 ${revealedString(first)}${to.length > 1 ? ` ほか${to.length - 1}件` : ""}`,
        );
      }
      const subject = str(r.subject);
      if (subject !== null) parts.push(`件名「${subject}」`);
      return clip(parts.join("・"));
    }
    case "github_pr_merge": {
      const repo = str(r.repo) ?? str(r.repository) ?? "";
      const n = typeof r.number === "number" ? r.number : r.pr_number;
      const pr = typeof n === "number" ? ` #${n}` : "";
      const title = str(r.title);
      return clip(`${repo}${pr}${title !== null ? `「${title}」` : ""}`);
    }
    case "social_post": {
      const dest = str(r.destination) ?? str(r.channel) ?? str(r.platform) ?? "";
      const text = str(r.text) ?? str(r.body) ?? "";
      return clip(`${dest}：${text.replace(/\s+/g, " ")}`);
    }
    default: {
      const method = str(r.method);
      const where = str(r.url) ?? `${str(r.host) ?? ""}${str(r.path) ?? ""}`;
      return clip([method, where].filter((v) => v !== null && v !== "").join(" "));
    }
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} バイト`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB（${n} バイト）`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB（${n} バイト）`;
}
