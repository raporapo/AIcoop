/**
 * 箱の中の Claude Code の管理設定（5.3.8）と、`--mcp-config` に渡す MCP の設定（5.3.1 の5）。
 *
 * キーの名前は Claude Code の公式ドキュメント（settings・MCP）で確かめたものだけを使う（16章 V-8）。
 * - `strictKnownMarketplaces: []`：マーケットプレイスの追加をすべて禁止する（プラグインを持ち込めない。5.3.7）
 * - `allowedMcpServers` と `allowManagedMcpServersOnly: true`：MCP サーバーは道具ゲートだけ
 * - `enableAllProjectMcpServers: false`：作業フォルダの `.mcp.json` を読み込まない
 * - `disableAllHooks: true`：管理設定に書くと、すべてのフックを止める
 * - `env`：不要な通信（テレメトリ・エラー報告など）を止める（5.2.7 の2）
 *
 * vm の箱では、実行ごとに `runtime/<run_id>/managed/managed-settings.json` に書き、
 * 箱の `/etc/claude-code/managed-settings.json` に読み取り専用でマウントする。
 */
import { GATEWAY_HOST } from "@aicoop/box-gondolin";

/** 箱の中から見た道具ゲートの URL（5.3.1 の2） */
export const GATEWAY_MCP_URL = `http://${GATEWAY_HOST}/mcp`;

/** MCP サーバーの名前（5.3.2：道具は `mcp__aicoop__<道具名>` で見える） */
export const GATEWAY_SERVER_NAME = "aicoop";

export function managedSettings(): Record<string, unknown> {
  return {
    strictKnownMarketplaces: [],
    allowedMcpServers: [{ serverUrl: `http://${GATEWAY_HOST}/*` }],
    allowManagedMcpServersOnly: true,
    enableAllProjectMcpServers: false,
    disableAllHooks: true,
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    },
  };
}

/**
 * `--mcp-config` に渡す MCP の設定。道具ゲート1つだけで、その実行のゲートのトークンを
 * `Authorization` ヘッダーで渡す（Claude Code の MCP の設定の `headers`）。
 * トークンは `${VAR}` の展開を使わずに書く（展開できない値を空にされないように）。
 */
export function mcpConfig(gatewayToken: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(gatewayToken)) {
    throw new TypeError("道具ゲートのトークンの形が不正です");
  }
  return {
    mcpServers: {
      [GATEWAY_SERVER_NAME]: {
        type: "http",
        url: GATEWAY_MCP_URL,
        headers: { Authorization: `Bearer ${gatewayToken}` },
      },
    },
  };
}
