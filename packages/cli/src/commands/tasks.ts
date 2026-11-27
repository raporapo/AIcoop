/**
 * `aicoop tasks [--status <状態>[,<状態>...]] [--limit <件数>]`（9.1）：GET /tasks。新しい順。
 */
import type { ListTasksResponse } from "@aicoop/daemon";
import { isTaskStatus, TASK_STATUSES, type TaskStatus } from "@aicoop/shared";
import { apiFailure, DaemonClient } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { readTimezone, requireInitialized } from "../home.ts";
import { suggest } from "../suggest.ts";
import { TASK_STATUS_LABELS, taskStatusLabel } from "../ui/labels.ts";
import { renderTable } from "../ui/table.ts";
import { cleanLine } from "../ui/text.ts";
import { formatTime } from "../ui/time.ts";

const MAX_LIMIT = 500;

/** `running,queued` のほか、日本語の呼び名（実行中・順番待ち）も受け付ける */
function parseStatuses(value: string): TaskStatus[] {
  const byLabel = new Map(Object.entries(TASK_STATUS_LABELS).map(([s, l]) => [l, s as TaskStatus]));
  const out: TaskStatus[] = [];
  for (const raw of value.split(/[,、，]/)) {
    const word = raw.trim().normalize("NFKC").toLowerCase();
    if (word === "") continue;
    const status = isTaskStatus(word) ? word : byLabel.get(raw.trim());
    if (status === undefined) {
      const close = suggest(word, TASK_STATUSES);
      throw new UsageError(`知らない状態です：${raw.trim().slice(0, 30)}`, [
        ...(close.length > 0 ? [`もしかして ${close.join("、")}`] : []),
        `状態：${TASK_STATUSES.join("・")}`,
      ]);
    }
    if (!out.includes(status)) out.push(status);
  }
  if (out.length === 0)
    throw new UsageError("--status が空です", [`状態：${TASK_STATUSES.join("・")}`]);
  return out;
}

function parseLimit(value: string): number {
  const s = value.trim().normalize("NFKC");
  if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > MAX_LIMIT) {
    throw new UsageError(
      `--limit は 1〜${MAX_LIMIT} の数にしてください（いまの値：${value.slice(0, 20)}）`,
    );
  }
  return Number(s);
}

export async function run(input: CommandInput): Promise<number> {
  const { home, values, out, ctx } = input;
  const statuses = values.status !== undefined ? parseStatuses(String(values.status)) : undefined;
  const limit = values.limit !== undefined ? parseLimit(String(values.limit)) : undefined;
  requireInitialized(home);

  const query = new URLSearchParams();
  if (statuses) query.set("status", statuses.join(","));
  if (limit !== undefined) query.set("limit", String(limit));
  const qs = query.toString();
  const client = DaemonClient.connect(ctx, home);
  let tasks: ListTasksResponse["tasks"];
  try {
    tasks = (await client.get<ListTasksResponse>(`/tasks${qs === "" ? "" : `?${qs}`}`)).tasks;
  } catch (e) {
    throw apiFailure(e, home);
  }

  if (values.json === true) {
    out.line(JSON.stringify(tasks, null, 2));
    return EXIT.ok;
  }
  const style = out.style;
  if (tasks.length === 0) {
    out.line(statuses ? `${statuses.join("・")} のタスクはありません` : "タスクはまだありません");
    out.line(
      `  仕事を頼むには：${style.cyan('aicoop run <member> --purpose "..." --done-when "..."')}`,
    );
    return EXIT.ok;
  }
  const tz = await readTimezone(home);
  out.lines(
    renderTable(
      [
        { header: "ID" },
        { header: "状態" },
        { header: "社員" },
        { header: "作成" },
        { header: "目的", flex: true },
      ],
      tasks.map((t) => [
        t.id,
        taskStatusLabel(t.status, style),
        cleanLine(t.member_id),
        formatTime(t.created_at, tz, { noYear: true }),
        cleanLine(t.purpose),
      ]),
      { style, width: out.columns },
    ),
  );
  out.line(style.dim(`${tasks.length}件（新しい順。時刻は ${tz}）。記録は aicoop logs <ID>`));
  return EXIT.ok;
}
