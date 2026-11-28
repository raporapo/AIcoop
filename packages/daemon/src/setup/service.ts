/**
 * 準備の画面（5.14 の3）の中身。道は `api/routes/setup.ts`。
 *
 * - `status`：準備の確認（`aicoop check` と同じ判定。`readiness.ts`）を、4つの段階
 *   （会社の名前 → Claude → GitHub → イメージ）に分けて返す
 * - 会社の名前・触ってよいリポジトリ：yaml の決まった値だけを書き換えた、設定の変更（署名を待つ。
 *   `Settings.proposeConfigChange`）を作る
 * - GitHub の資格：資格の画面と同じ `POST /secrets/changes` で登録する（ここには道を足さない）
 * - Claude へのログイン（`claude-login.ts`）・箱のイメージ（`image-build.ts`）
 */
import type { CompanyConfig } from "@aicoop/shared";
import {
  type CreateConfigChangeResponse,
  isRepositoryPattern,
  MAX_COMPANY_NAME_CHARS,
  MAX_SETUP_REPOSITORIES,
  PLACEHOLDER_GITHUB_OWNER,
  type SetupItem,
  type SetupResponse,
  type SetupStep,
  type SetupStepId,
} from "@aicoop/shared/api";
import { isRecord } from "../approvals/context.ts";
import { ApprovalFailure, invalidInput } from "../approvals/errors.ts";
import { listSecrets } from "../secrets/store.ts";
import type { Settings } from "../settings/service.ts";
import type { ClaudeLogin } from "./claude-login.ts";
import type { ImageBuilds } from "./image-build.ts";
import {
  checkHostReadiness,
  companyNameItem,
  placeholderLocations,
  type ReadinessHost,
} from "./readiness.ts";
import { replacePlaceholderRepositories, setCompanyName, YamlEditError } from "./yaml-edit.ts";

/** GitHub の資格の ID（サービス github と同じ） */
export const GITHUB_SECRET_ID = "github";

export interface SetupDeps {
  readonly home: string;
  readonly secretsPath: string;
  readonly host: ReadinessHost;
  readonly settings: Settings;
  config(): CompanyConfig;
  readonly login: ClaudeLogin;
  readonly images: ImageBuilds;
}

export interface Setup {
  status(): Promise<SetupResponse>;
  /** `POST /setup/company`：aicoop.yaml の company.name を書き換える変更 */
  proposeCompanyName(body: unknown): CreateConfigChangeResponse;
  /** `POST /setup/github/repositories`：groups.yaml の your-org を書き換える変更 */
  proposeRepositories(body: unknown): CreateConfigChangeResponse;
  readonly login: ClaudeLogin;
  readonly images: ImageBuilds;
}

const BAD_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function stepOf(id: string): SetupStepId | null {
  if (id === "company:name") return "company";
  if (id === "secret:anthropic") return "claude";
  if (id === `secret:${GITHUB_SECRET_ID}` || id === "placeholder:your-org") return "github";
  if (id.startsWith("image:") || id.startsWith("os:")) return "image";
  return null;
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    throw invalidInput(
      `知らないキーが ${extra.length}個 あります（名前は表示しません）。書けるのは ${allowed.join("・")} です`,
    );
  }
}

/** groups.yaml の部署の上限に書いた、GitHub の操作のリポジトリ（your-org を除く） */
function repositoriesIn(config: CompanyConfig): string[] {
  const found = new Set<string>();
  for (const group of Object.values(config.groups)) {
    for (const item of group.ceiling) {
      if (!item.op.startsWith("github.")) continue;
      for (const repo of item.params?.repo ?? []) {
        if (!repo.includes(PLACEHOLDER_GITHUB_OWNER)) found.add(repo);
      }
    }
  }
  return [...found].sort();
}

const editFailure = (e: unknown) =>
  e instanceof YamlEditError ? new ApprovalFailure(409, "invalid_state", e.message) : e;

