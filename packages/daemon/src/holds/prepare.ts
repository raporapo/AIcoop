/**
 * 保留を作る前の準備（5.7.1 の2）：要約を作り、送るリクエストを「見せたものと同じ中身」に固める。
 *
 * 要約は、操作の `summary` の種類で作る（5.7.1 の2 の表）：
 * - `gmail_message`：宛先（To・Cc・Bcc）、件名、本文のテキスト部分（先頭4000文字）。
 *   `messages/send` は本文 `{"raw": base64url の RFC 2822}` を読む。
 *   `drafts/send` は下書きの ID しかないので、本物の資格で下書きを取ってきて要約する
 * - `github_pr_merge`：リポジトリ、PR番号。本物の資格で PR のタイトルと変更ファイル数を取って添える
 * - 指定なし（と、まだ作っていない `social_post`）：メソッド、URL、本文の先頭2KB
 *
 * 承認のあとで中身を差し替えられないように（部長とオーナーが見たものと、送るものを同じにする）：
 * - `drafts/send` は、取ってきた下書きの中身（raw と threadId）を送る `messages/send` に固める
 *   （AI社員は下書きを書き換えられる＝ gmail.draft.update を持つので、下書きの ID のまま送ると、
 *   承認のあとに中身を変えられてしまう。下書きは消えずに残る）
 * - `pulls/<n>/merge` は、本文に `sha`（取ってきたときの PR の head）を付ける。GitHub は head が
 *   それと違えばマージしない（承認のあとに push で中身を変えられない）
 * 下書き・PR を取れないときは、中身を確かめられないので、保留にしない（ok: false。資格プロキシは拒否する）。
 */
import type { CompanyConfig, CompiledOperation } from "@aicoop/shared";
import { issueForOperation } from "./credentials.ts";
import type { SavedHoldRequest } from "./hold-file.ts";
import { parseMail } from "./mime.ts";
import { bodyHead, headChars } from "./text.ts";

/** 指定なしの要約の本文の先頭（5.7.1 の2「本文の先頭2KB」） */
export const DEFAULT_BODY_HEAD_BYTES = 2048;
/** gmail_message の本文のテキストの先頭（5.7.1 の2） */
export const MAIL_BODY_CHARS = 4000;
/** 下書き・PR を取りに行くときの待ち時間 */
const FETCH_TIMEOUT_MS = 10_000;

interface SummaryCommon {
  readonly operation: string;
  readonly member_id: string;
  /** 読み違えのおそれなど（オーナー・部長に見せる日本語） */
  readonly warnings: readonly string[];
}

export interface DefaultSummary extends SummaryCommon {
  readonly kind: "default";
  readonly method: string;
  readonly url: string;
  readonly body_bytes: number;
  readonly body_head: string;
  readonly body_head_encoding: "text" | "base64";
  readonly body_truncated: boolean;
}

export interface GmailSummary extends SummaryCommon {
  readonly kind: "gmail_message";
  /** message：messages/send の raw、draft：drafts/send の下書き（取ってきた中身） */
  readonly source: "message" | "draft";
  readonly draft_id: string | null;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: readonly string[];
  readonly body_kind: "text" | "html" | null;
  readonly body_text: string;
  readonly body_truncated: boolean;
  readonly attachments: readonly string[];
}

export interface GithubPrMergeSummary extends SummaryCommon {
  readonly kind: "github_pr_merge";
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly changed_files: number;
  /** マージを許す head（本文の sha） */
  readonly head_sha: string;
  readonly head_ref: string | null;
  readonly base_ref: string | null;
  readonly merge_method: string | null;
}

export type HoldSummary = DefaultSummary | GmailSummary | GithubPrMergeSummary;

export type PreparedHold =
  | { readonly ok: true; readonly summary: HoldSummary; readonly request: SavedHoldRequest }
  /** 中身を確かめられない（message はログ用。本物の資格は含まない） */
  | { readonly ok: false; readonly message: string };

