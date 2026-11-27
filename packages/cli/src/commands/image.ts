/**
 * `aicoop image build [--group <id>] [--claude-version <版>]`（9.1、5.1.8）。
 *
 * - `--group` なし：ベースイメージ（images/base）と、packages を書いた vm の部署のイメージ（images/groups/<id>）
 * - `--group <id>`：その部署のイメージだけ。packages がない部署はベースを使うので、作らない
 * - Windows では作れない（Gondolin は Linux・macOS だけ）
 * - 進み具合は、Gondolin が標準エラーに出す（verbose）。こちらは段階と結果を出す
 */
import { imageDir } from "@aicoop/box-gondolin";
import { loadConfig } from "@aicoop/shared";
import type { CommandInput } from "../command.ts";
import { CliError, UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { requireInitialized, shortPath } from "../home.ts";
import { suggest } from "../suggest.ts";
import { renderIssues } from "../ui/issues.ts";
import { formatDuration } from "../ui/time.ts";

const CLAUDE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

interface Target {
  readonly label: string;
  readonly outputDir: string;
  readonly packages?: readonly string[];
}

export async function run(input: CommandInput): Promise<number> {
  const { home, values, out, err, ctx } = input;
  requireInitialized(home);
  const version =
    values["claude-version"] === undefined ? undefined : String(values["claude-version"]).trim();
  if (version !== undefined && version !== "latest" && !CLAUDE_VERSION.test(version)) {
    throw new UsageError(`--claude-version の版の形が違います：${version.slice(0, 30)}`, [
      "2.1.3 のように書いてください（書かなければ最新）",
    ]);
  }
  if (ctx.platform === "win32") {
    throw new CliError(
      EXIT.failure,
      "Windows では vm の箱のイメージを作れません（Gondolin は Linux・macOS で動きます）",
      ["WSL2 の中で aicoop image build を実行してください（設計書 4.3）"],
    );
  }

  const config = loadConfig(home, { now: ctx.deps.now() });
  if (!config.ok) {
    err.lines(
      renderIssues(config.issues, err.style, { errorNote: "直してからイメージを作ってください" }),
    );
    err.line("");
    err.line("aicoop check で確かめられます。");
    return EXIT.failure;
  }
  const groups = config.config.groups;

  const targets: Target[] = [];
  const groupFlag = values.group === undefined ? undefined : String(values.group).trim();
  if (groupFlag !== undefined) {
    const group = Object.hasOwn(groups, groupFlag) ? groups[groupFlag] : undefined;
    if (group === undefined) {
      const close = suggest(groupFlag, Object.keys(groups));
      throw new UsageError(`部署 ${groupFlag.slice(0, 40)} は groups.yaml にありません`, [
        ...(close.length > 0 ? [`もしかして ${close.join("、")}`] : []),
        `部署：${Object.keys(groups).join("・")}`,
      ]);
    }
    if (group.box !== "vm") {
      throw new UsageError(
        `部署 ${groupFlag} は box: ${group.box} なので、vm のイメージは使いません`,
      );
    }
    if (group.packages.length === 0) {
      out.line(
        `部署 ${groupFlag} には packages がないので、ベースイメージ（${shortPath(imageDir(home), ctx.userHome)}）を使います。作り直すなら：aicoop image build`,
      );
      return EXIT.ok;
    }
    targets.push({
      label: `部署 ${groupFlag} の`,
      outputDir: imageDir(home, groupFlag),
      packages: group.packages,
    });
  } else {
    targets.push({ label: "ベースの", outputDir: imageDir(home) });
    for (const [id, group] of Object.entries(groups)) {
      if (group.box === "vm" && group.packages.length > 0) {
        targets.push({
          label: `部署 ${id} の`,
          outputDir: imageDir(home, id),
          packages: group.packages,
        });
      }
    }
  }

  const style = out.style;
  for (const [i, target] of targets.entries()) {
    const extra = target.packages ? `（足すパッケージ：${target.packages.join("・")}）` : "";
    err.line(
      style.bold(`[${i + 1}/${targets.length}] ${target.label}イメージを作っています${extra}…`) +
        style.dim(" Claude Code と Alpine のパッケージを取ってくるので、数分かかります"),
    );
    const started = ctx.deps.now().getTime();
    let result: Awaited<ReturnType<typeof ctx.deps.buildImage>>;
    try {
      result = await ctx.deps.buildImage({
        outputDir: target.outputDir,
        ...(target.packages !== undefined && { packages: target.packages }),
        ...(version !== undefined && version !== "latest" && { claudeCodeVersion: version }),
        verbose: true,
      });
    } catch (e) {
      throw new CliError(
        EXIT.failure,
        `${target.label}イメージを作れませんでした：${e instanceof Error ? e.message : String(e)}`,
        [
          "downloads.claude.ai と Alpine のミラーにつながるか確かめてください",
          "QEMU と、Linux なら KVM が要ります（aicoop check で確かめられます）",
          ...(i > 0
            ? [
                `ここまでに作ったイメージは残っています。続きだけなら：aicoop image build --group <id>`,
              ]
            : []),
        ],
      );
    }
    const took = formatDuration(ctx.deps.now().getTime() - started);
    out.line(
      `${style.green("✓")} ${target.label}イメージを作りました（Claude Code ${result.claudeCodeVersion}・パッケージ ${result.packages.length}個・${took}）`,
    );
    out.line(`    ${shortPath(result.outputDir, ctx.userHome)}`);
  }
  out.line("");
  out.line("次の実行から、新しいイメージを使います。制御サーバーを起動するなら：aicoop start");
  return EXIT.ok;
}
