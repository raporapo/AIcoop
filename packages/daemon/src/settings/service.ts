/**
 * 設定の画面と資格の画面（5.14 の4・5、T-15、D-27・D-28）の中身。道（`api/routes/settings.ts`）と、
 * 承認の署名（`approvals/`）の対象 `config_change`・`secret_change` を受け持つ。
 *
 * 流れ：
 * 1. 変更を作る（`proposeConfigChange`・`proposeSecretChange`）。設定は、変えたファイルを重ねた全体を 6.10 のとおり
 *    検証し（本物のファイルは書かない）、エラーなら 422 `config_invalid`。通れば、署名を待つ変更をメモリに置く
 *    （10分で失効、同時に `MAX_PENDING_CHANGES` まで）。資格の値は、このメモリの中にだけ持つ
 * 2. 承認アプリが `POST /approvals/intent`（`type: "config_change" | "secret_change"`）→ パスキーで署名 →
 *    `POST /approvals/assert`。署名の確かめは approvals/sign.ts（期限・nonce・チャレンジ・要約のハッシュ）
 * 3. 署名が通ったら `apply`（`approvals` の記録と同じトランザクションの中）：
 *    - 設定：ファイルが変更を作ったときのまま（base_sha256）か確かめ（違えば 409 `conflict`、書かない）、
 *      もう一度検証し（422）、原子的に書き、読み直す（`aicoop reload` と同じ）。読み直しに失敗したら元に戻す（422）。
 *      監査ログ `config.change`（パスと前後の SHA-256。中身は書かない）
 *    - 資格：資格が変更を作ったときのままか確かめ（409）、`secrets.json` に書き、監査ログ `secret.change`
 *    - `reject` は変更の取り消し（何も書かない）
 *
 * 準備の画面（5.14 の3。Claude へのログイン・GitHub の登録）も、`proposeSecretChange`・`proposeConfigChange` で
 * 変更を作り、同じ署名を通す。
 */
import { createHash } from "node:crypto";
import {
  type AuditActor,
  type ConfigIssue,
  type ConfigResult,
  canonicalJson,
  ID_PATTERN,
  newId,
  type SecretKind,
  secretKindSchema,
} from "@aicoop/shared";
import {
  type ConfigChangeSummary,
  type CreateConfigChangeResponse,
  type CreateSecretChangeResponse,
  type GetConfigFileResponse,
  type ListConfigFilesResponse,
  type ListSecretsResponse,
  MAX_CONFIG_CHANGE_FILES,
  MAX_CONFIG_FILE_BYTES,
  SETTINGS_CHANGE_TTL_MS,
  type SecretChangeSummary,
} from "@aicoop/shared/api";
import type { Logger } from "pino";
import { isRecord } from "../approvals/context.ts";
import { ApprovalFailure, invalidInput } from "../approvals/errors.ts";
import type { ApprovalSubject, ApprovalTarget, ApprovalTargets } from "../approvals/types.ts";
import { appendAudit } from "../db/audit.ts";
import type { StateDb } from "../db/open.ts";
import {
  listSecrets,
  readSecret,
  removeSecret,
  SecretStoreError,
  type SecretValue,
  setSecret,
} from "../secrets/store.ts";
import { unifiedDiff } from "./diff.ts";
import {
  ConfigFileError,
  isConfigFilePath,
  listConfigFiles,
  readConfigFile,
  writeConfigFiles,
} from "./files.ts";
import { parseSecretInput } from "./secret-input.ts";

/** 同時に置ける、署名を待つ変更の数（設定・資格を合わせて） */
export const MAX_PENDING_CHANGES = 16;
/** 期限を過ぎた変更も、しばらく覚えておく（「もう待っていない」と正しく答えるため） */
const KEEP_EXPIRED_MS = 10 * 60 * 1000;

