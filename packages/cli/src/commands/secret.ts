/**
 * `aicoop secret set|list|rm`（9.1、5.2.8）。
 *
 * 守ること：
 * - 資格の中身を、画面・エラー・ログに出さない（11.5）。JSON.parse の誤りの文は入力の一部を含むので使わない
 * - 標準入力を読む前に、ID と種類を確かめる（貼り付けたあとで弾かない）
 * - 登録・削除のたびに、監査ログに `secret.change` を書く（5.10）。actor は `owner:cli`
 *   （CLI はオーナー本人がホストで打つもの。端末の ID はないので `cli` とする）
 */
import {
  aicoopPaths,
  appendAudit,
  listSecrets,
  openStateDb,
  removeSecret,
  SecretStoreError,
  setSecret,
} from "@aicoop/daemon";
import { ID_PATTERN, type SecretKind, secretKindSchema } from "@aicoop/shared";
import type { CommandInput } from "../command.ts";
import { CliError, UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { readTimezone, requireInitialized } from "../home.ts";
import { readAll, readHidden, readLine } from "../stdin.ts";
import { suggest } from "../suggest.ts";
import { renderTable } from "../ui/table.ts";
import { formatTime } from "../ui/time.ts";

const KINDS = secretKindSchema.options as readonly SecretKind[];
/** 資格の入力の上限（GitHub App の秘密鍵でも 4 KiB ほど） */
const MAX_INPUT_BYTES = 64 * 1024;

const SHAPES: Readonly<Record<SecretKind, string>> = {
  static_token: '{"token": "..."}、またはトークンだけ',
  anthropic_oauth: '{"token": "..."}、またはトークンだけ（claude setup-token で作ったもの）',
  github_app: '{"app_id": 123, "installation_id": 456, "private_key": "-----BEGIN ..."}',
  google_oauth: '{"client_id": "...", "client_secret": "...", "refresh_token": "..."}',
};

function checkId(value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new UsageError(`資格の ID として使えません：${JSON.stringify(value.slice(0, 40))}`, [
      "英小文字・数字・ハイフンで1〜40文字にしてください（例：anthropic、github）",
    ]);
  }
  return value;
}

function checkKind(value: string): SecretKind {
  const parsed = secretKindSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const close = suggest(value.replaceAll("-", "_"), KINDS);
  throw new UsageError(`知らない資格の種類です：${value.slice(0, 40)}`, [
    ...(close.length > 0 ? [`もしかして --kind ${close.join("、")}`] : []),
    `種類：${KINDS.join("・")}`,
  ]);
}

