import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildConfig } from "@earendil-works/gondolin";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BASE_PACKAGES,
  buildImage,
  CLAUDE_CODE_DOWNLOAD_BASE,
  claudeCodePlatform,
  createImageBuildConfig,
  downloadClaudeCode,
  GIT_CONFIG,
  IMAGE_ENV,
  imageDir,
} from "./image.ts";

const BINARY = Buffer.from("#!/bin/sh\necho claude\n");
const SHA = createHash("sha256").update(BINARY).digest("hex");

/** Claude Code の配布元の代わり */
function fakeFetch(
  overrides: { version?: string; checksum?: string; binary?: Buffer; status?: number } = {},
) {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (overrides.status !== undefined) return new Response("x", { status: overrides.status });
    if (url === `${CLAUDE_CODE_DOWNLOAD_BASE}/latest`) {
      return new Response(`${overrides.version ?? "2.3.4"}\n`);
    }
    if (url.endsWith("/manifest.json")) {
      return Response.json({
        version: overrides.version ?? "2.3.4",
        platforms: {
          "linux-x64-musl": { checksum: overrides.checksum ?? SHA, size: BINARY.length },
          "linux-arm64-musl": { checksum: overrides.checksum ?? SHA, size: BINARY.length },
        },
      });
    }
    if (url.endsWith("/claude")) return new Response(overrides.binary ?? BINARY);
    return new Response("not found", { status: 404 });
  };
  return { fetchImpl, calls };
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicoop-image-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("5.1.8：イメージの置き場所", () => {
  it("ベースは ~/.aicoop/images/base、部署ごとは ~/.aicoop/images/groups/<group>", () => {
    expect(imageDir("/home/u/.aicoop")).toBe(join("/home/u/.aicoop", "images", "base"));
    expect(imageDir("/home/u/.aicoop", "dev")).toBe(
      join("/home/u/.aicoop", "images", "groups", "dev"),
    );
  });

  it.each(["../x", "a/b", "", ".", "A B"])("部署の ID %j では作らない", (groupId) => {
    expect(() => imageDir("/home/u/.aicoop", groupId)).toThrow();
  });
});

describe("5.1.8：Claude Code（公式のネイティブ版、musl 版）を取ってくる", () => {
  it("Alpine は musl なので、musl 版のプラットフォームを選ぶ", () => {
    expect(claudeCodePlatform("x86_64")).toBe("linux-x64-musl");
    expect(claudeCodePlatform("aarch64")).toBe("linux-arm64-musl");
  });

  it("latest の版を調べ、manifest.json の SHA-256 で確かめてから置く", async () => {
    const { fetchImpl, calls } = fakeFetch();
    const dest = join(dir, "claude");
    const got = await downloadClaudeCode({ arch: "x86_64", destPath: dest, fetch: fetchImpl });
    expect(got).toEqual({ version: "2.3.4", sha256: SHA });
    expect(readFileSync(dest)).toEqual(BINARY);
    expect(calls).toEqual([
      `${CLAUDE_CODE_DOWNLOAD_BASE}/latest`,
      `${CLAUDE_CODE_DOWNLOAD_BASE}/2.3.4/manifest.json`,
      `${CLAUDE_CODE_DOWNLOAD_BASE}/2.3.4/linux-x64-musl/claude`,
    ]);
  });

  it("版を指定すれば、その版を取る", async () => {
    const { fetchImpl, calls } = fakeFetch({ version: "2.0.1" });
    await downloadClaudeCode({
      arch: "aarch64",
      version: "2.0.1",
      destPath: join(dir, "claude"),
      fetch: fetchImpl,
    });
    expect(calls[0]).toBe(`${CLAUDE_CODE_DOWNLOAD_BASE}/2.0.1/manifest.json`);
    expect(calls[1]).toBe(`${CLAUDE_CODE_DOWNLOAD_BASE}/2.0.1/linux-arm64-musl/claude`);
  });

  it("SHA-256 が合わなければ失敗し、ファイルを置かない", async () => {
    const { fetchImpl } = fakeFetch({ binary: Buffer.from("tampered") });
    const dest = join(dir, "claude");
    await expect(
      downloadClaudeCode({ arch: "x86_64", destPath: dest, fetch: fetchImpl }),
    ).rejects.toThrow(/SHA-256/);
    expect(existsSync(dest)).toBe(false);
  });

  it("manifest に SHA-256 がなければ失敗する", async () => {
    const { fetchImpl } = fakeFetch({ checksum: "not-a-hash" });
    await expect(
      downloadClaudeCode({ arch: "x86_64", destPath: join(dir, "claude"), fetch: fetchImpl }),
    ).rejects.toThrow();
  });

  it.each(["../../evil", "2.3", "latest; rm", ""])("版 %j は使わない", async (version) => {
    const { fetchImpl } = fakeFetch();
    await expect(
      downloadClaudeCode({
        arch: "x86_64",
        version,
        destPath: join(dir, "claude"),
        fetch: fetchImpl,
      }),
    ).rejects.toThrow();
  });

  it("latest が版の形でなければ失敗する", async () => {
    const { fetchImpl } = fakeFetch({ version: "<html>" });
    await expect(
      downloadClaudeCode({ arch: "x86_64", destPath: join(dir, "claude"), fetch: fetchImpl }),
    ).rejects.toThrow();
  });

  it("配布元がエラーを返せば失敗する", async () => {
    const { fetchImpl } = fakeFetch({ status: 503 });
    await expect(
      downloadClaudeCode({ arch: "x86_64", destPath: join(dir, "claude"), fetch: fetchImpl }),
    ).rejects.toThrow();
  });
});

