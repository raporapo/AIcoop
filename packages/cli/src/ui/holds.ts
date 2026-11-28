/**
 * 保留（9.2 の HoldView・HoldDetailView）と一時権限（GrantView）の表示。
 *
 * 要約・部長のコメント・元のリクエスト・再送の結果・申請の理由は、外から来た文章（メールの本文・外のサービスの応答）や
 * 箱の中の AI（4.5 の Z3）が書いた文章を含む。端末に出す前に、必ず無害化する（cleanLine・cleanBlock。CL-20）。
 * 要約の形（5.7.1 の2 の表）は daemon が決める。知らない形・型の違う値は、読める分だけを出す。
 */
import type { GrantView, HoldDetailView, HoldView } from "@aicoop/daemon";
import { decisionStatusLabel } from "./labels.ts";
import type { Style } from "./style.ts";
import { type Column, renderTable } from "./table.ts";
import { cleanBlock, cleanLine, padEnd, truncate } from "./text.ts";
import { formatTime } from "./time.ts";

/** 本文を先頭だけ出すときの行数と文字数（`--full` で全部） */
export const BODY_HEAD_LINES = 20;
export const BODY_HEAD_CHARS = 2000;

/** 見出しの幅（いちばん長い「変更ファイル」「ブランチ」に合わせる） */
const LABEL_WIDTH = 12;

type Rec = Readonly<Record<string, unknown>>;

const asRecord = (v: unknown): Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Rec) : {};
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

const row = (label: string, value: string) => `    ${padEnd(label, LABEL_WIDTH)}  ${value}`;
const list = (values: readonly string[]) =>
  values.length === 0 ? "（なし）" : values.map(cleanLine).join(", ");

/** 一覧の1行に出す要約（無害化してある） */
export function holdSummaryLine(hold: HoldView): string {
  const s = asRecord(hold.summary);
  switch (s.kind) {
    case "gmail_message":
      return cleanLine(
        `宛先 ${strings(s.to).join(", ") || "（なし）"}・件名 ${strings(s.subject)[0] ?? "（なし）"}`,
      );
    case "github_pr_merge":
      return cleanLine(
        `${text(s.repo) ?? "?"} #${typeof s.number === "number" ? s.number : "?"}「${text(s.title) ?? ""}」`,
      );
    case "default":
      return cleanLine(`${text(s.method) ?? ""} ${text(s.url) ?? ""}`.trim());
    default:
      return cleanLine(hold.operation);
  }
}

/**
 * 複数行の文章を、無害化して字下げする。`full` でなければ先頭の `BODY_HEAD_LINES` 行・`BODY_HEAD_CHARS` 文字だけ。
 * 切ったら `omitted` が true
 */
export function textBlock(
  raw: string,
  indent: string,
  full: boolean,
): { readonly lines: string[]; readonly omitted: boolean } {
  let body = cleanBlock(raw).replace(/\n+$/, "");
  let omitted = false;
  if (!full) {
    const chars = [...body];
    if (chars.length > BODY_HEAD_CHARS) {
      body = chars.slice(0, BODY_HEAD_CHARS).join("");
      omitted = true;
    }
  }
  let lines = body.split("\n");
  if (!full && lines.length > BODY_HEAD_LINES) {
    lines = lines.slice(0, BODY_HEAD_LINES);
    omitted = true;
  }
  return { lines: lines.map((l) => (l === "" ? "" : `${indent}${l}`)), omitted };
}

const FULL_HINT = "（先頭だけを出しています。全部は --full）";

