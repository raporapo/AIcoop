/**
 * `aicoop status`（9.1）：GET /status。箱・タスクの件数・利用枠・トリガーの次の時刻・警告。
 * 加えて、決まっていない保留・一時権限の申請（GET /holds・GET /grants）を数え、オーナーの承認待ちがあれば
 * 承認アプリで決めるよう案内する（承認・却下のコマンドはない。9.1・P-4）。
 */
import type { ListGrantsResponse, ListHoldsResponse, StatusResponse } from "@aicoop/daemon";
import { TASK_STATUSES, USAGE_RETRY_DELAY_MS } from "@aicoop/shared";
import { ApiRequestError, apiFailure, DaemonClient } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { EXIT } from "../exit-codes.ts";
import { readTimezone, requireInitialized } from "../home.ts";
import { approvalHint } from "../ui/holds.ts";
import { renderIssues } from "../ui/issues.ts";
import { TASK_STATUS_LABELS, TRIGGER_LABELS, USAGE_LABELS } from "../ui/labels.ts";
import { renderTable } from "../ui/table.ts";
import { cleanLine, padEnd } from "../ui/text.ts";
import { formatTime } from "../ui/time.ts";
import { approverUrl } from "./holds.ts";

interface PendingDecisions {
  readonly ownerHolds: number;
  readonly ownerGrants: number;
  /** 部長のレビューを待っている保留と申請 */
  readonly manager: number;
}

/** 決まっていない保留・一時権限の申請を数える。一覧の道がない daemon なら null */
async function pendingDecisions(client: DaemonClient): Promise<PendingDecisions | null> {
  const query = "?status=pending_manager,pending_owner&limit=500";
  try {
    const [holds, grants] = await Promise.all([
      client.get<ListHoldsResponse>(`/holds${query}`),
      client.get<ListGrantsResponse>(`/grants${query}`),
    ]);
    const owner = (items: readonly { status: string }[]) =>
      items.filter((x) => x.status === "pending_owner").length;
    const manager = (items: readonly { status: string }[]) =>
      items.filter((x) => x.status === "pending_manager").length;
    return {
      ownerHolds: owner(holds.holds),
      ownerGrants: owner(grants.grants),
      manager: manager(holds.holds) + manager(grants.grants),
    };
  } catch (e) {
    if (e instanceof ApiRequestError) return null;
    throw e;
  }
}