export interface PrepareHoldInput {
  readonly config: CompanyConfig;
  readonly operation: CompiledOperation;
  /** パスから取り出したパラメーターの値 */
  readonly params: Readonly<Record<string, string>>;
  readonly memberId: string;
  /** 保存する形にしたリクエスト */
  readonly request: SavedHoldRequest;
  readonly secretsPath: string;
  readonly fetch: typeof fetch;
  readonly now: Date;
  readonly timeoutMs?: number;
}

export async function prepareHold(input: PrepareHoldInput): Promise<PreparedHold> {
  switch (input.operation.summary) {
    case "gmail_message":
      return prepareGmail(input);
    case "github_pr_merge":
      return prepareGithubMerge(input);
    case "social_post":
      return {
        ok: true,
        request: input.request,
        summary: defaultSummary(input, [
          "要約の種類 social_post は、まだ対応していません。元のリクエストで中身を確かめてください",
        ]),
      };
    default:
      return { ok: true, request: input.request, summary: defaultSummary(input, []) };
  }
}

function defaultSummary(input: PrepareHoldInput, warnings: readonly string[]): DefaultSummary {
  const head = bodyHead(input.request.body, DEFAULT_BODY_HEAD_BYTES);
  return {
    kind: "default",
    operation: input.operation.id,
    member_id: input.memberId,
    method: input.request.method,
    url: input.request.url,
    body_bytes: input.request.body.byteLength,
    body_head: head.text ?? head.base64 ?? "",
    body_head_encoding: head.text !== null ? "text" : "base64",
    body_truncated: head.truncated,
    warnings,
  };
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 本物の資格で GET し、JSON のオブジェクトを返す。読めなければ null */
async function getJson(
  input: PrepareHoldInput,
  url: string,
  githubScope?: Parameters<typeof issueForOperation>[0]["githubScope"],
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; message: string }> {
  const issued = await issueForOperation({
    config: input.config,
    operationId: input.operation.id,
    params: input.params,
    secretsPath: input.secretsPath,
    fetch: input.fetch,
    now: input.now,
    timeoutMs: input.timeoutMs ?? FETCH_TIMEOUT_MS,
    ...(githubScope !== undefined && { githubScope }),
  });
  if (!issued.ok) return issued;
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "aicoop" };
  if (issued.credential !== null) {
    headers[issued.credential.header] = `Bearer ${issued.credential.value}`;
  }
  let res: Response;
  try {
    res = await input.fetch(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: `${new URL(url).host} と通信できませんでした` };
  }
  if (res.status !== 200) {
    return { ok: false, message: `${new URL(url).host} が HTTP ${res.status} を返しました` };
  }
  try {
    const value: unknown = await res.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, message: "応答が JSON のオブジェクトではありません" };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, message: "応答を JSON として読めません" };
  }
}

// ---- gmail_message ----

const DRAFT_ID = /^[A-Za-z0-9_-]{1,200}$/;

async function prepareGmail(input: PrepareHoldInput): Promise<PreparedHold> {
  const url = new URL(input.request.url);
  const body = parseJsonObject(input.request.body);

  if (url.pathname.endsWith("/drafts/send")) {
    const draftId = body?.id;
    if (typeof draftId !== "string" || !DRAFT_ID.test(draftId)) {
      return { ok: false, message: "drafts/send の本文に、下書きの id がありません" };
    }
    const draftUrl = `${url.origin}${url.pathname.replace(/\/send$/, `/${draftId}`)}?format=raw`;
    const got = await getJson(input, draftUrl);
    if (!got.ok) return { ok: false, message: `下書きを取れませんでした（${got.message}）` };
    const message = got.value.message as Record<string, unknown> | undefined;
    const raw = message?.raw;
    if (typeof raw !== "string" || raw === "") {
      return { ok: false, message: "下書きの中身（raw）がありません" };
    }
    const threadId = typeof message?.threadId === "string" ? message.threadId : undefined;
    const fixed: SavedHoldRequest = {
      method: "POST",
      url: `${url.origin}${url.pathname.replace(/\/drafts\/send$/, "/messages/send")}`,
      headers: { ...withoutBodyHeaders(input.request.headers), "content-type": "application/json" },
      body: new TextEncoder().encode(
        JSON.stringify(threadId === undefined ? { raw } : { raw, threadId }),
      ),
      auth: input.request.auth,
    };
    return {
      ok: true,
      request: fixed,
      summary: gmailSummary(input, Buffer.from(raw, "base64"), "draft", draftId),
    };
  }

  const raw = body?.raw;
  if (typeof raw !== "string" || raw === "") {
    return {
      ok: true,
      request: input.request,
      summary: defaultSummary(input, [
        'メールとして読めませんでした（本文が {"raw": "..."} の JSON ではありません）。元のリクエストで中身を確かめてください',
      ]),
    };
  }
  return {
    ok: true,
    request: input.request,
    summary: gmailSummary(input, Buffer.from(raw, "base64"), "message", null),
  };
}

