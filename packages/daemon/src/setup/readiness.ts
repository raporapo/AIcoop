/**
 * 「準備の確認」（`aicoop check` の後半と、準備の画面の `GET /setup`。5.14 の3）。エラーにはせず、
 * 足りないものと、その用意のしかたを返す。CLI（`packages/cli/src/readiness.ts`）もこれを使い、
 * 制御サーバーが動いているかの項目だけを足す。
 *
 * - 資格：Anthropic のトークン（5.4.1）と、設定で使うサービスの資格（5.2.8）。
 *   資格の ID は、サービスの ID と同じとみなす（例：github のサービスは secrets.json の github）
 * - 雛形の `your-org` を書き換えたか
 * - vm のイメージ（5.1.8）：ベースと、packages を書いた vm の部署のもの
 * - この OS で vm の箱が動くか（4.3 の4、11.1）：Windows は WSL2、Linux は KVM、QEMU
 *
 * 資格の中身は読まない（種類だけを見る）。項目の文にも入れない（5.2.8、11.5）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_METADATA_FILE, imageDir } from "@aicoop/box-gondolin";
import {
  type CompanyConfig,
  DEFAULT_COMPANY_NAME,
  effectivePermissionsFor,
  type SecretKind,
} from "@aicoop/shared";
import { PLACEHOLDER_GITHUB_OWNER, type SetupItem } from "@aicoop/shared/api";
import { aicoopPaths } from "../paths.ts";
import { listSecrets, SecretStoreError } from "../secrets/store.ts";

export type ReadinessItem = SetupItem;

/** 準備の確認が見る、この PC のこと（CLI は CliContext から、daemon は自分のプロセスから渡す） */
export interface ReadinessHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** PATH から実行ファイルを探す（見つからなければ null） */
  which(command: string): string | null;
  /** ファイルが読み書きできるか（/dev/kvm） */
  canAccess(path: string): boolean;
  now(): Date;
}

export interface ReadinessOptions {
  /**
   * `static_token` の資格を、サービスの種類（`github_app` など）に関わらず済みとする。資格の発行（`secrets/issue.ts`）は
   * どのサービスでも static_token をそのまま使うので、準備の画面ではこれを済みとする（SU-）。
   * `aicoop check` は今までどおり、サービスの種類と違えば知らせる
   */
  readonly acceptStaticToken?: boolean;
}

const SERVICE_LABEL: Readonly<Record<string, string>> = {
  github: "GitHub",
  gmail: "Gmail",
};

function setHint(id: string, kind: SecretKind): string {
  switch (kind) {
    case "github_app":
      return `aicoop secret set ${id} --kind github_app < github-app.json（app_id・installation_id・private_key の JSON）`;
    case "google_oauth":
      return `aicoop secret set ${id} --kind google_oauth < google.json（client_id・client_secret・refresh_token の JSON）`;
    case "anthropic_oauth":
      return id === "anthropic"
        ? "aicoop login（ブラウザで Claude にログインすると登録されます）"
        : `claude setup-token でトークンを作り、aicoop secret set ${id} --kind anthropic_oauth で貼り付ける`;
    case "static_token":
      return `aicoop secret set ${id} --kind static_token でトークンを貼り付ける`;
  }
}

type SecretsView =
  | { readonly ok: true; readonly kinds: ReadonlyMap<string, SecretKind> }
  | {
      readonly ok: false;
      readonly message: string;
    };

function readSecrets(path: string): SecretsView {
  if (!existsSync(path)) return { ok: true, kinds: new Map() };
  try {
    return { ok: true, kinds: new Map(listSecrets(path).map((s) => [s.id, s.kind])) };
  } catch (e) {
    // SecretStoreError の文は中身を含まない（5.2.8）。それ以外の失敗は、文を出さない
    return {
      ok: false,
      message: e instanceof SecretStoreError ? e.message : "secrets.json を読めません",
    };
  }
}

function secretItem(
  secrets: SecretsView,
  id: string,
  kind: SecretKind,
  label: string,
  options: ReadinessOptions,
  usedBy?: readonly string[],
): ReadinessItem {
  const itemId = `secret:${id}`;
  const users = usedBy && usedBy.length > 0 ? `（${usedBy.join("・")} が使います）` : "";
  // 「GitHub の資格」「Claude（Anthropic）の資格」
  const subject = /[A-Za-z0-9]$/.test(label) ? `${label} の資格` : `${label}の資格`;
  if (!secrets.ok)
    return { id: itemId, ok: false, message: secrets.message, hint: setHint(id, kind) };
  const actual = secrets.kinds.get(id);
  if (actual === undefined) {
    return {
      id: itemId,
      ok: false,
      message: `${subject}（${id}、${kind}）が登録されていません${users}`,
      hint: setHint(id, kind),
    };
  }
  if (actual === "static_token" && actual !== kind && options.acceptStaticToken === true) {
    return { id: itemId, ok: true, message: `${subject}（${id}、static_token）が登録されています` };
  }
  if (actual !== kind) {
    return {
      id: itemId,
      ok: false,
      message: `${subject}（${id}）の種類が ${kind} ではありません（いま：${actual}）`,
      hint: `登録し直してください：${setHint(id, kind)}`,
    };
  }
  return { id: itemId, ok: true, message: `${subject}（${id}、${kind}）が登録されています` };
}