export async function run(input: CommandInput): Promise<number> {
  const { home, values, out, ctx } = input;
  requireInitialized(home);
  const client = DaemonClient.connect(ctx, home);
  let status: StatusResponse;
  try {
    status = await client.get<StatusResponse>("/status");
  } catch (e) {
    throw apiFailure(e, home);
  }
  if (values.json === true) {
    out.line(JSON.stringify(status, null, 2));
    return EXIT.ok;
  }

  const tz = await readTimezone(home);
  const style = out.style;
  const t = (iso: string | null | undefined) => (iso ? formatTime(iso, tz) : "—");
  /** 見出しの幅をそろえる（いちばん長い「制御サーバー」に合わせる） */
  const label = (text: string) => style.bold(padEnd(text, 12));
  const lines: string[] = [];

  lines.push(`${style.bold("AIcoop")}  ${cleanLine(status.company.name)}（${status.company.id}）`);
  lines.push(
    `${label("制御サーバー")}  動いています（ポート ${status.daemon.port}、pid ${status.daemon.pid}、${t(status.daemon.started_at)} から。設定は ${t(status.daemon.config_loaded_at)} に読みました）`,
  );

  const running = status.boxes.running;
  lines.push("", `${label("箱")}  ${running.length} / ${status.boxes.max_concurrent} 動いています`);
  if (running.length > 0) {
    lines.push(
      ...renderTable(
        [
          { header: "  部署" },
          { header: "社員" },
          { header: "タスク" },
          { header: "箱" },
          { header: "開始" },
        ],
        running.map((b) => [
          `  ${cleanLine(b.group_id)}`,
          cleanLine(b.member_id),
          b.task_id,
          b.box_kind,
          t(b.started_at),
        ]),
        { style, width: out.columns },
      ),
    );
  }

  const counts = TASK_STATUSES.filter((s) => (status.tasks[s] ?? 0) > 0).map(
    (s) => `${TASK_STATUS_LABELS[s]} ${status.tasks[s]}`,
  );
  lines.push("", `${label("タスク")}  ${counts.length > 0 ? counts.join("・") : "なし"}`);

  const usage = status.usage;
  if (usage === null) {
    lines.push(`${label("利用枠")}  まだ分かりません（最初の実行のあとに分かります）`);
  } else {
    // 止まった（rejected）あとに、再開予定時刻 + 60秒を過ぎていれば、制御サーバーはもうタスクを始めている
    // （5.5.4 の4）。状態は次の rate_limit_event まで rejected のままなので、古い状態だと分かるように出す
    const resetsMs = usage.resets_at ? Date.parse(usage.resets_at) : Number.NaN;
    const resumed =
      usage.status === "rejected" &&
      !Number.isNaN(resetsMs) &&
      ctx.deps.now().getTime() >= resetsMs + USAGE_RETRY_DELAY_MS;
    const parts = [
      resumed
        ? "止まっていた（再開予定時刻を過ぎたので、タスクを始めています）"
        : (USAGE_LABELS[usage.status] ?? usage.status),
    ];
    if (usage.utilization !== null) parts.push(`${Math.round(usage.utilization * 100)}% 使用`);
    if (usage.resets_at) parts.push(`${t(usage.resets_at)} に戻る${resumed ? "予定でした" : ""}`);
    if (usage.rate_limit_type) parts.push(usage.rate_limit_type);
    const text = parts.join("・");
    lines.push(
      `${label("利用枠")}  ${usage.status === "rejected" && !resumed ? style.red(text) : usage.status === "allowed_warning" || resumed ? style.yellow(text) : text}`,
    );
  }
  const pending = await pendingDecisions(client);
  if (pending === null) {
    // 保留・一時権限の一覧を返さない daemon（古い版）：status の件数だけ
    lines.push(`${label("承認待ち")}  承認待ち ${status.holds.pending}件（保留）`);
  } else {
    const owner = pending.ownerHolds + pending.ownerGrants;
    const parts = [
      owner > 0
        ? style.yellow(
            `オーナーの承認待ち ${owner}件（保留 ${pending.ownerHolds}・一時権限 ${pending.ownerGrants}）`,
          )
        : "オーナーの承認待ち なし",
    ];
    if (pending.manager > 0) parts.push(`部長のレビュー中 ${pending.manager}件`);
    lines.push(`${label("承認待ち")}  ${parts.join("・")}`);
    if (owner > 0) {
      const indent = " ".repeat(14);
      lines.push(...approvalHint(approverUrl(status.daemon.port), style, indent));
      lines.push(`${indent}${style.dim("中身は aicoop holds・aicoop grants で見られます")}`);
    }
  }

  if (status.triggers.length > 0) {
    lines.push("", style.bold("トリガー"));
    lines.push(
      ...renderTable(
        [{ header: "  ID" }, { header: "種類" }, { header: "社員" }, { header: `次（${tz}）` }],
        status.triggers.map((tr) => [
          `  ${cleanLine(tr.id)}`,
          TRIGGER_LABELS[tr.type] ?? cleanLine(tr.type),
          cleanLine(tr.member),
          tr.enabled ? t(tr.next_run_at) : style.dim("止めてある"),
        ]),
        { style, width: out.columns },
      ),
    );
  }

  if (status.warnings.length > 0) {
    lines.push("", ...renderIssues(status.warnings, style));
  }
  out.lines(lines);
  return EXIT.ok;
}