export type ReloadOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export interface SettingsDeps {
  /** `~/.aicoop` */
  readonly home: string;
  /** `~/.aicoop/secrets.json` */
  readonly secretsPath: string;
  readonly db: StateDb;
  readonly logger: Logger;
  readonly now: () => Date;
  /** 変えたファイルを重ねた設定の全体を、daemon の起動・読み直しと同じ条件で検証する（6.10） */
  validate(overrides: ReadonlyMap<string, string>): ConfigResult;
  /** 書いたあとに読み直す（`aicoop reload` と同じ。actor は監査ログ `config.load` の者） */
  reload(actor: AuditActor): ReloadOutcome;
}

export interface ConfigChangeInput {
  readonly path: string;
  readonly content: string;
  readonly base_sha256: string | null;
}

export type SecretChangeInput =
  | { readonly id: string; readonly kind: SecretKind; readonly value: unknown }
  | { readonly id: string; readonly delete: true };

export interface Settings {
  listFiles(): ListConfigFilesResponse;
  readFile(path: string): GetConfigFileResponse;
  /** 本文（`POST /config/changes`）を確かめてから proposeConfigChange */
  createConfigChange(body: unknown): CreateConfigChangeResponse;
  /** 設定の変更を作る（署名を待つ）。準備の画面からも使う */
  proposeConfigChange(files: readonly ConfigChangeInput[]): CreateConfigChangeResponse;
  listSecrets(): ListSecretsResponse;
  /** 本文（`POST /secrets/changes`）を確かめてから proposeSecretChange */
  createSecretChange(body: unknown): CreateSecretChangeResponse;
  /** 資格の変更を作る（署名を待つ）。準備の画面（Claude へのログイン・GitHub）からも使う */
  proposeSecretChange(input: SecretChangeInput): CreateSecretChangeResponse;
  /** 承認の対象（`config_change`・`secret_change`） */
  targets(): ApprovalTargets;
}

interface PendingConfig {
  readonly kind: "config";
  readonly id: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly base: string | null;
  }>;
  readonly summary: ConfigChangeSummary;
  readonly expiresAt: number;
}

interface PendingSecret {
  readonly kind: "secret";
  readonly id: string;
  readonly secretId: string;
  readonly secretKind: SecretKind;
  /** 登録・置き換えの値（削除なら undefined）。このメモリの中にだけ持つ */
  readonly value: SecretValue | undefined;
  /** 変更を作ったときの資格のハッシュ（なければ null）。署名のあとに、変わっていないことを確かめる */
  readonly base: string | null;
  readonly summary: SecretChangeSummary;
  readonly expiresAt: number;
}

type Pending = PendingConfig | PendingSecret;

const HEX64 = /^[0-9a-f]{64}$/;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const conflict = (message: string) => new ApprovalFailure(409, "conflict", message);

const FILE_NOT_FOUND =
  "そのファイルはありません（設定の画面で扱えるのは、6.1 の yaml・services/*.yaml・prompts/ の md だけです）";

/** パスの誤り（POST の本文のとき） */
function fileFailure(error: ConfigFileError, path: string): ApprovalFailure {
  switch (error.code) {
    case "too_large":
      return new ApprovalFailure(413, "invalid_input", error.message);
    case "not_text":
      return invalidInput(error.message);
    case "not_found":
      return new ApprovalFailure(404, "not_found", error.message);
    default:
      return invalidInput(
        isConfigFilePath(path)
          ? error.message
          : "設定の画面で扱えないファイルです（6.1 の yaml・services/*.yaml・prompts/ の md だけ。secrets.json・state.db・.. を含むパスは扱えません）",
      );
  }
}

/** キーが `allowed` だけか（キーの名前は出さない。資格をキーの位置に貼ることがあるため） */
function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw invalidInput(
      `知らないキーが ${extra.length}個 あります（名前は表示しません）。書けるのは ${allowed.join("・")} です`,
    );
  }
}