/** 要約（5.7.1 の2 の表の中身）を、種類ごとに見出しつきで出す */
export function renderHoldSummary(hold: HoldView, style: Style, full: boolean): string[] {
  const s = asRecord(hold.summary);
  const lines: string[] = [];
  switch (s.kind) {
    case "gmail_message": {
      lines.push(style.bold("要約（メール）"));
      if (strings(s.from).length > 0) lines.push(row("差出人", list(strings(s.from))));
      lines.push(row("宛先（To）", list(strings(s.to))));
      if (strings(s.cc).length > 0) lines.push(row("Cc", list(strings(s.cc))));
      if (strings(s.bcc).length > 0) lines.push(row("Bcc", list(strings(s.bcc))));
      lines.push(row("件名", list(strings(s.subject))));
      if (strings(s.attachments).length > 0) {
        lines.push(row("添付", list(strings(s.attachments))));
      }
      if (s.source === "draft" && text(s.draft_id) !== null) {
        lines.push(row("下書き", cleanLine(text(s.draft_id) ?? "")));
      }
      const kind = s.body_kind === "html" ? "本文（HTML から取り出した文字）" : "本文（テキスト）";
      lines.push(`    ${kind}`);
      const body = textBlock(text(s.body_text) ?? "", "      ", full);
      lines.push(...body.lines);
      if (body.omitted) lines.push(style.dim(`      ${FULL_HINT}`));
      if (s.body_truncated === true)
        lines.push(style.dim("      （要約は本文の先頭4000文字まで）"));
      break;
    }
    case "github_pr_merge": {
      lines.push(style.bold("要約（Pull Request のマージ）"));
      lines.push(row("リポジトリ", cleanLine(text(s.repo) ?? "?")));
      lines.push(row("PR", `#${typeof s.number === "number" ? s.number : "?"}`));
      lines.push(row("タイトル", cleanLine(text(s.title) ?? "")));
      if (typeof s.changed_files === "number") {
        lines.push(row("変更ファイル", `${s.changed_files}個`));
      }
      if (text(s.head_ref) !== null || text(s.base_ref) !== null) {
        lines.push(
          row("ブランチ", cleanLine(`${text(s.head_ref) ?? "?"} → ${text(s.base_ref) ?? "?"}`)),
        );
      }
      if (text(s.head_sha) !== null) lines.push(row("head", cleanLine(text(s.head_sha) ?? "")));
      if (text(s.merge_method) !== null) {
        lines.push(row("マージの方法", cleanLine(text(s.merge_method) ?? "")));
      }
      break;
    }
    case "default": {
      lines.push(style.bold("要約"));
      lines.push(row("リクエスト", cleanLine(`${text(s.method) ?? ""} ${text(s.url) ?? ""}`)));
      if (typeof s.body_bytes === "number") lines.push(row("本文", `${s.body_bytes} バイト`));
      const head = text(s.body_head) ?? "";
      if (head !== "") {
        lines.push(
          `    本文の先頭${s.body_head_encoding === "base64" ? "（テキストではないので base64）" : ""}`,
        );
        const body = textBlock(head, "      ", full);
        lines.push(...body.lines);
        if (body.omitted) lines.push(style.dim(`      ${FULL_HINT}`));
      }
      break;
    }
    default:
      lines.push(style.bold("要約"), row("操作", cleanLine(hold.operation)));
  }
  for (const w of strings(s.warnings)) lines.push(style.yellow(`    注意：${cleanLine(w)}`));
  return lines;
}

/** 5.7.1 の4：元のリクエスト全体（認証のヘッダーは保存していない） */
export function renderHoldRequest(hold: HoldDetailView, style: Style, full: boolean): string[] {
  const req = hold.request;
  const lines = [style.bold("元のリクエスト（認証のヘッダーは保存していません）")];
  if (req.method === "" && req.url === "") {
    lines.push(
      "    保存したリクエストは残っていません（決まってから30日を過ぎると、制御サーバーが消します）",
    );
    return lines;
  }
  lines.push(`    ${cleanLine(`${req.method} ${req.url}`)}`);
  for (const [name, value] of Object.entries(req.headers)) {
    lines.push(`    ${cleanLine(`${name}: ${value}`)}`);
  }
  lines.push(`    本文 ${req.body_bytes} バイト`);
  if (req.body_text !== null) {
    if (req.body_text !== "") {
      const body = textBlock(req.body_text, "      ", full);
      lines.push(...body.lines);
      if (body.omitted) lines.push(style.dim(`      ${FULL_HINT}`));
    }
  } else if (req.body_base64 !== null) {
    if (full) {
      lines.push("      テキストではないので base64 で出します：");
      lines.push(...textBlock(req.body_base64, "      ", true).lines);
    } else {
      lines.push(style.dim("      テキストではありません（--full で base64 を出します）"));
    }
  }
  if (req.truncated)
    lines.push(style.dim("      （制御サーバーが見せるのは、先頭 256 KiB までです）"));
  return lines;
}

