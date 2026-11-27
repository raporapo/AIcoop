/**
 * トリガーの `thread`・`task` に書くテンプレート（`{{issue.number}}` など。5.5.2、6.6）。
 */
import type { GithubEvent } from "./schema.ts";

export interface TemplateVariable {
  readonly name: string;
  /** 外の人が書いた文章（6.6 の表の *）。プロンプトでは 5.4.3 の4のとおり囲む */
  readonly external: boolean;
}

const v = (name: string, external = false): TemplateVariable => ({ name, external });

const ISSUE = [
  v("issue.number"),
  v("issue.title", true),
  v("issue.body", true),
  v("issue.html_url"),
  v("repository.full_name"),
];
const PULL_REQUEST = [
  v("pull_request.number"),
  v("pull_request.title", true),
  v("pull_request.body", true),
  v("pull_request.html_url"),
  v("pull_request.head.ref"),
  v("repository.full_name"),
];

/** `github` トリガーで使えるテンプレート変数（6.6 の表）。これ以外は使えない */
export const GITHUB_TEMPLATE_VARIABLES: Readonly<Record<GithubEvent, readonly TemplateVariable[]>> =
  {
    "issues.opened": ISSUE,
    "issues.labeled": [...ISSUE, v("label.name")],
    "issue_comment.created": [
      v("issue.number"),
      v("issue.title", true),
      v("comment.body", true),
      v("comment.user.login"),
      v("repository.full_name"),
    ],
    "pull_request.opened": PULL_REQUEST,
    "pull_request.synchronize": PULL_REQUEST,
    push: [v("ref"), v("repository.full_name"), v("head_commit.message", true)],
  };

/**
 * 受けるイベントのすべてで使える変数（どのイベントで起きても値が決まるものだけ）。
 */
export function templateVariablesFor(
  events: readonly GithubEvent[],
): ReadonlyMap<string, TemplateVariable> {
  const [first, ...rest] = events;
  if (first === undefined) return new Map();
  const result = new Map(GITHUB_TEMPLATE_VARIABLES[first].map((t) => [t.name, t]));
  for (const event of rest) {
    const names = new Set(GITHUB_TEMPLATE_VARIABLES[event].map((t) => t.name));
    for (const name of result.keys()) if (!names.has(name)) result.delete(name);
  }
  return result;
}

const EXPRESSION = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * 文字列の中のテンプレートの変数名を取り出す。
 * `{{` と `}}` の組にならないもの（閉じていないなど）があれば `malformed: true`。
 */
export function parseTemplate(text: string): {
  readonly names: readonly string[];
  readonly malformed: boolean;
} {
  const names = [...text.matchAll(EXPRESSION)].map((m) => m[1] ?? "");
  const rest = text.replace(EXPRESSION, "");
  return { names, malformed: rest.includes("{{") || rest.includes("}}") };
}
