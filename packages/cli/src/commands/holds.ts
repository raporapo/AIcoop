/**
 * `aicoop holds [--status <状態>[,<状態>...]] [--limit <件数>] [--json]`：保留の一覧（GET /holds。新しい順）。
 * `aicoop holds <hold_id> [--full] [--json]`：保留の詳細（GET /holds/{id}）。要約・部長のコメント・状態・期限・
 * 元のリクエスト（本文はテキストなら先頭だけ、`--full` で全部）・再送の結果。
 *
 * 承認・却下はしない（9.1・P-4）。オーナーの承認待ちのものは、承認アプリ（パスキーの署名）で決めるよう案内する。
 */
import { appOrigin, type GetHoldResponse, type ListHoldsResponse } from "@aicoop/daemon";
import { isId } from "@aicoop/shared";
import { ApiRequestError, apiFailure, DaemonClient } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { CliError, UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { readTimezone, requireInitialized } from "../home.ts";
import { approvalHint, holdSummaryLine, renderHoldDetail, renderItemList } from "../ui/holds.ts";
import {
  DECISION_SHORT_LABELS,
  decisionStatusLabel,
  HOLD_STATUS_LABELS,
  HOLD_STATUSES,
} from "../ui/labels.ts";
import { cleanLine } from "../ui/text.ts";
import { formatTime } from "../ui/time.ts";
import { parseLimitOption, parseStatusOption } from "./common.ts";

/** 承認アプリの画面（5.8 の1。パスキーの RP ID は localhost なので、127.0.0.1 ではなく localhost） */
export function approverUrl(port: number): string {
  return `${appOrigin(port)}/app/`;
}

export async function run(input: CommandInput): Promise<number> {
  const id = input.positionals[0];
  if (id !== undefined) return runDetail(input, id);
  return runList(input);
}

async function runList(input: CommandInput): Promise<number> {
  const { home, values, out, ctx } = input;
  if (values.full === true) {
    throw new UsageError("--full は、1件の詳細（aicoop holds <hold_id>）で使います");
  }
  const statuses =
    values.status !== undefined
      ? parseStatusOption(String(values.status), HOLD_STATUSES, [
          HOLD_STATUS_LABELS,
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
  let body: ListHoldsResponse;
  try {
    body = await client.get<ListHoldsResponse>(`/holds${qs === "" ? "" : `?${qs}`}`);
  } catch (e) {
    throw apiFailure(e, home);
  }
  if (values.json === true) {
    out.line(JSON.stringify(body, null, 2));
    return EXIT.ok;
  }
  const holds = body.holds;
  const style = out.style;
  if (holds.length === 0) {
    out.line(statuses ? `${statuses.join("・")} の保留はありません` : "保留はありません");
    return EXIT.ok;
  }
  const tz = await readTimezone(home);
  out.lines(
    renderItemList(
      [{ header: "ID" }, { header: "状態" }, { header: "操作" }, { header: "期限" }],
      holds.map((h) => ({
        cells: [
          cleanLine(h.id),
          decisionStatusLabel(h.status, style, true),
          cleanLine(h.operation),
          formatTime(h.expires_at, tz, { noYear: true }),
        ],
        detail: `${cleanLine(h.member_id)}：${holdSummaryLine(h)}`,
      })),
      { style, width: out.columns },
    ),
  );
  out.line(style.dim(`${holds.length}件（新しい順。時刻は ${tz}）。詳細は aicoop holds <ID>`));
  if (holds.some((h) => h.status === "pending_owner")) {
    out.lines(["", ...approvalHint(approverUrl(client.info.port), style)]);
  }
  return EXIT.ok;
}

function requireHoldId(value: string): string {
  const v = value.trim();
  const ok: boolean = isId(v, "hold");
  if (!ok) {
    throw new UsageError(`保留の ID として読めません：${cleanLine(v.slice(0, 40))}`, [
      "h_ で始まる27文字の ID です（aicoop holds で確かめられます）",
    ]);
  }
  return v;
}

async function runDetail(input: CommandInput, raw: string): Promise<number> {
  const { home, values, out, ctx } = input;
  const id = requireHoldId(raw);
  if (values.status !== undefined || values.limit !== undefined) {
    throw new UsageError("--status・--limit は、一覧（aicoop holds）で使います");
  }
  requireInitialized(home);
  const client = DaemonClient.connect(ctx, home);
  let body: GetHoldResponse;
  try {
    body = await client.get<GetHoldResponse>(`/holds/${id}`);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 404) {
      throw new CliError(EXIT.failure, `保留 ${id} はありません`, ["保留の一覧：aicoop holds"]);
    }
    throw apiFailure(e, home);
  }
  if (values.json === true) {
    out.line(JSON.stringify(body, null, 2));
    return EXIT.ok;
  }
  const tz = await readTimezone(home);
  out.lines(
    renderHoldDetail(body.hold, tz, out.style, {
      full: values.full === true,
      appUrl: approverUrl(client.info.port),
    }),
  );
  return EXIT.ok;
}
