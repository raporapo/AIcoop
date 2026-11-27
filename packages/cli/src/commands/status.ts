/**
 * `aicoop status`（9.1）：GET /status。箱・タスクの件数・利用枠・トリガーの次の時刻・警告。
 */
import type { StatusResponse } from "@aicoop/daemon";
import { TASK_STATUSES } from "@aicoop/shared";
import { apiFailure, DaemonClient } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { EXIT } from "../exit-codes.ts";
import { readTimezone, requireInitialized } from "../home.ts";
import { renderIssues } from "../ui/issues.ts";
import { TASK_STATUS_LABELS, TRIGGER_LABELS, USAGE_LABELS } from "../ui/labels.ts";
import { renderTable } from "../ui/table.ts";
import { cleanLine } from "../ui/text.ts";
import { formatTime } from "../ui/time.ts";

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
  const label = (text: string) => style.bold(text.padEnd(0));
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
    const parts = [USAGE_LABELS[usage.status] ?? usage.status];
    if (usage.utilization !== null) parts.push(`${Math.round(usage.utilization * 100)}% 使用`);
    if (usage.resets_at) parts.push(`${t(usage.resets_at)} に戻る`);
    if (usage.rate_limit_type) parts.push(usage.rate_limit_type);
    const text = parts.join("・");
    lines.push(
      `${label("利用枠")}  ${usage.status === "rejected" ? style.red(text) : usage.status === "allowed_warning" ? style.yellow(text) : text}`,
    );
  }
  lines.push(`${label("保留")}  承認待ち ${status.holds.pending}件`);

  if (status.triggers.length > 0) {
    lines.push("", label("トリガー"));
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
