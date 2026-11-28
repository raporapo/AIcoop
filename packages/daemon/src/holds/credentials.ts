/**
 * 保留の要約・再送のために、制御サーバーがその場で本物の資格を発行する（5.2.6 の2、5.7.1 の2）。
 *
 * 実行のときのトークンは1時間で切れている（5.2.8）ので、使うたびに `secrets/issue.ts` で発行し直す。
 * 範囲は、その保留の操作とパラメーターの値だけに絞る（GitHub App ならリポジトリと権限を絞る）。
 * 発行した値は、ログ・エラー・監査ログに出さない（11.5）。
 */
import type { CompanyConfig, EffectivePermission } from "@aicoop/shared";
import { CredentialError, type PrepareSecretsInput, prepareBoxSecrets } from "../secrets/issue.ts";

export type IssuedCredential =
  /** credential が null なら、そのサービスは資格を使わない */
  | {
      readonly ok: true;
      readonly credential: { readonly header: string; readonly value: string } | null;
    }
  | { readonly ok: false; readonly message: string };

export interface IssueForOperationInput {
  readonly config: CompanyConfig;
  /** `<service>.<operation>` */
  readonly operationId: string;
  /** パラメーターの値（例：`{ repo: "myorg/app" }`） */
  readonly params: Readonly<Record<string, string>>;
  readonly secretsPath: string;
  readonly fetch: typeof fetch;
  readonly now: Date;
  readonly timeoutMs?: number;
  readonly githubScope?: PrepareSecretsInput["githubScope"];
}

export async function issueForOperation(input: IssueForOperationInput): Promise<IssuedCredential> {
  const op = input.config.catalog.getOperation(input.operationId);
  if (op === undefined) {
    return { ok: false, message: `操作 ${input.operationId} がサービス定義にありません` };
  }
  const service = input.config.services.find((s) => s.id === op.service);
  if (service === undefined) {
    return { ok: false, message: `サービス ${op.service} がありません` };
  }
  if (service.secret === null) return { ok: true, credential: null };

  const effective: EffectivePermission[] = [
    {
      op: op.id,
      mode: "allow",
      params: Object.fromEntries(Object.entries(input.params).map(([k, v]) => [k, [[v]]])),
      source: { kind: "role" },
    },
  ];
  try {
    const prepared = await prepareBoxSecrets({
      config: input.config,
      effective,
      secretsPath: input.secretsPath,
      fetch: input.fetch,
      now: input.now,
      ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
      ...(input.githubScope !== undefined && { githubScope: input.githubScope }),
    });
    const secret = prepared.secrets[0];
    if (secret === undefined) {
      return {
        ok: false,
        message: `資格 ${service.id} が登録されていません（aicoop secret set ${service.id}）`,
      };
    }
    return { ok: true, credential: { header: service.secret.header, value: secret.value } };
  } catch (error) {
    if (error instanceof CredentialError) return { ok: false, message: error.message };
    throw error;
  }
}