/** 入力を、種類の形にする。誤りの文には、中身を一切入れない */
function parseInput(kind: SecretKind, raw: string): unknown {
  const text = raw.replace(/^\ufeff/, "").trim();
  if (text === "") {
    throw new UsageError("資格を受け取りませんでした（入力が空です）", [
      `標準入力から渡してください：aicoop secret set <id> --kind ${kind} < 資格のファイル`,
      `形：${SHAPES[kind]}`,
    ]);
  }
  const tokenOnly = kind === "static_token" || kind === "anthropic_oauth";
  if (tokenOnly && !/^[{["]/.test(text)) {
    if (/\s/.test(text)) {
      throw new UsageError("トークンに空白や改行が入っています（中身は表示しません）", [
        `トークンだけを1行で貼り付けるか、${SHAPES[kind]} の JSON で渡してください`,
      ]);
    }
    if (!/^[\x21-\x7e]+$/.test(text)) {
      throw new UsageError(
        "トークンに使えない文字（全角の文字など）が入っています（中身は表示しません）",
        ["コピーしたトークンを、そのまま貼り付けてください"],
      );
    }
    return { token: text };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError("JSON として読めません（中身は表示しません）", [`形：${SHAPES[kind]}`]);
  }
  rejectUnknownKeys(kind, value);
  return value;
}

/** 種類ごとの、使えるキー（5.2.8 の4の表） */
const KEYS: Readonly<Record<SecretKind, readonly string[]>> = {
  static_token: ["token"],
  anthropic_oauth: ["token"],
  github_app: ["app_id", "installation_id", "private_key"],
  google_oauth: ["client_id", "client_secret", "refresh_token"],
};

/**
 * 知らないキーは、名前も出さずに止める。キーの位置にトークンを貼ってしまうことがあり
 * （例：{"ghp_...": ""}）、キーの名前もそのまま出すと漏れるため。
 */
function rejectUnknownKeys(kind: SecretKind, value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const allowed = KEYS[kind];
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length === 0) return;
  throw new UsageError(`知らないキーが ${unknown.length}個 あります（キーの名前も表示しません）`, [
    `${kind} で使えるキー：${allowed.join("・")}`,
    `形：${SHAPES[kind]}`,
  ]);
}

function auditSecretChange(home: string, id: string, change: "set" | "rm"): void {
  const db = openStateDb(aicoopPaths(home).stateDb);
  try {
    appendAudit(db, {
      actor: "owner:cli",
      kind: "secret.change",
      subject: id,
      data: { secret_id: id, change },
    });
  } finally {
    db.close();
  }
}

function safeList(path: string) {
  try {
    return listSecrets(path);
  } catch (e) {
    throw new CliError(
      EXIT.failure,
      e instanceof SecretStoreError ? e.message : "secrets.json を読めません（中身は表示しません）",
    );
  }
}

export async function runSet(input: CommandInput): Promise<number> {
  const { home, positionals, values, out, err, ctx } = input;
  const id = checkId(positionals[0] ?? "");
  const kind = checkKind(String(values.kind ?? ""));
  requireInitialized(home);
  const paths = aicoopPaths(home);
  const before = safeList(paths.secrets).find((s) => s.id === id);

  let raw: string;
  if (ctx.stdin.isTTY) {
    err.line(
      `資格 ${id}（${kind}）を貼り付けて、Enter を押してください。打った文字は画面に出ません。`,
    );
    err.line(err.style.dim(`  形：${SHAPES[kind]}`));
    err.line(err.style.dim("  取りやめるときは Ctrl+C"));
    err.write("> ");
    raw = await readHidden(ctx.stdin, ctx.stderr, MAX_INPUT_BYTES);
  } else {
    raw = (await readAll(ctx.stdin, MAX_INPUT_BYTES)).toString("utf8");
  }

  const value = parseInput(kind, raw);
  try {
    setSecret(paths.secrets, id, kind, value, ctx.deps.now());
  } catch (e) {
    if (e instanceof SecretStoreError) throw new UsageError(e.message);
    throw new CliError(EXIT.failure, "secrets.json に保存できませんでした（中身は表示しません）", [
      `${paths.secrets} の置き場所と権限を確かめてください`,
    ]);
  }
  try {
    auditSecretChange(home, id, "set");
  } catch {
    throw new CliError(
      EXIT.failure,
      "資格は保存しましたが、監査ログ（state.db）に書けませんでした",
      ["aicoop audit verify で監査ログを確かめてください"],
    );
  }

  const style = out.style;
  out.line(`${style.green("✓")} 資格 ${id}（${kind}）を${before ? "更新" : "登録"}しました`);
  if (before && before.kind !== kind)
    out.line(`    種類を ${before.kind} から ${kind} に変えました`);
  out.line(style.dim("    中身は画面に出していません。監査ログに記録しました（secret.change）"));
  return EXIT.ok;
}

export async function runList(input: CommandInput): Promise<number> {
  const { home, values, out } = input;
  requireInitialized(home);
  const entries = safeList(aicoopPaths(home).secrets);
  if (values.json === true) {
    out.line(
      JSON.stringify(
        entries.map((e) => ({ id: e.id, kind: e.kind, updated_at: e.updatedAt })),
        null,
        2,
      ),
    );
    return EXIT.ok;
  }
  if (entries.length === 0) {
    out.line("資格はまだ登録されていません。");
    out.line("  Claude のトークン：aicoop secret set anthropic --kind anthropic_oauth");
    out.line("  使うサービスの資格は、aicoop check で確かめられます");
    return EXIT.ok;
  }
  const tz = await readTimezone(home);
  out.lines(
    renderTable(
      [{ header: "ID" }, { header: "種類" }, { header: `更新（${tz}）` }],
      entries.map((e) => [e.id, e.kind, formatTime(e.updatedAt, tz)]),
      { style: out.style, width: out.columns },
    ),
  );
  return EXIT.ok;
}

export async function runRm(input: CommandInput): Promise<number> {
  const { home, positionals, values, out, err, ctx } = input;
  const id = checkId(positionals[0] ?? "");
  requireInitialized(home);
  const paths = aicoopPaths(home);
  const entries = safeList(paths.secrets);
  const entry = entries.find((e) => e.id === id);
  if (!entry) {
    const close = suggest(
      id,
      entries.map((e) => e.id),
    );
    throw new CliError(EXIT.failure, `資格 ${id} は登録されていません`, [
      ...(close.length > 0 ? [`もしかして ${close.join("、")}`] : []),
      "登録されている資格：aicoop secret list",
    ]);
  }

  if (values.yes !== true) {
    if (!ctx.stdin.isTTY) {
      throw new UsageError("確かめられないので、消していません", [
        `消すなら --yes を付けてください：aicoop secret rm ${id} --yes`,
      ]);
    }
    err.write(`資格 ${id}（${entry.kind}）を消します。よろしいですか？ [y/N] `);
    const answer = (await readLine(ctx.stdin)).trim().toLowerCase();
    if (!["y", "yes", "はい"].includes(answer)) {
      err.line("取りやめました（何も消していません）");
      return EXIT.failure;
    }
  }

  try {
    removeSecret(paths.secrets, id);
  } catch (e) {
    throw new CliError(
      EXIT.failure,
      e instanceof SecretStoreError ? e.message : "secrets.json を書き換えられませんでした",
    );
  }
  try {
    auditSecretChange(home, id, "rm");
  } catch {
    throw new CliError(EXIT.failure, "資格は消しましたが、監査ログ（state.db）に書けませんでした", [
      "aicoop audit verify で監査ログを確かめてください",
    ]);
  }
  out.line(`${out.style.green("✓")} 資格 ${id}（${entry.kind}）を消しました`);
  out.line(out.style.dim("    動いている実行には、すでに渡したトークンが残ります（最長1時間）"));
  if (entry.kind === "anthropic_oauth") {
    out.line(
      out.style.dim(
        "    トークンそのものを無効にするには、Anthropic のアカウント設定で取り消してください",
      ),
    );
  }
  return EXIT.ok;
}