/** 資格の1件のハッシュ（種類・中身・更新日時）。メモリの中で比べるだけで、外には出さない */
function secretFingerprint(path: string, id: string): string | null {
  const entry = readSecret(path, id);
  return entry === undefined
    ? null
    : sha256(canonicalJson({ kind: entry.kind, value: entry.value, updated_at: entry.updatedAt }));
}

export function createSettings(deps: SettingsDeps): Settings {
  const { home, secretsPath, db, logger, now } = deps;
  const pending = new Map<string, Pending>();

  const prune = () => {
    const t = now().getTime();
    for (const [id, p] of pending) if (p.expiresAt + KEEP_EXPIRED_MS < t) pending.delete(id);
  };

  const reserve = (): { id: string; expiresAt: number } => {
    prune();
    const t = now().getTime();
    const live = [...pending.values()].filter((p) => p.expiresAt > t).length;
    if (live >= MAX_PENDING_CHANGES) {
      throw new ApprovalFailure(
        409,
        "invalid_state",
        `署名を待つ変更が多すぎます（${MAX_PENDING_CHANGES}件まで）。保存するか取り消してから、もう一度作ってください（作ってから10分で消えます）`,
      );
    }
    // 期限を過ぎたものは、上限に数えない（覚えている数は増えすぎないよう、古いものから捨てる）
    while (pending.size >= MAX_PENDING_CHANGES * 2) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    return { id: newId("change", t), expiresAt: t + SETTINGS_CHANGE_TTL_MS };
  };

  const secretsList = () => {
    try {
      return listSecrets(secretsPath);
    } catch (e) {
      throw new ApprovalFailure(
        500,
        "internal",
        e instanceof SecretStoreError
          ? e.message
          : "secrets.json を読めません（中身は表示しません）",
      );
    }
  };

  const awaiting = (p: Pending | undefined): p is Pending =>
    p !== undefined && now().getTime() <= p.expiresAt;

  const describe = (kind: Pending["kind"], id: string): ApprovalSubject | undefined => {
    const p = pending.get(id);
    if (p === undefined || p.kind !== kind) return undefined;
    return {
      type: kind === "config" ? "config_change" : "secret_change",
      id,
      status: awaiting(p) ? "pending" : "expired",
      awaitingOwner: awaiting(p),
      summary: p.summary,
    };
  };

  const take = <K extends Pending["kind"]>(kind: K, id: string): Extract<Pending, { kind: K }> => {
    const p = pending.get(id);
    if (p === undefined || p.kind !== kind || !awaiting(p)) {
      throw new Error(`変更 ${id} は、署名を待っていません`);
    }
    return p as Extract<Pending, { kind: K }>;
  };

  const applyConfig = (p: PendingConfig, by: `owner:${string}`): { status: string } => {
    // 1. 変更を作ったときのままか（5.14 の4の4）
    for (const f of p.files) {
      let current: string | null;
      try {
        const got = readConfigFile(home, f.path);
        current = got.sha256;
      } catch (e) {
        if (!(e instanceof ConfigFileError) || e.code !== "not_found") {
          pending.delete(p.id);
          throw conflict(
            `${f.path} を確かめられないので、書きませんでした（${e instanceof Error ? e.message : "読めません"}）`,
          );
        }
        current = null;
      }
      if (current !== f.base) {
        pending.delete(p.id);
        throw conflict(
          `変更を作ったあとで ${f.path} が書き換えられたので、書きませんでした（あとから来た変更を消さないため）。読み直してから、もう一度変更を作ってください`,
        );
      }
    }
    // 2. いまの設定に重ねて、もう一度検証する（変更に入っていないファイルが変わっていることがある）
    const overrides = new Map(p.files.map((f) => [f.path, f.content]));
    const checked = deps.validate(overrides);
    if (!checked.ok) {
      pending.delete(p.id);
      throw new ApprovalFailure(
        422,
        "config_invalid",
        `設定にエラーがあるので、保存しませんでした（${checked.issues.length}件）`,
        checked.issues,
      );
    }
    // 3. 書いて、読み直す。読み直せなければ元に戻す
    let written: ReturnType<typeof writeConfigFiles>;
    try {
      written = writeConfigFiles(
        home,
        p.files.map((f) => ({ path: f.path, content: f.content })),
      );
    } catch (e) {
      pending.delete(p.id);
      logger.error(
        { err: e, change_id: p.id },
        "設定のファイルを書けませんでした（元に戻しました）",
      );
      throw new ApprovalFailure(
        500,
        "internal",
        "設定のファイルを書けませんでした。書きかけのものは元に戻しました。daemon のログを見てください",
      );
    }
    const reloaded = deps.reload(by);
    if (!reloaded.ok) {
      const { failed } = written.restore();
      pending.delete(p.id);
      if (failed.length > 0) {
        logger.error(
          { change_id: p.id, paths: failed },
          "読み直しに失敗したあと、元に戻せなかったファイルがあります",
        );
      }
      throw new ApprovalFailure(
        422,
        "config_invalid",
        failed.length === 0
          ? `書いた設定を読み直せなかったので、元に戻しました（${reloaded.issues.length}件。前の設定のまま動いています）`
          : `書いた設定を読み直せず、元に戻せなかったファイルがあります：${failed.join("、")}（前の設定のまま動いています。aicoop check で確かめてください）`,
        reloaded.issues,
      );
    }
    appendAudit(db, {
      actor: by,
      kind: "config.change",
      subject: p.id,
      data: {
        change: p.id,
        files: p.summary.files.map((f) => ({
          path: f.path,
          before_sha256: f.before_sha256,
          after_sha256: f.after_sha256,
        })),
      },
    });
    pending.delete(p.id);
    logger.info(
      { change_id: p.id, paths: p.files.map((f) => f.path), by },
      "設定の画面の変更を、署名を確かめて保存し、読み直しました",
    );
    return { status: "applied" };
  };

  const applySecret = (p: PendingSecret, by: `owner:${string}`): { status: string } => {
    if (secretFingerprint(secretsPath, p.secretId) !== p.base) {
      pending.delete(p.id);
      throw conflict(
        `変更を作ったあとで資格 ${p.secretId} が変えられたので、書きませんでした。一覧を読み直してから、もう一度やり直してください`,
      );
    }
    try {
      if (p.value === undefined) removeSecret(secretsPath, p.secretId);
      else setSecret(secretsPath, p.secretId, p.secretKind, p.value, now());
    } catch (e) {
      pending.delete(p.id);
      throw new ApprovalFailure(
        500,
        "internal",
        e instanceof SecretStoreError
          ? e.message
          : "secrets.json に書けませんでした（中身は表示しません）",
      );
    }
    appendAudit(db, {
      actor: by,
      kind: "secret.change",
      subject: p.secretId,
      data: { secret_id: p.secretId, change: p.value === undefined ? "rm" : "set" },
    });
    pending.delete(p.id);
    logger.info(
      { change_id: p.id, secret_id: p.secretId, action: p.summary.action, by },
      "資格の画面の変更を、署名を確かめて保存しました",
    );
    return { status: "applied" };
  };

  const configTarget: ApprovalTarget = {
    type: "config_change",
    describe: (id) => describe("config", id),
    apply(id, decision, by) {
      const p = take("config", id);
      if (decision === "reject") {
        pending.delete(id);
        logger.info({ change_id: id, by }, "設定の画面の変更を取り消しました");
        return { status: "cancelled" };
      }
      return applyConfig(p, by);
    },
  };

  const secretTarget: ApprovalTarget = {
    type: "secret_change",
    describe: (id) => describe("secret", id),
    apply(id, decision, by) {
      const p = take("secret", id);
      if (decision === "reject") {
        pending.delete(id);
        logger.info({ change_id: id, by }, "資格の画面の変更を取り消しました");
        return { status: "cancelled" };
      }
      return applySecret(p, by);
    },
  };

  const settings: Settings = {
    listFiles: () => ({ files: listConfigFiles(home) }),

    readFile(path) {
      try {
        return readConfigFile(home, path);
      } catch (e) {
        if (!(e instanceof ConfigFileError)) throw e;
        if (e.code === "too_large") throw new ApprovalFailure(413, "invalid_input", e.message);
        if (e.code === "not_text") throw invalidInput(e.message);
        throw new ApprovalFailure(404, "not_found", FILE_NOT_FOUND);
      }
    },

    createConfigChange(body) {
      if (!isRecord(body)) throw invalidInput("本文は JSON のオブジェクトにしてください");
      onlyKeys(body, ["files"]);
      const files = body.files;
      if (!Array.isArray(files) || files.length === 0) {
        throw invalidInput("files（変えるファイルの配列）を1つ以上書いてください");
      }
      if (files.length > MAX_CONFIG_CHANGE_FILES) {
        throw invalidInput(`1回に変えられるファイルは ${MAX_CONFIG_CHANGE_FILES} 個までです`);
      }
      const inputs = files.map((f, i): ConfigChangeInput => {
        if (!isRecord(f)) throw invalidInput(`files[${i}] は JSON のオブジェクトにしてください`);
        onlyKeys(f, ["path", "content", "base_sha256"]);
        if (typeof f.path !== "string" || !isConfigFilePath(f.path)) {
          throw invalidInput(
            `files[${i}].path は、設定の画面で扱えるファイルではありません（6.1 の yaml・services/*.yaml・prompts/ の md だけ。secrets.json・state.db・.. を含むパスは扱えません）`,
          );
        }
        if (typeof f.content !== "string") {
          throw invalidInput(`files[${i}].content（新しい中身）を文字列で書いてください`);
        }
        if (
          f.base_sha256 !== null &&
          (typeof f.base_sha256 !== "string" || !HEX64.test(f.base_sha256))
        ) {
          throw invalidInput(
            `files[${i}].base_sha256 は、もとにした中身の SHA-256（16進の小文字64文字）か、新しいファイルなら null にしてください`,
          );
        }
        return { path: f.path, content: f.content, base_sha256: f.base_sha256 };
      });
      return settings.proposeConfigChange(inputs);
    },

    proposeConfigChange(inputs) {
      const seen = new Set<string>();
      const files: Array<PendingConfig["files"][number] & { before: string | null }> = [];
      for (const f of inputs) {
        if (!isConfigFilePath(f.path))
          throw fileFailure(new ConfigFileError("not_allowed", ""), f.path);
        if (seen.has(f.path)) throw invalidInput(`${f.path} が2回書かれています`);
        seen.add(f.path);
        if (Buffer.byteLength(f.content, "utf8") > MAX_CONFIG_FILE_BYTES) {
          throw new ApprovalFailure(
            413,
            "invalid_input",
            `${f.path} の新しい中身が大きすぎます（${MAX_CONFIG_FILE_BYTES / 1024} KiB まで）`,
          );
        }
        let before: string | null = null;
        let beforeSha: string | null = null;
        try {
          const got = readConfigFile(home, f.path);
          before = got.content;
          beforeSha = got.sha256;
        } catch (e) {
          if (!(e instanceof ConfigFileError)) throw e;
          if (e.code !== "not_found") throw fileFailure(e, f.path);
        }
        if (beforeSha !== f.base_sha256) {
          throw conflict(
            beforeSha === null
              ? `${f.path} はありません（新しいファイルなら base_sha256 を null にしてください）`
              : f.base_sha256 === null
                ? `${f.path} はもうあります。読み直してから、変更を作ってください`
                : `${f.path} は、読んだあとで書き換えられています。読み直してから、変更を作ってください`,
          );
        }
        if (before === f.content) throw invalidInput(`${f.path} は変わっていません`);
        files.push({ path: f.path, content: f.content, base: beforeSha, before });
      }
      if (files.length === 0) throw invalidInput("変えるファイルを1つ以上書いてください");

      const checked = deps.validate(new Map(files.map((f) => [f.path, f.content])));
      if (!checked.ok) {
        throw new ApprovalFailure(
          422,
          "config_invalid",
          `設定にエラーがあるので、保存できません（${checked.issues.length}件）`,
          checked.issues,
        );
      }
      const { id, expiresAt } = reserve();
      const summary: ConfigChangeSummary = {
        files: files.map((f) => ({
          path: f.path,
          before_sha256: f.base,
          after_sha256: sha256(f.content),
          diff: unifiedDiff(f.path, f.before, f.content),
        })),
      };
      pending.set(id, {
        kind: "config",
        id,
        files: files.map((f) => ({ path: f.path, content: f.content, base: f.base })),
        summary,
        expiresAt,
      });
      logger.info(
        { change_id: id, paths: files.map((f) => f.path) },
        "設定の画面の変更を作りました（署名を待っています）",
      );
      return {
        id,
        summary,
        warnings: checked.warnings,
        expires_at: new Date(expiresAt).toISOString(),
      };
    },

    listSecrets: () => ({
      secrets: secretsList().map((s) => ({ id: s.id, kind: s.kind, updated_at: s.updatedAt })),
    }),

    createSecretChange(body) {
      if (!isRecord(body)) throw invalidInput("本文は JSON のオブジェクトにしてください");
      if ("delete" in body) {
        onlyKeys(body, ["id", "delete"]);
        if (body.delete !== true) throw invalidInput("delete は true にしてください");
        if (typeof body.id !== "string") throw invalidInput("id（資格の ID）を書いてください");
        return settings.proposeSecretChange({ id: body.id, delete: true });
      }
      onlyKeys(body, ["id", "kind", "value"]);
      if (typeof body.id !== "string") throw invalidInput("id（資格の ID）を書いてください");
      const kind = secretKindSchema.safeParse(body.kind);
      if (!kind.success) {
        throw invalidInput(
          `kind（資格の種類）は ${secretKindSchema.options.join("・")} のどれかにしてください`,
        );
      }
      return settings.proposeSecretChange({ id: body.id, kind: kind.data, value: body.value });
    },

    proposeSecretChange(input) {
      if (!ID_PATTERN.test(input.id)) {
        throw invalidInput(
          "資格の ID は英小文字・数字・ハイフンで1〜40文字にしてください（例：github、anthropic）",
        );
      }
      const existing = secretsList().find((s) => s.id === input.id);
      const base = secretFingerprint(secretsPath, input.id);
      let summary: SecretChangeSummary;
      let value: SecretValue | undefined;
      let secretKind: SecretKind;
      if ("delete" in input) {
        if (existing === undefined) {
          throw new ApprovalFailure(404, "not_found", `資格 ${input.id} は登録されていません`);
        }
        secretKind = existing.kind;
        summary = { id: input.id, kind: existing.kind, action: "delete" };
      } else {
        try {
          value = parseSecretInput(input.kind, input.value);
        } catch (e) {
          throw invalidInput(
            e instanceof SecretStoreError ? e.message : "資格の形が違います（中身は表示しません）",
          );
        }
        secretKind = input.kind;
        summary = {
          id: input.id,
          kind: input.kind,
          action: existing === undefined ? "create" : "replace",
        };
      }
      const { id, expiresAt } = reserve();
      pending.set(id, {
        kind: "secret",
        id,
        secretId: input.id,
        secretKind,
        value,
        base,
        summary,
        expiresAt,
      });
      logger.info(
        { change_id: id, secret_id: input.id, action: summary.action },
        "資格の画面の変更を作りました（署名を待っています。中身はログに出しません）",
      );
      return { id, summary, expires_at: new Date(expiresAt).toISOString() };
    },

    targets: () => ({ config_change: configTarget, secret_change: secretTarget }),
  };
  return settings;
}
