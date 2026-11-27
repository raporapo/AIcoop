import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Architecture,
  type BuildConfig,
  type BuildOptions,
  type BuildResult,
  getDefaultArch,
  getDefaultBuildConfig,
  buildAssets as gondolinBuildAssets,
} from "@earendil-works/gondolin";

/**
 * vm のベースイメージ（5.1.8）。`aicoop image build` から呼ぶ。
 *
 * Gondolin の既定の Alpine（`getDefaultBuildConfig()`）に、`BASE_PACKAGES` と部署ごとの
 * `packages`（`groups.<id>.packages`）を足し、Claude Code（公式のネイティブ版の musl 版）と
 * git の資格ヘルパーの設定を置く。Gondolin の `postBuild.commands` は root での chroot が要るので使わず、
 * ホストで用意したファイルを `postBuild.copy` で入れる。
 */

/** 5.1.8 の1 で足すパッケージ */
export const BASE_PACKAGES = ["git", "ripgrep", "libgcc", "libstdc++", "ca-certificates"] as const;

/** Claude Code の配布元（公式のインストーラー `https://claude.ai/install.sh` と同じ） */
export const CLAUDE_CODE_DOWNLOAD_BASE = "https://downloads.claude.ai/claude-code-releases";

/** イメージに焼き込む環境変数 */
export const IMAGE_ENV: Readonly<Record<string, string>> = Object.freeze({
  // musl 版の Claude Code は、同梱の ripgrep ではなく箱の中の ripgrep を使う
  USE_BUILTIN_RIPGREP: "0",
  // 箱は使い捨てで、版はイメージで決める
  DISABLE_AUTOUPDATER: "1",
  // 資格が足りないときに、git が端末で尋ねて止まらないようにする
  GIT_TERMINAL_PROMPT: "0",
});

/**
 * 5.1.8 の3：箱の中の git の資格ヘルパー。github.com の HTTPS だけに、
 * ユーザー名 `x-access-token`、パスワード `$GITHUB_TOKEN`（仮の札）を返す。
 * 仮の札は、資格プロキシが forward と判定したときだけ、Basic 認証の中で本物に置き換わる。
 */
export const GIT_CONFIG = `[credential "https://github.com"]
\thelper =
\thelper = "!f() { test \\"$1\\" = get || exit 0; echo username=x-access-token; echo \\"password=$GITHUB_TOKEN\\"; }; f"
`;

