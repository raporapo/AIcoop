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
};

interface KeyInfo {
  readonly label: string;
  readonly prose?: boolean;
  readonly format?: (value: unknown) => SummaryValue | null;
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
  ["from", { label: "差出人" }],
  ["to", { label: "宛先（To）" }],
  ["cc", { label: "Cc" }],
  ["bcc", { label: "Bcc" }],
  ["subject", { label: "件名", prose: true }],
  ["repo", { label: "リポジトリ" }],
  ["repository", { label: "リポジトリ" }],
  ["pr_number", { label: "PR 番号", format: prNumber }],
  ["pr", { label: "PR 番号", format: prNumber }],
  ["number", { label: "番号", format: prNumber }],
  ["title", { label: "タイトル", prose: true }],
  ["changed_files", { label: "変更ファイル数" }],
  ["destination", { label: "投稿先" }],
  ["channel", { label: "投稿先" }],
  ["platform", { label: "投稿先" }],
  ["method", { label: "メソッド" }],
  ["url", { label: "URL" }],
  ["host", { label: "ホスト" }],
  ["path", { label: "パス" }],
  ["body_bytes", { label: "本文の大きさ", format: bytesValue }],
  ["body_text", { label: "本文", prose: true }],
  ["body", { label: "本文", prose: true }],
  ["text", { label: "本文", prose: true }],
  ["body_head", { label: "本文の先頭", prose: true }],
  ["body_preview", { label: "本文の先頭", prose: true }],
  ["attachments", { label: "添付ファイル" }],
  ["truncated", { label: "切り詰め" }],
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
    return { key, label: info?.label ?? key, value, prose: info?.prose === true || longText };
  });
  return {
    kind,
    kindLabel: (kind !== null ? KIND_LABELS[kind] : undefined) ?? kind ?? "リクエスト",
    fields,
    requireFullRequest: kind !== "github_pr_merge",
  };
}

function str(value: unknown): string | null {
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
      const pr = typeof r.pr_number === "number" ? ` #${r.pr_number}` : "";
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