function gmailSummary(
  input: PrepareHoldInput,
  mailBytes: Uint8Array,
  source: GmailSummary["source"],
  draftId: string | null,
): GmailSummary {
  const mail = parseMail(mailBytes);
  const text = headChars(mail.text?.body ?? "", MAIL_BODY_CHARS);
  return {
    kind: "gmail_message",
    operation: input.operation.id,
    member_id: input.memberId,
    source,
    draft_id: draftId,
    from: mail.from,
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
    subject: mail.subject,
    body_kind: mail.text?.kind ?? null,
    body_text: text.text,
    body_truncated: text.truncated,
    attachments: mail.attachments,
    warnings: mail.warnings,
  };
}

/** 本文を作り直すときに、前の本文のためのヘッダーを外す */
function withoutBodyHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name === "content-length" || name === "content-type" || name === "content-encoding") {
      continue;
    }
    out[name] = value;
  }
  return out;
}

// ---- github_pr_merge ----

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

async function prepareGithubMerge(input: PrepareHoldInput): Promise<PreparedHold> {
  const url = new URL(input.request.url);
  const repo = input.params.repo;
  const m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d{1,10})\/merge$/.exec(url.pathname);
  if (repo === undefined || m === null || m[1] !== repo) {
    return { ok: false, message: "マージする PR の番号が分かりません" };
  }
  const number = Number(m[2]);
  const text = new TextDecoder().decode(input.request.body);
  const body = text.trim() === "" ? {} : parseJsonObject(input.request.body);
  if (body === null)
    return { ok: false, message: "マージの本文が JSON のオブジェクトではありません" };

  const name = repo.split("/")[1] as string;
  const got = await getJson(input, `${url.origin}/repos/${repo}/pulls/${number}`, {
    permissions: { pull_requests: "read", metadata: "read" },
    repositories: [name],
  });
  if (!got.ok) return { ok: false, message: `PR を取れませんでした（${got.message}）` };
  const pr = got.value;
  const head = pr.head as Record<string, unknown> | undefined;
  const base = pr.base as Record<string, unknown> | undefined;
  const headSha = head?.sha;
  if (
    typeof pr.title !== "string" ||
    typeof pr.changed_files !== "number" ||
    typeof headSha !== "string" ||
    !SHA.test(headSha)
  ) {
    return { ok: false, message: "PR の応答の形が違います" };
  }

  const warnings: string[] = [];
  let fixedBody = body;
  if (body.sha === undefined) {
    fixedBody = { ...body, sha: headSha };
  } else if (body.sha !== headSha) {
    warnings.push(
      `本文の sha（${String(body.sha)}）が、いまの PR の head（${headSha}）と違います。GitHub は、head がこの sha と同じときだけマージします`,
    );
  }
  const request: SavedHoldRequest = {
    ...input.request,
    headers: { ...withoutBodyHeaders(input.request.headers), "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify(fixedBody)),
  };
  return {
    ok: true,
    request,
    summary: {
      kind: "github_pr_merge",
      operation: input.operation.id,
      member_id: input.memberId,
      repo,
      number,
      title: pr.title,
      changed_files: pr.changed_files,
      head_sha: typeof fixedBody.sha === "string" ? fixedBody.sha : headSha,
      head_ref: typeof head?.ref === "string" ? head.ref : null,
      base_ref: typeof base?.ref === "string" ? base.ref : null,
      merge_method: typeof body.merge_method === "string" ? body.merge_method : null,
      warnings,
    },
  };
}