const PACKAGE_NAME = /^[a-z0-9][a-z0-9+._-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GROUP_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** イメージの置き場所：`<home>/images/base`、部署ごとは `<home>/images/groups/<group>` */
export function imageDir(aicoopHome: string, groupId?: string): string {
  if (groupId === undefined) return join(aicoopHome, "images", "base");
  if (!GROUP_ID.test(groupId)) {
    throw new Error(`部署の ID が不正です：${JSON.stringify(groupId)}`);
  }
  return join(aicoopHome, "images", "groups", groupId);
}

export function claudeCodePlatform(arch: Architecture): "linux-x64-musl" | "linux-arm64-musl" {
  return arch === "aarch64" ? "linux-arm64-musl" : "linux-x64-musl";
}

type FetchLike = (input: string) => Promise<Response>;

export interface DownloadClaudeCodeOptions {
  readonly arch: Architecture;
  /** 版（例 `2.1.3`）か `latest`。既定は `latest` */
  readonly version?: string;
  readonly destPath: string;
  readonly fetch?: FetchLike;
}

/** Claude Code の musl 版を取ってきて、manifest.json の SHA-256 で確かめてから置く */
export async function downloadClaudeCode(
  options: DownloadClaudeCodeOptions,
): Promise<{ readonly version: string; readonly sha256: string }> {
  const fetchImpl: FetchLike = options.fetch ?? ((url) => fetch(url));
  const requested = options.version ?? "latest";
  let version: string;
  if (requested === "latest") {
    version = (await fetchText(fetchImpl, `${CLAUDE_CODE_DOWNLOAD_BASE}/latest`)).trim();
  } else {
    version = requested;
  }
  if (!VERSION.test(version)) {
    throw new Error(`Claude Code の版が不正です：${JSON.stringify(version.slice(0, 40))}`);
  }

  const platform = claudeCodePlatform(options.arch);
  const manifest: unknown = JSON.parse(
    await fetchText(fetchImpl, `${CLAUDE_CODE_DOWNLOAD_BASE}/${version}/manifest.json`),
  );
  const checksum = readChecksum(manifest, platform);
  if (checksum === null) {
    throw new Error(
      `Claude Code ${version} の manifest.json に ${platform} の SHA-256 がありません`,
    );
  }

  const res = await fetchImpl(`${CLAUDE_CODE_DOWNLOAD_BASE}/${version}/${platform}/claude`);
  if (!res.ok) throw new Error(`Claude Code を取ってこられません（HTTP ${res.status}）`);
  const binary = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(binary).digest("hex");
  if (actual !== checksum) {
    throw new Error(
      `Claude Code ${version}（${platform}）の SHA-256 が manifest.json と合いません`,
    );
  }

  mkdirSync(dirname(options.destPath), { recursive: true });
  writeFileSync(options.destPath, binary, { mode: 0o755 });
  chmodSync(options.destPath, 0o755);
  return { version, sha256: actual };
}

async function fetchText(fetchImpl: FetchLike, url: string): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${url} を取ってこられません（HTTP ${res.status}）`);
  return res.text();
}

function readChecksum(manifest: unknown, platform: string): string | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const platforms = (manifest as { platforms?: unknown }).platforms;
  if (typeof platforms !== "object" || platforms === null) return null;
  const entry = (platforms as Record<string, unknown>)[platform];
  if (typeof entry !== "object" || entry === null) return null;
  const checksum = (entry as { checksum?: unknown }).checksum;
  return typeof checksum === "string" && SHA256.test(checksum) ? checksum : null;
}

export interface ImageBuildConfigInput {
  readonly arch: Architecture;
  /** 部署ごとに足す Alpine のパッケージ（`groups.<id>.packages`） */
  readonly packages?: readonly string[];
  /** ホストに置いた Claude Code の実行ファイル */
  readonly claudeBinaryPath: string;
  /** ホストに置いた git の設定（`GIT_CONFIG`） */
  readonly gitConfigPath: string;
}

export function createImageBuildConfig(input: ImageBuildConfigInput): BuildConfig {
  for (const pkg of input.packages ?? []) {
    if (!PACKAGE_NAME.test(pkg)) {
      throw new Error(`Alpine のパッケージ名が不正です：${JSON.stringify(pkg)}`);
    }
  }
  const defaults = getDefaultBuildConfig();
  const alpine = defaults.alpine ?? { version: "3.23.7" };
  const rootfsPackages = [
    ...new Set([...(alpine.rootfsPackages ?? []), ...BASE_PACKAGES, ...(input.packages ?? [])]),
  ];
  return {
    ...defaults,
    arch: input.arch,
    distro: "alpine",
    alpine: { ...alpine, rootfsPackages },
    env: { ...IMAGE_ENV },
    postBuild: {
      copy: [
        { src: input.claudeBinaryPath, dest: "/usr/local/bin/claude" },
        { src: input.gitConfigPath, dest: "/etc/gitconfig" },
      ],
    },
  };
}

export interface BuildImageOptions {
  /** 出力先（`imageDir()`）。できあがってから入れ替える */
  readonly outputDir: string;
  /** 部署ごとに足す Alpine のパッケージ */
  readonly packages?: readonly string[];
  /** Claude Code の版。既定は `latest` */
  readonly claudeCodeVersion?: string;
  readonly arch?: Architecture;
  /** 進み具合を標準エラーに出す（既定 true） */
  readonly verbose?: boolean;
  /** テスト用 */
  readonly fetch?: FetchLike;
  /** テスト用 */
  readonly buildAssets?: (config: BuildConfig, options: BuildOptions) => Promise<BuildResult>;
}

export interface BuildImageResult {
  readonly outputDir: string;
  readonly claudeCodeVersion: string;
  readonly packages: readonly string[];
}

/** イメージに添える aicoop の記録 */
export const IMAGE_METADATA_FILE = "aicoop-image.json";

export async function buildImage(options: BuildImageOptions): Promise<BuildImageResult> {
  const arch = options.arch ?? getDefaultArch();
  const build = options.buildAssets ?? gondolinBuildAssets;
  const workDir = mkdtempSync(join(tmpdir(), "aicoop-image-"));
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const stagingDir = `${options.outputDir}.building-${suffix}`;
  try {
    const claudeBinaryPath = join(workDir, "claude");
    const gitConfigPath = join(workDir, "gitconfig");
    const claude = await downloadClaudeCode({
      arch,
      destPath: claudeBinaryPath,
      ...(options.claudeCodeVersion === undefined ? {} : { version: options.claudeCodeVersion }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    writeFileSync(gitConfigPath, GIT_CONFIG, { mode: 0o644 });

    const config = createImageBuildConfig({
      arch,
      claudeBinaryPath,
      gitConfigPath,
      ...(options.packages === undefined ? {} : { packages: options.packages }),
    });
    mkdirSync(dirname(options.outputDir), { recursive: true });
    await build(config, {
      outputDir: stagingDir,
      verbose: options.verbose ?? true,
      workDir: join(workDir, "build"),
    });
    const packages = config.alpine?.rootfsPackages ?? [];
    writeFileSync(
      join(stagingDir, IMAGE_METADATA_FILE),
      `${JSON.stringify(
        {
          claudeCodeVersion: claude.version,
          claudeCodeSha256: claude.sha256,
          arch,
          packages,
          builtAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    swapDirectory(stagingDir, options.outputDir, suffix);
    return { outputDir: options.outputDir, claudeCodeVersion: claude.version, packages };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** できあがったイメージを出力先に入れ替える。前のものは入れ替えたあとで消す */
function swapDirectory(stagingDir: string, outputDir: string, suffix: string): void {
  const oldDir = `${outputDir}.old-${suffix}`;
  const hadOld = existsSync(outputDir);
  if (hadOld) renameSync(outputDir, oldDir);
  try {
    renameSync(stagingDir, outputDir);
  } catch (error) {
    if (hadOld) renameSync(oldDir, outputDir);
    throw error;
  }
  if (hadOld) rmSync(oldDir, { recursive: true, force: true });
}
