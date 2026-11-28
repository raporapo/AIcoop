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
