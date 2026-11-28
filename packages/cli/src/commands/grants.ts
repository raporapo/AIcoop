/**
 * `aicoop grants [--status <状態>[,<状態>...]] [--limit <件数>] [--json]`：一時権限（申請を含む）の一覧
 * （GET /grants。新しい順。5.7.3）。
 *
 * 承認・却下はしない（9.1・P-4）。オーナーの承認待ちのものは、承認アプリ（パスキーの署名）で決めるよう案内する。
 */
import type { ListGrantsResponse } from "@aicoop/daemon";
import { apiFailure, DaemonClient } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { EXIT } from "../exit-codes.ts";
import { readTimezone, requireInitialized } from "../home.ts";
import { approvalHint, grantParamsText, renderItemList } from "../ui/holds.ts";
import {
  DECISION_SHORT_LABELS,
  decisionStatusLabel,
  GRANT_STATUS_LABELS,
  GRANT_STATUSES,
} from "../ui/labels.ts";
import { cleanLine } from "../ui/text.ts";
import { formatTime } from "../ui/time.ts";
import { parseLimitOption, parseStatusOption } from "./common.ts";
import { approverUrl } from "./holds.ts";

export async function run(input: CommandInput): Promise<number> {
  const { home, values, out, ctx } = input;
  const statuses =
    values.status !== undefined
      ? parseStatusOption(String(values.status), GRANT_STATUSES, [
          GRANT_STATUS_LABELS,
          DECISION_SHORT_LABELS,
        ])
      : undefined;
  const limit = values.limit !== undefined ? parseLimitOption(String(values.limit)) : undefined;
  requireInitialized(home);

  const query = new URLSearchParams();
  if (statuses) query.set("status", statuses.join(","));
  if (limit !== undefined) query.set("limit", String(limit));
  const qs = query.toString();
  const client = DaemonClient.connect(ctx, home);
  let body: ListGrantsResponse;
  try {
    body = await client.get<ListGrantsResponse>(`/grants${qs === "" ? "" : `?${qs}`}`);
  } catch (e) {
    throw apiFailure(e, home);
  }
  if (values.json === true) {
    out.line(JSON.stringify(body, null, 2));
    return EXIT.ok;
  }
  const grants = body.grants;
  const style = out.style;
  if (grants.length === 0) {
    out.line(statuses ? `${statuses.join("・")} の一時権限はありません` : "一時権限はありません");
    return EXIT.ok;
  }
  const tz = await readTimezone(home);
  const t = (iso: string | null) => (iso === null ? "—" : formatTime(iso, tz, { noYear: true }));
  out.lines(
    renderItemList(
      [
        { header: "ID" },
        { header: "状態" },
        { header: "操作" },
        { header: "時間" },
        { header: "期限" },
      ],
      grants.map((g) => ({
        cells: [
          cleanLine(g.id),
          decisionStatusLabel(g.status, style, true),
          `${cleanLine(g.operation)}${g.mode === "hold" ? "（保留）" : ""}`,
          `${g.duration_hours}時間`,
          t(g.expires_at),
        ],
        detail: `${cleanLine(g.member_id)}：${grantParamsText(g)}・理由 ${cleanLine(g.reason)}${g.manager_comment === null ? "" : `・部長のコメント ${cleanLine(g.manager_comment)}`}`,
      })),
      { style, width: out.columns },
    ),
  );
  out.line(
    style.dim(
      `${grants.length}件（新しい順。時刻は ${tz}）。期限は、承認されてから「時間」が過ぎるまで`,
    ),
  );
  if (grants.some((g) => g.status === "pending_owner")) {
    out.lines(["", ...approvalHint(approverUrl(client.info.port), style)]);
  }
  return EXIT.ok;
}
