/**
 * 「準備の確認」（aicoop check の後半）。エラーにはせず、足りないものと、その用意のしかたを返す。
 *
 * 資格・your-org・イメージ・OS の項目は、準備の画面（5.14 の3）と同じ判定を `@aicoop/daemon` の
 * `checkHostReadiness` で行う。ここでは、daemon が動いているか・読み直しが要るか（6.1）だけを足す。
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkHostReadiness, type ReadinessItem, type StatusResponse } from "@aicoop/daemon";
import type { CompanyConfig } from "@aicoop/shared";
import { probeDaemon } from "./api/client.ts";
import type { CliContext } from "./context.ts";

export type { ReadinessItem };

/** 設定ファイルのうち、いちばん新しい変更の時刻 */
function latestConfigChange(home: string): number {
  let latest = 0;
  const visit = (path: string, depth: number) => {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (depth > 4) return;
      for (const name of readdirSync(path)) visit(join(path, name), depth + 1);
      return;
    }
    if (/\.(ya?ml|md)$/.test(path)) latest = Math.max(latest, st.mtimeMs);
  };
  for (const name of [
    "aicoop.yaml",
    "groups.yaml",
    "roles.yaml",
    "members.yaml",
    "triggers.yaml",
    "mcp_servers.yaml",
    "host_tools.yaml",
  ]) {
    visit(join(home, name), 0);
  }
  visit(join(home, "prompts"), 0);
  visit(join(home, "services"), 0);
  return latest;
}

async function daemonItems(ctx: CliContext, home: string): Promise<ReadinessItem[]> {
  const probe = await probeDaemon(ctx, home);
  if (!probe.running) {
    return [
      {
        id: "daemon",
        ok: false,
        message: "制御サーバー（daemon）は動いていません",
        hint: "aicoop start",
      },
    ];
  }
  const { info } = probe.client;
  const items: ReadinessItem[] = [
    {
      id: "daemon",
      ok: true,
      message: `制御サーバーが動いています（ポート ${info.port}、pid ${info.pid}）`,
    },
  ];
  try {
    const status = await probe.client.get<StatusResponse>("/status", { timeoutMs: 2000 });
    const loaded = Date.parse(status?.daemon?.config_loaded_at ?? "");
    if (!Number.isNaN(loaded) && latestConfigChange(home) > loaded) {
      items.push({
        id: "daemon:reload",
        ok: false,
        message: "制御サーバーが読んだあとに、設定ファイルが変わっています",
        hint: "aicoop reload で読み直してください",
      });
    }
  } catch {
    // 状態が取れなくても、動いていることは分かっている
  }
  return items;
}

export async function checkReadiness(
  ctx: CliContext,
  home: string,
  config: CompanyConfig | undefined,
): Promise<ReadinessItem[]> {
  const items = await checkHostReadiness(
    {
      platform: ctx.platform,
      arch: ctx.arch,
      which: (command) => ctx.deps.which(command),
      canAccess: (path) => ctx.deps.canAccess(path),
      now: () => ctx.deps.now(),
    },
    home,
    config,
  );
  items.push(...(await daemonItems(ctx, home)));
  return items;
}
