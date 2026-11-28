/**
 * `aicoop run <member> --purpose <文> --done-when <文> [...]`（9.1、5.5.1 の manual）：POST /tasks。
 * `--wait` なら、終わるまで GET /tasks/{id} を見て、結果を出す。
 */
import type {
  CreateTaskRequest,
  CreateTaskResponse,
  GetTaskResponse,
  TaskView,
} from "@aicoop/daemon";
import { ID_PATTERN, isTerminalTaskStatus } from "@aicoop/shared";
import { ApiRequestError, apiFailure, DaemonClient } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { CliError, UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { readTimezone, requireInitialized } from "../home.ts";
import { taskStatusLabel } from "../ui/labels.ts";
import { renderTaskDetail } from "../ui/task.ts";
import { cleanLine } from "../ui/text.ts";
import { formatTime } from "../ui/time.ts";
import { interruption, memberHints } from "./common.ts";

/** 5.5.5：時間制限は 1〜55 分 */
const MAX_TIMEOUT = 55;
const POLL_MS = 2000;

function text(value: string | boolean | undefined, option: string): string | undefined {
  if (value === undefined) return undefined;
  const s = String(value);
  if (s.trim() === "")
    throw new UsageError(`${option} が空です`, [`${option} "<文>" の形で書いてください`]);
  return s;
}

function timeoutMinutes(value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  const s = String(value).trim().normalize("NFKC");
  if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > MAX_TIMEOUT) {
    throw new UsageError(
      `--timeout は 1〜${MAX_TIMEOUT} の分の数にしてください（いまの値：${String(value).slice(0, 20)}）`,
      [
        "55分より長くできないのは、実行のたびに発行するトークンの有効期限が1時間だからです（設計書 5.5.5）",
      ],
    );
  }
  return Number(s);
}

export async function run(input: CommandInput): Promise<number> {
  const { home, values, positionals, out, ctx } = input;
  const member = (positionals[0] ?? "").trim();
  if (!ID_PATTERN.test(member)) {
    throw new UsageError(`社員の ID として読めません：${member.slice(0, 40)}`, [
      "社員の ID は、英小文字・数字・ハイフンで1〜40文字です（members.yaml の行の先頭のキー）",
      ...memberHints(home, member),
    ]);
  }
  const body: CreateTaskRequest = {
    member,
    purpose: text(values.purpose, "--purpose") as string,
    done_when: text(values["done-when"], "--done-when") as string,
    ...(values.context !== undefined && { context: String(values.context) }),
    ...(values.thread !== undefined && { thread: text(values.thread, "--thread") as string }),
    ...(values.timeout !== undefined && {
      timeout_minutes: timeoutMinutes(values.timeout) as number,
    }),
  };
  requireInitialized(home);

  const client = DaemonClient.connect(ctx, home);
  let created: TaskView;
  try {
    created = (await client.post<CreateTaskResponse>("/tasks", body)).task;
  } catch (e) {
    if (e instanceof ApiRequestError && e.body?.error === "unknown_member") {
      throw new CliError(EXIT.failure, e.body.message, memberHints(home, member));
    }
    if (e instanceof ApiRequestError && e.body?.error === "invalid_input") {
      throw new UsageError(e.body.message, ["くわしくは aicoop run --help"]);
    }
    throw apiFailure(e, home);
  }

  if (values.wait !== true) {
    if (values.json === true) {
      out.line(JSON.stringify(created, null, 2));
      return EXIT.ok;
    }
    const style = out.style;
    const next: [string, string][] = [
      [`aicoop logs ${created.id} --follow`, "実行の記録を見る"],
      ["aicoop tasks", "タスクの一覧"],
      [`aicoop cancel ${created.id}`, "取り消す"],
    ];
    const width = Math.max(...next.map(([c]) => c.length));
    out.lines([
      `${style.green("✓")} タスクを作りました：${style.bold(created.id)}`,
      `    社員  ${cleanLine(created.member_id)}（部署 ${cleanLine(created.group_id)}）`,
      `    目的  ${cleanLine(created.purpose)}`,
      `    状態  ${taskStatusLabel(created.status, style)}`,
      "",
      style.bold("次に"),
      ...next.map(([c, note]) => `  ${style.cyan(c.padEnd(width))}  ${note}`),
    ]);
    return EXIT.ok;
  }
  return waitForTask(input, client, created);
}

async function waitForTask(
  input: CommandInput,
  client: DaemonClient,
  created: TaskView,
): Promise<number> {
  const { home, values, out, err, ctx } = input;
  const tz = await readTimezone(home);
  const stop = interruption(ctx);
  err.line(
    `タスク ${created.id} を作りました。終わるまで待ちます（Ctrl+C で待つのをやめます。タスクは止まりません）`,
  );
  let last = "";
  let task = created;
  try {
    for (;;) {
      if (task.status !== last) {
        last = task.status;
        // 5.4.6：利用枠で止まったら、再開する予定の時刻（再開予定時刻 + 60秒）を添える。そのあいだも待ち続ける
        const retry =
          task.status === "waiting_limit" && task.retry_at
            ? `（${formatTime(task.retry_at, tz)} に再開する予定）`
            : "";
        err.line(
          `  ${formatTime(ctx.deps.now().toISOString(), tz, { timeOnly: true })} ${taskStatusLabel(task.status, err.style)}${retry}`,
        );
      }
      if (isTerminalTaskStatus(task.status)) break;
      await stop.sleep(POLL_MS);
      if (stop.interrupted) {
        err.line(
          `待つのをやめました。タスク ${task.id} は動き続けます（aicoop logs ${task.id} --follow で見られます）`,
        );
        return EXIT.interrupted;
      }
      try {
        task = (await client.get<GetTaskResponse>(`/tasks/${task.id}`)).task;
      } catch (e) {
        throw apiFailure(e, home);
      }
    }
  } finally {
    stop.dispose();
  }
  if (values.json === true) out.line(JSON.stringify(task, null, 2));
  else out.lines(renderTaskDetail(task, tz, out.style));
  return task.status === "done" ? EXIT.ok : EXIT.failure;
}
