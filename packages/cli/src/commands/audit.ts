/**
 * `aicoop audit verify`（9.1、5.10 の4、P1 完了条件5）：state.db を直接開いて、監査ログのつながりを確かめる。
 * daemon が動いていなくても使える。state.db がなければ作らずに止める（確かめるものがない）。
 */
import { existsSync } from "node:fs";
import { aicoopPaths, listAuditLog, openStateDb, verifyAuditLog } from "@aicoop/daemon";
import type { CommandInput } from "../command.ts";
import { CliError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { readTimezone, requireInitialized } from "../home.ts";
import { formatTime } from "../ui/time.ts";

export async function run(input: CommandInput): Promise<number> {
  const { home, values, out } = input;
  requireInitialized(home);
  const path = aicoopPaths(home).stateDb;
  if (!existsSync(path)) {
    throw new CliError(EXIT.failure, `state.db がないので、確かめられません（${path}）`, [
      "まだ一度も aicoop を動かしていないなら、記録はありません",
      "動かしたことがあるのに無いなら、消されたか、別の場所（--home）を見ています",
    ]);
  }

  const db = openStateDb(path);
  let result: ReturnType<typeof verifyAuditLog>;
  let lastTs: string | null = null;
  try {
    result = verifyAuditLog(db);
    if (result.ok && result.lastSeq !== null) {
      lastTs = listAuditLog(db, { after: result.lastSeq - 1, limit: 1 })[0]?.ts ?? null;
    }
  } finally {
    db.close();
  }

  if (values.json === true) {
    out.line(
      JSON.stringify(
        result.ok
          ? {
              ok: true,
              count: result.count,
              first_seq: result.firstSeq,
              last_seq: result.lastSeq,
              last_ts: lastTs,
              last_hash: result.lastHash,
            }
          : { ok: false, seq: result.seq, reason: result.reason, message: result.message },
        null,
        2,
      ),
    );
    return result.ok ? EXIT.ok : EXIT.failure;
  }

  const style = out.style;
  if (!result.ok) {
    out.line(`${style.red("✗ 監査ログのつながりが壊れています")}`);
    out.line(`    最初に壊れていた行  seq ${result.seq}（これより後ろの記録は信用できません）`);
    out.line(`    理由                ${result.message}（${result.reason}）`);
    out.line("");
    out.line(
      "state.db が書き換えられたか、壊れています。バックアップと見比べてください（設計書 11.6）。",
    );
    return EXIT.failure;
  }
  if (result.count === 0) {
    out.line(`${style.green("✓")} 監査ログはまだ1件もありません`);
    return EXIT.ok;
  }
  const tz = await readTimezone(home);
  out.line(
    `${style.green("✓")} 監査ログのつながりを確かめました：${result.count.toLocaleString("ja-JP")}件`,
  );
  out.line(`    範囲        seq ${result.firstSeq}〜${result.lastSeq}`);
  if (lastTs) out.line(`    最後の記録  ${formatTime(lastTs, tz, { seconds: true })}（${tz}）`);
  out.line(`    最後の hash ${result.lastHash}`);
  out.line(
    style.dim(
      "    この hash を控えておくと、次に確かめたとき、末尾の行が消されていないかも分かります",
    ),
  );
  return EXIT.ok;
}
