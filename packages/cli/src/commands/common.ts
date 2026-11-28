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
  const ids = memberIds(home);
  // 設定にいる社員が別の理由（箱が動かせない・人間の社員など）で断られたときは、勧めるものがない
  if (ids.includes(id)) return [];
  const close = suggest(id, ids);
  return close.length > 0
    ? [`もしかして ${close.join("、")}`]
    : ["社員の一覧は members.yaml にあります"];
}

/**
 * `--status` の値（`,` で区切って複数）。状態の名前のほか、日本語の呼び名（オーナーの承認待ちなど）も受け付ける。
 * 知らない状態は、送る前に止めて「もしかして」を出す（使い方の誤り）
 */
export function parseStatusOption<S extends string>(
  value: string,
  known: readonly S[],
  labels: readonly Readonly<Partial<Record<string, string>>>[],
): S[] {
  const byLabel = new Map<string, S>();
  for (const table of labels) {
    for (const s of known) {
      const label = table[s];
      if (label !== undefined && !byLabel.has(label)) byLabel.set(label, s);
    }
  }
  const out: S[] = [];
  for (const raw of value.split(/[,、，]/)) {
    const word = raw.trim().normalize("NFKC").toLowerCase();
    if (word === "") continue;
    const status = (known as readonly string[]).includes(word)
      ? (word as S)
      : byLabel.get(raw.trim());
    if (status === undefined) {
      const close = suggest(word, known);
      throw new UsageError(`知らない状態です：${raw.trim().slice(0, 30)}`, [
        ...(close.length > 0 ? [`もしかして ${close.join("、")}`] : []),
        `状態：${known.join("・")}`,
      ]);
    }
    if (!out.includes(status)) out.push(status);
  }
  if (out.length === 0) throw new UsageError("--status が空です", [`状態：${known.join("・")}`]);
  return out;
}

/** `--limit`（1〜max の整数） */
export function parseLimitOption(value: string, max = 500): number {
  const s = value.trim().normalize("NFKC");
  if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > max) {
    throw new UsageError(
      `--limit は 1〜${max} の数にしてください（いまの値：${value.slice(0, 20)}）`,
    );
  }
  return Number(s);
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
