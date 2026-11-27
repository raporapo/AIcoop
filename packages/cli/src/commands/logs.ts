/**
 * `aicoop logs <task_id> [--follow] [--raw]`（9.1、11.5）。
 *
 * GET /tasks/{id} の実行ごとの log_path（stream-json）を、CLI が直接読む（同じホストにあるため）。
 * - log_path は `~/.aicoop/logs/runs/` の中のふつうのファイルだけを読む（それ以外は読まない）
 * - --follow では、書き終わった行だけを出す（書きかけの行は、改行が来るまで待つ）
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve, sep } from "node:path";
import { aicoopPaths, type GetTaskResponse, type RunView, type TaskView } from "@aicoop/daemon";
import { isTerminalTaskStatus } from "@aicoop/shared";
import { apiFailure, DaemonClient } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { EXIT } from "../exit-codes.ts";
import { readTimezone, requireInitialized } from "../home.ts";
import { createLogFormatter, type LogFormatter } from "../logs/format.ts";
import { taskStatusLabel } from "../ui/labels.ts";
import type { Printer } from "../ui/printer.ts";
import { renderTaskDetail } from "../ui/task.ts";
import { cleanLine } from "../ui/text.ts";
import { formatTime } from "../ui/time.ts";
import { interruption, requireTaskId } from "./common.ts";

const POLL_MS = 400;
/** タスクの状態は、ファイルを見る回数のこの回に1回だけ聞く */
const TASK_EVERY = 4;
const NEWLINE = 0x0a;

/** 1つの記録のファイルの、読んだところ */
class Tail {
  readonly path: string;
  private offset = 0;
  private partial: Buffer = Buffer.alloc(0);

  constructor(path: string) {
    this.path = path;
  }

  /** 増えた分のうち、改行まで書き終わった行。`flush` なら書きかけの行も。ファイルがなければ null */
  read(flush = false): string[] | null {
    let fd: number;
    try {
      fd = openSync(this.path, "r");
    } catch {
      return null;
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        // 切り詰められた（作り直された）
        this.offset = 0;
        this.partial = Buffer.alloc(0);
      }
      const length = size - this.offset;
      let data = this.partial;
      if (length > 0) {
        const buf = Buffer.alloc(length);
        const read = readSync(fd, buf, 0, length, this.offset);
        this.offset += read;
        data = Buffer.concat([data, buf.subarray(0, read)]);
      }
      const last = data.lastIndexOf(NEWLINE);
      let complete: Buffer;
      if (flush) {
        complete = data;
        this.partial = Buffer.alloc(0);
      } else {
        complete = last >= 0 ? data.subarray(0, last + 1) : Buffer.alloc(0);
        this.partial = last >= 0 ? data.subarray(last + 1) : data;
      }
      const text = complete.toString("utf8");
      return text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);
    } finally {
      closeSync(fd);
    }
  }
}

function isUnder(base: string, path: string, caseInsensitive: boolean): boolean {
  const b = resolve(base) + sep;
  const p = resolve(path);
  return caseInsensitive ? p.toLowerCase().startsWith(b.toLowerCase()) : p.startsWith(b);
}

interface View {
  readonly out: Printer;
  readonly err: Printer;
  readonly raw: boolean;
  readonly tz: string;
  readonly formatter: LogFormatter;
}

function printLines(view: View, lines: readonly string[]): void {
  for (const line of lines) {
    if (view.raw) {
      // パイプならそのまま。端末なら制御符号を消して出す
      view.out.line(view.out.isTTY ? cleanLine(line) : line);
    } else {
      view.out.lines(view.formatter.format(line));
    }
  }
}

function runHeader(view: View, run: RunView, index: number): void {
  if (view.raw) return;
  const style = view.out.style;
  const started = formatTime(run.started_at, view.tz, { seconds: true });
  view.out.line(
    style.bold(
      `── 実行 ${index + 1}：${run.id}（${run.box_kind}・部署 ${cleanLine(run.group_id)}）${started} から ──`,
    ),
  );
}

function runFooter(view: View, run: RunView): void {
  if (view.raw || run.ended_at === null) return;
  const parts = [
    `${formatTime(run.ended_at, view.tz, { seconds: true })} に終わりました`,
    run.end_reason ?? undefined,
    run.exit_code !== null ? `終了コード ${run.exit_code}` : undefined,
  ].filter(Boolean);
  view.out.line(view.out.style.dim(`── ${parts.join("・")} ──`));
  view.out.line("");
}