/** 設定で使うサービスのうち、資格の要るもの → 使う社員 */
export function servicesInUse(config: CompanyConfig, now: Date): Map<string, string[]> {
  const used = new Map<string, string[]>();
  for (const [memberId, member] of Object.entries(config.members)) {
    if (member.kind !== "ai") continue;
    let ops: readonly { readonly op: string }[];
    try {
      ops = effectivePermissionsFor(config, memberId, { now });
    } catch {
      continue;
    }
    for (const { op } of ops) {
      const service = op.split(".")[0] ?? "";
      const list = used.get(service) ?? [];
      if (!list.includes(memberId)) list.push(memberId);
      used.set(service, list);
    }
  }
  return used;
}

/** 雛形のまま残っている `your-org`（ceiling・allow の params） */
export function placeholderLocations(config: CompanyConfig): string[] {
  const found: string[] = [];
  const scan = (items: readonly unknown[], where: string) => {
    items.forEach((item, i) => {
      const params = (item as { params?: Record<string, readonly string[]> }).params ?? {};
      if (
        Object.values(params).some((globs) =>
          globs.some((g) => g.includes(PLACEHOLDER_GITHUB_OWNER)),
        )
      ) {
        found.push(`${where}.${i}`);
      }
    });
  };
  for (const [id, g] of Object.entries(config.groups)) scan(g.ceiling, `groups.${id}.ceiling`);
  for (const [id, r] of Object.entries(config.roles)) scan(r.allow, `roles.${id}.allow`);
  return found;
}

interface ImageMeta {
  readonly claudeCodeVersion?: string;
  readonly packages?: readonly string[];
  readonly builtAt?: string;
}

function readImageMeta(dir: string): ImageMeta | null {
  try {
    return JSON.parse(readFileSync(join(dir, IMAGE_METADATA_FILE), "utf8")) as ImageMeta;
  } catch {
    return null;
  }
}

function imageItems(home: string, config: CompanyConfig | undefined): ReadinessItem[] {
  const vmGroups = config
    ? Object.entries(config.groups).filter(([, g]) => g.box === "vm")
    : undefined;
  if (vmGroups !== undefined && vmGroups.length === 0) return [];
  const items: ReadinessItem[] = [];
  const meta = readImageMeta(imageDir(home));
  if (meta === null) {
    items.push({
      id: "image:base",
      ok: false,
      message: "vm の箱のイメージがありません",
      hint: "aicoop image build（数分かかります）",
    });
  } else {
    const version = meta.claudeCodeVersion ? `Claude Code ${meta.claudeCodeVersion}` : "版は不明";
    const built = meta.builtAt ? `、${meta.builtAt.slice(0, 10)} に作成` : "";
    items.push({
      id: "image:base",
      ok: true,
      message: `vm の箱のイメージがあります（${version}${built}）`,
    });
  }
  for (const [id, group] of vmGroups ?? []) {
    if (group.packages.length === 0) continue;
    const groupMeta = readImageMeta(imageDir(home, id));
    const itemId = `image:${id}`;
    if (groupMeta === null) {
      items.push({
        id: itemId,
        ok: false,
        message: `部署 ${id} のイメージ（packages を足したもの）がありません`,
        hint: `aicoop image build --group ${id}`,
      });
      continue;
    }
    const have = new Set(groupMeta.packages ?? []);
    const missing = group.packages.filter((p) => !have.has(p));
    items.push(
      missing.length > 0
        ? {
            id: itemId,
            ok: false,
            message: `部署 ${id} のイメージに、packages の ${missing.join("・")} が入っていません（packages を変えたあと作り直していません）`,
            hint: `aicoop image build --group ${id}`,
          }
        : { id: itemId, ok: true, message: `部署 ${id} のイメージがあります` },
    );
  }
  return items;
}