/** 1件の保留の詳細（aicoop holds <hold_id>） */
export function renderHoldDetail(
  hold: HoldDetailView,
  tz: string,
  style: Style,
  options: { readonly full: boolean; readonly appUrl: string },
): string[] {
  const at = (iso: string) => formatTime(iso, tz);
  const lines = [
    `${style.bold(hold.id)}  ${decisionStatusLabel(hold.status, style)}（${cleanLine(hold.status)}）`,
    row("操作", cleanLine(hold.operation)),
    row(
      "社員",
      `${cleanLine(hold.member_id)}（部署 ${cleanLine(hold.group_id)}）・スレッド ${cleanLine(hold.thread)}`,
    ),
    row("タスク", cleanLine(hold.task_id)),
  ];
  const params = Object.entries(hold.params);
  if (params.length > 0) {
    lines.push(row("対象", cleanLine(params.map(([k, v]) => `${k}=${v}`).join("・"))));
  }
  lines.push(row("作成", at(hold.created_at)), row("期限", at(hold.expires_at)));
  if (hold.decided_at !== null) {
    lines.push(row("決定", `${at(hold.decided_at)}（${cleanLine(hold.decided_by ?? "不明")}）`));
  }
  if (hold.status === "pending_owner") {
    lines.push("", ...approvalHint(options.appUrl, style));
  } else if (hold.status === "pending_manager") {
    lines.push(
      "",
      style.dim("部長のレビューを待っています。部長が pass すると、オーナーの承認待ちになります"),
    );
  }

  lines.push("", ...renderHoldSummary(hold, style, options.full));
  lines.push("", style.bold("部長のコメント"));
  if (hold.manager_comment === null) {
    lines.push(style.dim("    （まだありません）"));
  } else {
    lines.push(...textBlock(hold.manager_comment, "    ", true).lines);
  }

  lines.push("", ...renderHoldRequest(hold, style, options.full));

  if (hold.response_status !== null || hold.response_text !== null) {
    lines.push("", style.bold("再送の結果"));
    if (hold.response_status !== null) lines.push(`    HTTP ${hold.response_status}`);
    if (hold.response_text !== null && hold.response_text !== "") {
      const body = textBlock(hold.response_text, "      ", options.full);
      lines.push(...body.lines);
      if (body.omitted) lines.push(style.dim(`      ${FULL_HINT}`));
    }
  } else if (hold.status === "replay_failed") {
    lines.push(
      "",
      style.bold("再送の結果"),
      "    送れませんでした（外のサービスの応答はありません）",
    );
  }
  return lines;
}

/**
 * 1件を2行で出す一覧：1行目は列をそろえた表（ID・状態・操作など）、2行目は字下げした中身（社員と要約・理由）。
 * ID が長いので、中身まで1行に並べると80桁の端末に収まらない。2行目は端末の幅で切る。
 * セルと中身は、呼び出し側で無害化してから渡す
 */
export function renderItemList(
  columns: readonly Column[],
  items: readonly { readonly cells: readonly string[]; readonly detail: string }[],
  options: { readonly style: Style; readonly width?: number | undefined },
): string[] {
  const table = renderTable(
    columns,
    items.map((i) => i.cells),
    options,
  );
  const indent = "    ";
  const lines = [table[0] ?? ""];
  items.forEach((item, i) => {
    lines.push(table[i + 1] ?? "");
    const detail =
      options.width === undefined
        ? item.detail
        : truncate(item.detail, options.width - indent.length);
    lines.push(`${indent}${detail}`);
  });
  return lines;
}

/** 一時権限の範囲（`repo=myorg/new,myorg/web-*`） */
export function grantParamsText(grant: GrantView): string {
  const entries = Object.entries(grant.params);
  if (entries.length === 0) return "（制限なし）";
  return cleanLine(entries.map(([k, v]) => `${k}=${v.join(",")}`).join(" "));
}

/**
 * オーナーの承認を待っているものの案内（承認・却下は、承認アプリのパスキーの署名だけ。9.1・P-4）。
 * 2行（狭い端末でも1行が80桁に収まるように）
 */
export function approvalHint(appUrl: string, style: Style, indent = ""): string[] {
  return [
    `${indent}${style.yellow(`承認アプリ（${appUrl}）で決めてください`)}`,
    `${indent}${style.dim("承認・却下は、パスキーの署名でだけできます（コマンドはありません）")}`,
  ];
}