describe("5.1.8：ベースイメージの組み立て（Gondolin の BuildConfig）", () => {
  const base = { arch: "x86_64" as const, claudeBinaryPath: "/tmp/c", gitConfigPath: "/tmp/g" };

  it("5.1.8 の1：Gondolin の既定の Alpine に、git・ripgrep・libgcc・libstdc++・ca-certificates を足す", () => {
    const config = createImageBuildConfig(base);
    const packages = config.alpine?.rootfsPackages ?? [];
    expect(BASE_PACKAGES).toEqual(["git", "ripgrep", "libgcc", "libstdc++", "ca-certificates"]);
    for (const pkg of BASE_PACKAGES) expect(packages).toContain(pkg);
    // Gondolin の既定（カーネルなど）は残す
    expect(packages).toContain("linux-virt");
    expect(config.distro).toBe("alpine");
    expect(config.arch).toBe("x86_64");
  });

  it("5.1.8 の2：部署ごとの packages も足す（重なりは1つにする）", () => {
    const config = createImageBuildConfig({
      ...base,
      packages: ["nodejs", "python3", "jq", "git"],
    });
    const packages = config.alpine?.rootfsPackages ?? [];
    expect(packages).toContain("jq");
    expect(packages.filter((p) => p === "git")).toHaveLength(1);
    expect(new Set(packages).size).toBe(packages.length);
  });

  it.each(["jq;rm -rf /", "-x", "", "A", "../x", "a b"])("パッケージ名 %j は使わない", (pkg) => {
    expect(() => createImageBuildConfig({ ...base, packages: [pkg] })).toThrow();
  });

  it("Claude Code を /usr/local/bin/claude に、git の設定を /etc/gitconfig に置く", () => {
    const config = createImageBuildConfig(base);
    expect(config.postBuild?.copy).toEqual([
      { src: "/tmp/c", dest: "/usr/local/bin/claude" },
      { src: "/tmp/g", dest: "/etc/gitconfig" },
    ]);
    // root での chroot が要るので、postBuild.commands は使わない
    expect(config.postBuild?.commands ?? []).toEqual([]);
  });

  it("musl 版の Claude Code は箱の中の ripgrep を使い、自動更新はしない", () => {
    expect(IMAGE_ENV).toMatchObject({ USE_BUILTIN_RIPGREP: "0", DISABLE_AUTOUPDATER: "1" });
    expect(createImageBuildConfig(base).env).toEqual(IMAGE_ENV);
  });

  it("5.1.8 の3：git の資格ヘルパーは、github.com の HTTPS にユーザー名 x-access-token・パスワード $GITHUB_TOKEN を返す", () => {
    expect(GIT_CONFIG).toContain('[credential "https://github.com"]');
    expect(GIT_CONFIG).toContain("username=x-access-token");
    expect(GIT_CONFIG).toContain("password=$GITHUB_TOKEN");
    // 本物の資格は書かない（仮の札は実行のときの環境変数から読む）
    expect(GIT_CONFIG).not.toMatch(/gh[pousr]_/);
  });
});

describe("5.1.8：aicoop image build から呼ぶ buildImage", () => {
  function fakeBuild() {
    const calls: { config: BuildConfig; outputDir: string }[] = [];
    const buildAssetsImpl = async (config: BuildConfig, options: { outputDir: string }) => {
      calls.push({ config, outputDir: options.outputDir });
      // コピーされるファイルが、そのときにあることを確かめる
      for (const entry of config.postBuild?.copy ?? []) {
        expect(existsSync(entry.src)).toBe(true);
      }
      mkdirSync(options.outputDir, { recursive: true });
      writeFileSync(join(options.outputDir, "manifest.json"), "{}");
      return {
        outputDir: options.outputDir,
        manifestPath: join(options.outputDir, "manifest.json"),
        manifest: {} as never,
      };
    };
    return { calls, buildAssetsImpl };
  }

  it("Claude Code と git の設定を用意して Gondolin で組み立て、出力先に置く", async () => {
    const { fetchImpl } = fakeFetch();
    const { calls, buildAssetsImpl } = fakeBuild();
    const outputDir = join(dir, "images", "base");
    const result = await buildImage({
      outputDir,
      arch: "x86_64",
      packages: ["jq"],
      fetch: fetchImpl,
      buildAssets: buildAssetsImpl,
      verbose: false,
    });
    expect(result.outputDir).toBe(outputDir);
    expect(result.claudeCodeVersion).toBe("2.3.4");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.config.alpine?.rootfsPackages).toContain("jq");
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(outputDir, "aicoop-image.json"), "utf8"));
    expect(meta).toMatchObject({ claudeCodeVersion: "2.3.4", claudeCodeSha256: SHA });
    expect(meta.packages).toContain("jq");
  });

  it("作り直すときは、できあがってから前のイメージと入れ替える", async () => {
    const outputDir = join(dir, "images", "base");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "old-file"), "old");
    const { fetchImpl } = fakeFetch();
    const { buildAssetsImpl } = fakeBuild();
    await buildImage({
      outputDir,
      arch: "x86_64",
      fetch: fetchImpl,
      buildAssets: buildAssetsImpl,
      verbose: false,
    });
    expect(existsSync(join(outputDir, "old-file"))).toBe(false);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(true);
  });

  it("組み立てに失敗したら、前のイメージを残す", async () => {
    const outputDir = join(dir, "images", "base");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "old-file"), "old");
    const { fetchImpl } = fakeFetch();
    await expect(
      buildImage({
        outputDir,
        arch: "x86_64",
        fetch: fetchImpl,
        buildAssets: async () => {
          throw new Error("build failed");
        },
        verbose: false,
      }),
    ).rejects.toThrow("build failed");
    expect(readFileSync(join(outputDir, "old-file"), "utf8")).toBe("old");
  });
});
