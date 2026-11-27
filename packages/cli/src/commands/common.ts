/**
 * コマンドどうしで使い回すもの。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isId } from "@aicoop/shared";
import { parse as parseYaml } from "yaml";
import type { CliContext } from "../context.ts";
import { UsageError } from "../errors.ts";
import { suggest } from "../suggest.ts";

/** Ctrl+C を受けるまで待てる眠り（aicoop run --wait・logs --follow・stop など） */
export interface Interruption {
  readonly interrupted: boolean;
  sleep(ms: number): Promise<void>;
  dispose(): void;
}

export function interruption(ctx: CliContext): Interruption {
  let interrupted = false;
  const waiting = new Set<() => void>();
  const off = ctx.deps.onInterrupt(() => {
    interrupted = true;
    for (const wake of waiting) wake();
    waiting.clear();
  });
  return {
    get interrupted() {
      return interrupted;
    },
    sleep(ms) {
      if (interrupted) return Promise.resolve();
      return new Promise((resolve) => {
        const wake = () => {
          waiting.delete(wake);
          resolve();
        };
        waiting.add(wake);
        void ctx.deps.sleep(ms).then(wake);
      });
    },
    dispose: off,
  };
}

/** members.yaml の社員 ID（「もしかして」に使う。読めなければ空） */
export function memberIds(home: string): string[] {
  try {
    const doc = parseYaml(readFileSync(join(home, "members.yaml"), "utf8")) as {
      members?: Record<string, unknown>;
    };
    return Object.keys(doc?.members ?? {});
  } catch {
    return [];
  }
}

export function memberHints(home: string, id: string): string[] {
  const close = suggest(id, memberIds(home));
  return close.length > 0
    ? [`もしかして ${close.join("、")}`]
    : ["社員の一覧は members.yaml にあります"];
}

/** タスクの ID（t_ + ULID）を確かめる */
export function requireTaskId(value: string | undefined): string {
  const v = (value ?? "").trim();
  const ok: boolean = isId(v, "task");
  if (!ok) {
    throw new UsageError(`タスクの ID として読めません：${v.slice(0, 40)}`, [
      "t_ で始まる27文字の ID です（aicoop tasks で確かめられます）",
    ]);
  }
  return v;
}
