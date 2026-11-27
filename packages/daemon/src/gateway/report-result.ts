/**
 * 組み込み道具 `report_result`（5.3.3）の入力の検証。
 *
 * - `summary`：必須の文字列。空白だけは不可。最大4000文字。端末を操る制御文字（タブ・改行以外）と
 *   向きを変える文字は不可（オーナーの CLI・承認アプリにそのまま出るので、画面を偽れないように）
 * - `files`：任意の文字列の配列、最大50個。作業ディレクトリ以下のパス
 *   - 箱の中のパス `/work/...` と、作業ディレクトリからの相対パスを受け付ける
 *   - `..` を含むもの、`/work` の外の絶対パス、存在しないもの、リンク（とリンクを通るもの）は不可
 *   - 記録するときは、作業フォルダからの相対パス（`/` 区切り）にそろえる
 * - 知らない引数があれば不可
 *
 * 引数は箱の中から来る（Z3）。迷うものは受け付けない（拒否側に倒す）。
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { GUEST_PATHS } from "../run/mounts.ts";

export const MAX_SUMMARY_CHARS = 4000;
export const MAX_FILES = 50;
const MAX_PATH_CHARS = 4096;

export interface ReportResult {
  readonly summary: string;
  /** 作業フォルダからの相対パス（`/` 区切り） */
  readonly files: readonly string[];
}

export type ReportValidation =
  | { readonly ok: true; readonly value: ReportResult }
  | { readonly ok: false; readonly message: string };

/** report_result の入力の JSON Schema（tools/list で見せる） */
export const REPORT_RESULT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      maxLength: MAX_SUMMARY_CHARS,
      description: "やったこと・結果・残ったこと（必須。4000文字まで）",
    },
    files: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_FILES,
      description: `作ったファイルの、作業ディレクトリ（${GUEST_PATHS.work}）以下のパス（50個まで）`,
    },
  },
  required: ["summary"],
  additionalProperties: false,
} as const;

const fail = (message: string): ReportValidation => ({ ok: false, message });

export function validateReportResult(args: unknown, workDir: string): ReportValidation {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return fail("引数はオブジェクトで渡してください");
  }
  const record = args as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => k !== "summary" && k !== "files");
  if (unknown.length > 0) {
    return fail("使える引数は summary と files だけです");
  }

  const summary = record.summary;
  if (typeof summary !== "string" || summary.trim() === "") {
    return fail("summary（やったこと・結果）を文字列で書いてください");
  }
  if ([...summary].length > MAX_SUMMARY_CHARS) {
    return fail(`summary は${MAX_SUMMARY_CHARS}文字までです`);
  }
  if (hasUnsafeChar(summary)) {
    return fail(
      "summary に制御文字（ESC など）や文字の向きを変える文字は使えません。ふつうの文章で書いてください",
    );
  }

  const rawFiles = record.files ?? [];
  if (!Array.isArray(rawFiles) || !rawFiles.every((f) => typeof f === "string")) {
    return fail("files はパスの文字列の配列にしてください");
  }
  if (rawFiles.length > MAX_FILES) return fail(`files は${MAX_FILES}個までです`);

  const files: string[] = [];
  for (const raw of rawFiles as string[]) {
    const checked = checkFile(raw, workDir);
    if (typeof checked !== "string") return fail(checked.message);
    if (!files.includes(checked)) files.push(checked);
  }
  return { ok: true, value: { summary, files } };
}

/**
 * 端末を操る制御文字（タブ・改行・復帰以外の Cc。ESC・C1 の CSI など）と、
 * 文字の向きを変える文字（埋め込み・上書き U+202A〜U+202E、分離 U+2066〜U+2069）を含むか
 */
function hasUnsafeChar(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (/\p{Cc}/u.test(ch)) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

/** 1つのパスを確かめ、作業フォルダからの相対パスにする */
function checkFile(raw: string, workDir: string): string | { message: string } {
  const shown = JSON.stringify(raw.length > 200 ? `${raw.slice(0, 200)}…` : raw);
  const bad = (why: string) => ({ message: `files の ${shown} は使えません：${why}` });

  if (raw === "" || raw.length > MAX_PATH_CHARS) return bad("空か、長すぎます");
  if (/[\p{Cc}\p{Cf}]/u.test(raw) || raw.includes("\\")) {
    return bad("制御文字や \\ は使えません。/ で区切ってください");
  }

  let relative = raw;
  if (raw.startsWith("/")) {
    const prefix = `${GUEST_PATHS.work}/`;
    if (!raw.startsWith(prefix)) {
      return bad(`作業ディレクトリ ${GUEST_PATHS.work} の外です`);
    }
    relative = raw.slice(prefix.length);
  }
  const segments = relative.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) return bad("ファイルのパスを書いてください");
  if (segments.includes("..")) return bad(".. は使えません");
  if (process.platform === "win32" && segments.some((s) => s.includes(":"))) {
    return bad(": は使えません");
  }

  // ホスト側で、リンクを辿らずに1区切りずつ確かめる
  let current = workDir;
  for (const [i, segment] of segments.entries()) {
    current = join(current, segment);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(current);
    } catch {
      return bad("ありません");
    }
    if (st.isSymbolicLink()) return bad("リンクは使えません");
    const last = i === segments.length - 1;
    if (!last && !st.isDirectory()) return bad("ありません");
    if (last && !st.isFile() && !st.isDirectory()) return bad("ふつうのファイルではありません");
  }
  return segments.join("/");
}