export function createSetup(deps: SetupDeps): Setup {
  const { settings } = deps;

  return {
    login: deps.login,
    images: deps.images,

    async status() {
      const config = deps.config();
      const items: SetupItem[] = [
        companyNameItem(config.aicoop.company.name),
        ...(await checkHostReadiness(deps.host, deps.home, config, { acceptStaticToken: true })),
      ];
      const steps: SetupStep[] = (["company", "claude", "github", "image"] as const).map((id) => {
        const mine = items.filter((i) => stepOf(i.id) === id);
        return { id, ok: mine.every((i) => i.ok), items: mine };
      });
      let secretKind: SetupResponse["github"]["secret_kind"] = null;
      try {
        secretKind =
          listSecrets(deps.secretsPath).find((s) => s.id === GITHUB_SECRET_ID)?.kind ?? null;
      } catch {
        // 読めないことは、準備の確認の項目（secret:github）が知らせる
      }
      return {
        ready: steps.every((s) => s.ok),
        steps,
        others: items.filter((i) => stepOf(i.id) === null),
        company: { name: config.aicoop.company.name },
        github: {
          secret_id: GITHUB_SECRET_ID,
          secret_kind: secretKind,
          repositories: repositoriesIn(config),
          placeholder: placeholderLocations(config).some((w) => w.startsWith("groups.")),
        },
        claude_login: deps.login.current(),
        image_build: deps.images.current(),
      };
    },

    proposeCompanyName(body) {
      if (!isRecord(body)) throw invalidInput("本文は JSON のオブジェクトにしてください");
      onlyKeys(body, ["name"]);
      if (typeof body.name !== "string") throw invalidInput("name（会社の名前）を書いてください");
      const name = body.name.trim();
      if (name === "") throw invalidInput("会社の名前が空です");
      if (BAD_NAME_CHARS.test(name)) {
        throw invalidInput("会社の名前に、改行や制御文字は使えません");
      }
      if ([...name].length > MAX_COMPANY_NAME_CHARS) {
        throw invalidInput(`会社の名前は${MAX_COMPANY_NAME_CHARS}文字までにしてください`);
      }
      const file = settings.readFile("aicoop.yaml");
      let content: string;
      try {
        content = setCompanyName(file.content, name);
      } catch (e) {
        throw editFailure(e);
      }
      return settings.proposeConfigChange([
        { path: "aicoop.yaml", content, base_sha256: file.sha256 },
      ]);
    },

    proposeRepositories(body) {
      if (!isRecord(body)) throw invalidInput("本文は JSON のオブジェクトにしてください");
      onlyKeys(body, ["repositories"]);
      const list = body.repositories;
      if (!Array.isArray(list) || list.length === 0) {
        throw invalidInput(
          "repositories（AI が触ってよいリポジトリの配列）を1つ以上書いてください",
        );
      }
      if (list.length > MAX_SETUP_REPOSITORIES) {
        throw invalidInput(`リポジトリは ${MAX_SETUP_REPOSITORIES} 個までです`);
      }
      const repositories: string[] = [];
      list.forEach((value, i) => {
        if (typeof value !== "string" || !isRepositoryPattern(value)) {
          throw invalidInput(
            `repositories[${i}] の形が違います。owner/repo か owner/*（owner は GitHub のユーザー名か組織名。* は「そのすべて」）で書いてください。*/*・../・空白・${PLACEHOLDER_GITHUB_OWNER} は使えません`,
          );
        }
        if (!repositories.includes(value)) repositories.push(value);
      });
      const file = settings.readFile("groups.yaml");
      let content: string;
      try {
        content = replacePlaceholderRepositories(file.content, repositories).content;
      } catch (e) {
        throw editFailure(e);
      }
      return settings.proposeConfigChange([
        { path: "groups.yaml", content, base_sha256: file.sha256 },
      ]);
    },
  };
}
