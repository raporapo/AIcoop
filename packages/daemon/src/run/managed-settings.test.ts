import { describe, expect, it } from "vitest";
import { GATEWAY_MCP_URL, managedSettings, mcpConfig } from "./managed-settings.ts";

describe("5.3.8：vm の箱の Claude Code の管理設定（V-8）", () => {
  const settings = managedSettings() as Record<string, unknown>;

  it("マーケットプレイスの追加をすべて禁止する（プラグインを持ち込めない。5.3.7）", () => {
    expect(settings.strictKnownMarketplaces).toEqual([]);
  });

  it("MCP サーバーは道具ゲートだけを許す（管理設定の許可リストだけを使う）", () => {
    expect(settings.allowedMcpServers).toEqual([{ serverUrl: "http://aicoop.internal/*" }]);
    expect(settings.allowManagedMcpServersOnly).toBe(true);
    expect(settings.enableAllProjectMcpServers).toBe(false);
  });

  it("フックをすべて止める", () => {
    expect(settings.disableAllHooks).toBe(true);
  });

  it("不要な通信（テレメトリ・エラー報告など）を止める", () => {
    expect(settings.env).toEqual({
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    });
  });

  it("決めたキーのほかは書かない（知らないキーで設定を緩めない）", () => {
    expect(Object.keys(settings).sort()).toEqual(
      [
        "allowManagedMcpServersOnly",
        "allowedMcpServers",
        "disableAllHooks",
        "enableAllProjectMcpServers",
        "env",
        "strictKnownMarketplaces",
      ].sort(),
    );
  });

  it("呼ぶたびに新しいオブジェクトを返す（書き換えても次の実行に残らない）", () => {
    const a = managedSettings() as { env: Record<string, string> };
    a.env.DISABLE_TELEMETRY = "0";
    expect((managedSettings() as { env: Record<string, string> }).env.DISABLE_TELEMETRY).toBe("1");
  });
});

describe("5.3.1 の5：--mcp-config に渡す MCP の設定は、道具ゲート1つだけ", () => {
  it("aicoop という名前の Streamable HTTP のサーバー1つ。その実行のゲートのトークンを Authorization ヘッダーで渡す", () => {
    expect(mcpConfig("tok-123")).toEqual({
      mcpServers: {
        aicoop: {
          type: "http",
          url: "http://aicoop.internal/mcp",
          headers: { Authorization: "Bearer tok-123" },
        },
      },
    });
    expect(GATEWAY_MCP_URL).toBe("http://aicoop.internal/mcp");
  });
});