export async function run(input: CommandInput): Promise<number> {
  const { home, values, positionals, out, err, ctx } = input;
  const id = requireTaskId(positionals[0]);
  requireInitialized(home);
  const paths = aicoopPaths(home);
  const client = DaemonClient.connect(ctx, home);
  const fetchTask = async (): Promise<GetTaskResponse> => {
    try {
      return await client.get<GetTaskResponse>(`/tasks/${id}`);
    } catch (e) {
      throw apiFailure(e, home);
    }
  };

  const tz = await readTimezone(home);
  const view: View = {
    out,
    err,
    raw: values.raw === true,
    tz,
    formatter: createLogFormatter({ timeZone: tz, style: out.style }),
  };
  const follow = values.follow === true;
  const tails = new Map<string, Tail | null>();

  /** 読んでよい記録か。だめなら理由を出して null */
  const tailFor = (run: RunView): Tail | null => {
    if (tails.has(run.id)) return tails.get(run.id) ?? null;
    let tail: Tail | null = null;
    if (
      !isUnder(
        paths.runLogsDir,
        run.log_path,
        ctx.platform === "win32" || ctx.platform === "darwin",
      )
    ) {
      err.line(
        `${err.style.yellow("注意：")}実行 ${run.id} の記録の場所が ${paths.runLogsDir} の外なので、読みません`,
      );
    } else {
      let symlink = false;
      try {
        symlink = lstatSync(run.log_path).isSymbolicLink();
      } catch {
        // まだない（これから書かれる）
      }
      if (symlink)
        err.line(
          `${err.style.yellow("注意：")}実行 ${run.id} の記録がシンボリックリンクなので、読みません`,
        );
      else tail = new Tail(run.log_path);
    }
    tails.set(run.id, tail);
    return tail;
  };

  let { task, runs } = await fetchTask();

  if (!follow) {
    if (runs.length === 0) {
      err.line(
        `タスク ${id} はまだ実行されていません（${taskStatusLabel(task.status, err.style)}）`,
      );
      err.line(`  始まるのを待って見るなら：aicoop logs ${id} --follow`);
      return EXIT.ok;
    }
    runs.forEach((r, i) => {
      runHeader(view, r, i);
      const tail = tailFor(r);
      const lines = tail?.read(r.ended_at !== null);
      if (tail && lines === null) {
        err.line(`  記録のファイルがありません：${r.log_path}`);
      } else if (lines) {
        printLines(view, lines);
      }
      runFooter(view, r);
    });
    finish(view, task);
    return EXIT.ok;
  }

  const stop = interruption(ctx);
  const printed = new Set<string>();
  let announcedWaiting = false;
  try {
    for (let tick = 0; ; tick++) {
      if (runs.length === 0 && !announcedWaiting) {
        announcedWaiting = true;
        err.line(
          `タスク ${id} はまだ始まっていません（${taskStatusLabel(task.status, err.style)}）。始まるのを待っています…（Ctrl+C で止めます）`,
        );
      }
      runs.forEach((r, i) => {
        if (!printed.has(r.id)) {
          // 前の実行の残りを出しきってから、次の実行に移る
          const prev = runs[i - 1];
          if (prev) {
            const rest = tailFor(prev)?.read(true);
            if (rest) printLines(view, rest);
            runFooter(view, prev);
          }
          printed.add(r.id);
          runHeader(view, r, i);
        }
        const lines = tailFor(r)?.read(false);
        if (lines) printLines(view, lines);
      });
      if (isTerminalTaskStatus(task.status)) {
        const lastRun = runs.at(-1);
        if (lastRun) {
          const rest = tailFor(lastRun)?.read(true);
          if (rest) printLines(view, rest);
          runFooter(view, lastRun);
        }
        finish(view, task);
        return EXIT.ok;
      }
      await stop.sleep(POLL_MS);
      if (stop.interrupted) return EXIT.interrupted;
      if (tick % TASK_EVERY === TASK_EVERY - 1 || runs.length === 0) {
        ({ task, runs } = await fetchTask());
      }
    }
  } finally {
    stop.dispose();
  }
}

function finish(view: View, task: TaskView): void {
  if (view.raw) return;
  view.out.lines(renderTaskDetail(task, view.tz, view.out.style));
}