function osItems(host: ReadinessHost): ReadinessItem[] {
  const { platform } = host;
  if (platform === "win32") {
    return [
      {
        id: "os:platform",
        ok: false,
        message: "この OS（Windows）では vm の箱は動きません",
        hint: "WSL2 の中で aicoop を動かしてください（設計書 4.3）",
      },
    ];
  }
  if (platform !== "linux" && platform !== "darwin") {
    return [
      { id: "os:platform", ok: false, message: `この OS（${platform}）には対応していません` },
    ];
  }
  const items: ReadinessItem[] = [];
  if (platform === "linux") {
    items.push(
      host.canAccess("/dev/kvm")
        ? { id: "os:kvm", ok: true, message: "KVM（/dev/kvm）が使えます" }
        : {
            id: "os:kvm",
            ok: false,
            message: "KVM（/dev/kvm）が使えません。vm の箱が動きません",
            hint: "BIOS・UEFI で仮想化を有効にし、自分を kvm グループに入れてください（sudo usermod -aG kvm $USER のあと、ログインし直す）",
          },
    );
  }
  const qemu = host.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64";
  const found = host.which(qemu);
  items.push(
    found
      ? { id: "os:qemu", ok: true, message: `QEMU（${qemu}）があります` }
      : {
          id: "os:qemu",
          ok: false,
          message: `QEMU（${qemu}）が見つかりません。vm の箱が動きません`,
          hint:
            platform === "darwin"
              ? "brew install qemu"
              : `sudo apt install ${host.arch === "arm64" ? "qemu-system-arm" : "qemu-system-x86"}（Debian・Ubuntu の場合）`,
        },
  );
  if (platform === "linux") items.push(imageToolsItem(host));
  return items;
}

/** aicoop image build（5.1.8）がホストで使う道具。GitHub のランナーには最初から入っているが、入れたての Ubuntu には無い */
const IMAGE_TOOLS = [
  { command: "mke2fs", aptPackage: "e2fsprogs" },
  { command: "cpio", aptPackage: "cpio" },
  { command: "lz4", aptPackage: "lz4" },
] as const;

function imageToolsItem(host: ReadinessHost): ReadinessItem {
  const missing = IMAGE_TOOLS.filter((t) => !host.which(t.command));
  if (missing.length === 0) {
    return {
      id: "os:image-tools",
      ok: true,
      message: `イメージを作る道具（${IMAGE_TOOLS.map((t) => t.command).join("・")}）があります`,
    };
  }
  return {
    id: "os:image-tools",
    ok: false,
    message: `イメージを作る道具（${missing.map((t) => t.command).join("・")}）が見つかりません。aicoop image build ができません`,
    hint: `sudo apt install ${missing.map((t) => t.aptPackage).join(" ")}（Debian・Ubuntu の場合）`,
  };
}

/**
 * 準備の確認（制御サーバーが動いているかの項目は入れない。CLI が足す）。
 * `config` が undefined なら、設定にエラーがある（サービスの資格と your-org は確かめない）
 */
export async function checkHostReadiness(
  host: ReadinessHost,
  home: string,
  config: CompanyConfig | undefined,
  options: ReadinessOptions = {},
): Promise<ReadinessItem[]> {
  const paths = aicoopPaths(home);
  const secrets = readSecrets(paths.secrets);
  const items: ReadinessItem[] = [
    secretItem(secrets, "anthropic", "anthropic_oauth", "Claude（Anthropic）", options),
  ];

  if (config === undefined) {
    items.push({
      id: "secret:services",
      ok: false,
      message: "設定にエラーがあるので、サービスの資格と your-org は確かめていません",
    });
  } else {
    const used = servicesInUse(config, host.now());
    for (const [serviceId, members] of [...used].sort(([a], [b]) => a.localeCompare(b))) {
      const service = config.services.find((s) => s.id === serviceId);
      if (!service || service.secret === null) continue;
      items.push(
        secretItem(
          secrets,
          serviceId,
          service.secret.kind,
          SERVICE_LABEL[serviceId] ?? serviceId,
          options,
          members,
        ),
      );
    }
    const placeholders = placeholderLocations(config);
    if (placeholders.length > 0) {
      items.push({
        id: "placeholder:your-org",
        ok: false,
        message: `雛形の「your-org」が残っています（${placeholders.join("、")}）。このままでは、どのリポジトリにも届きません`,
        hint: "groups.yaml の your-org を、自分の GitHub のユーザー名か組織名に書き換えてください",
      });
    }
  }

  items.push(...imageItems(home, config));
  items.push(...osItems(host));
  return items;
}

/** 会社の名前（5.14 の3の1）。雛形の「わたしの会社」のままなら、済んでいない（D-30） */
export function companyNameItem(name: string): ReadinessItem {
  return name.trim() === DEFAULT_COMPANY_NAME
    ? {
        id: "company:name",
        ok: false,
        message: `会社の名前が、雛形の「${DEFAULT_COMPANY_NAME}」のままです`,
        hint: "準備の画面で会社の名前を入れてください（aicoop.yaml の company.name）",
      }
    : { id: "company:name", ok: true, message: `会社の名前は「${name}」です` };
}
