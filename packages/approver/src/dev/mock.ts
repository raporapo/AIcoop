/**
 * 開発用（`pnpm --filter @aicoop/approver dev` で `http://localhost:5173/app/?mock`）：
 * 制御サーバーなしで画面を見るための偽の API とパスキー。本番のビルドには入らない（main.tsx が
 * `import.meta.env.DEV` のときだけ読む）。
 */
import type { Passkeys } from "../lib/passkeys.ts";
import {
  auditEntry,
  holdView,
  MAIL_HOLD,
  MANAGER_HOLD,
  ME,
  MERGE_HOLD,
  OTHER_DEVICE,
  PUSH_GRANT,
  status,
  THIS_DEVICE,
  task,
  USAGE,
} from "../testing/fixtures.ts";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function mockFetch(): typeof fetch {
  const holds = [
    {
      ...MAIL_HOLD,
      summary: {
        ...(MAIL_HOLD.summary as object),
        subject: "請求書\u{202E}fdp.exe のご確認",
      },
    },
    MERGE_HOLD,
  ];
  return async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    const hold = holds.find((h) => path === `/holds/${h.id}`);
    if (hold !== undefined) return json(200, { hold });
    switch (`${method} ${path}`) {
      case "GET /auth/me":
        return json(200, ME);
      case "GET /holds":
        return json(200, { holds: [...holds.map(holdView), MANAGER_HOLD] });
      case "GET /grants":
        return json(200, { grants: [PUSH_GRANT] });
      case "GET /status":
        return json(200, status());
      case "GET /tasks":
        return json(200, {
          tasks: [task(), task({ id: "t_01JQ0000000000000000000011", status: "running" })],
        });
      case "GET /usage":
        return json(200, { usage: USAGE });
      case "GET /devices":
        return json(200, { devices: [THIS_DEVICE, OTHER_DEVICE] });
      case "GET /audit": {
        const after = Number(url.searchParams.get("after") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const all = Array.from({ length: 30 }, (_, i) => auditEntry(i + 1));
        return json(200, { entries: all.filter((e) => e.seq > after).slice(0, limit) });
      }
      // 設定の画面と資格の画面（5.14 の4・5）
      case "GET /config/files":
        return json(200, {
          files: [
            { path: "aicoop.yaml", size: 180, sha256: "a".repeat(64), modified_at: ME.expires_at },
            { path: "groups.yaml", size: 420, sha256: "b".repeat(64), modified_at: ME.expires_at },
            {
              path: "prompts/company.md",
              size: 64,
              sha256: "c".repeat(64),
              modified_at: ME.expires_at,
            },
          ],
        });
      case "GET /config/files/groups.yaml":
        return json(200, {
          path: "groups.yaml",
          content: "groups:\n  dev:\n    name: 開発部\n    box: vm\n",
          sha256: "b".repeat(64),
        });
      case "POST /config/changes": {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          files: Array<{ path: string; content: string; base_sha256: string | null }>;
        };
        const file = body.files[0];
        return json(201, {
          id: "x_01JQ0000000000000000000009",
          summary: {
            files: [
              {
                path: file?.path ?? "",
                before_sha256: file?.base_sha256 ?? null,
                after_sha256: "d".repeat(64),
                diff: `--- a/${file?.path}\n+++ b/${file?.path}\n@@ -1,4 +1,4 @@\n groups:\n   dev:\n-    name: 開発部\n+    name: 開発本部\n     box: vm\n`,
              },
            ],
          },
          warnings: [
            { code: "W-001", message: "役職の allow に、部署の ceiling にない操作があります" },
          ],
          expires_at: ME.expires_at,
        });
      }
      case "GET /secrets":
        return json(200, {
          secrets: [
            { id: "anthropic", kind: "anthropic_oauth", updated_at: ME.expires_at },
            { id: "github", kind: "static_token", updated_at: ME.expires_at },
          ],
        });
      case "POST /secrets/changes":
        return json(201, {
          id: "x_01JQ0000000000000000000008",
          summary: { id: "github", kind: "static_token", action: "replace" },
          expires_at: ME.expires_at,
        });
      // 準備の画面（5.14 の3）
      case "GET /setup":
        return json(200, {
          ready: false,
          steps: [
            {
              id: "company",
              ok: false,
              items: [
                {
                  id: "company:name",
                  ok: false,
                  message: "会社の名前が、雛形の「わたしの会社」のままです",
                },
              ],
            },
            {
              id: "claude",
              ok: true,
              items: [
                {
                  id: "secret:anthropic",
                  ok: true,
                  message:
                    "Claude（Anthropic）の資格（anthropic、anthropic_oauth）が登録されています",
                },
              ],
            },
            {
              id: "github",
              ok: false,
              items: [
                {
                  id: "placeholder:your-org",
                  ok: false,
                  message: "雛形の「your-org」が残っています（groups.dev.ceiling.0）",
                },
              ],
            },
            {
              id: "image",
              ok: false,
              items: [{ id: "image:base", ok: false, message: "vm の箱のイメージがありません" }],
            },
          ],
          others: [],
          company: { name: "わたしの会社" },
          github: {
            secret_id: "github",
            secret_kind: "static_token",
            repositories: [],
            placeholder: true,
          },
          claude_login: null,
          image_build: null,
        });
      case "POST /setup/claude-login":
        return json(201, {
          id: "6f0e2f6e-1d2a-4b9b-8f53-2a0f8d5c1e77",
          state: "waiting_code",
          url: "https://claude.ai/oauth/authorize?mock",
          started_at: ME.expires_at,
          expires_at: ME.expires_at,
          message: null,
          change: null,
        });
      case "GET /images/build":
        return json(200, { build: null });
      default:
        return json(404, {
          error: "not_found",
          message: `偽の API にない道です：${method} ${path}`,
        });
    }
  };
}

export const mockPasskeys: Passkeys = {
  supported: () => true,
  authenticate: async () => ({ id: "mock" }),
  register: async () => ({ id: "mock" }),
};
