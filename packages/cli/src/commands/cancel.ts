/**
 * `aicoop cancel <task_id>`（9.1）：POST /tasks/{id}/cancel。動いていれば止める。
 */
import type { CancelTaskResponse } from "@aicoop/daemon";
import { apiFailure, DaemonClient } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { EXIT } from "../exit-codes.ts";
import { requireInitialized } from "../home.ts";
import { taskStatusLabel } from "../ui/labels.ts";
import { requireTaskId } from "./common.ts";

export async function run(input: CommandInput): Promise<number> {
  const { home, values, positionals, out, ctx } = input;
  const id = requireTaskId(positionals[0]);
  requireInitialized(home);
  const client = DaemonClient.connect(ctx, home);
  let result: CancelTaskResponse;
  try {
    // 動いている箱を止めるまで待つので、長めに待つ
    result = await client.post<CancelTaskResponse>(
      `/tasks/${id}/cancel`,
      {},
      { timeoutMs: 120_000 },
    );
  } catch (e) {
    throw apiFailure(e, home);
  }
  if (values.json === true) {
    out.line(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  const style = out.style;
  out.line(
    `${style.green("✓")} タスク ${id} を取り消しました（${taskStatusLabel(result.task.status, style)}）`,
  );
  if (result.was_active) {
    out.line(
      "    動いていた箱を止めました。会話の記録（セッション）は残るので、同じスレッドで頼み直せます",
    );
  }
  return EXIT.ok;
}
