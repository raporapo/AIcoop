import type { ReadinessItem } from "../readiness.ts";
import type { Style } from "./style.ts";

export function renderReadiness(items: readonly ReadinessItem[], style: Style): string[] {
  const lines: string[] = [];
  for (const item of items) {
    lines.push(`  ${item.ok ? style.green("✓") : style.yellow("!")} ${item.message}`);
    if (!item.ok && item.hint) lines.push(`      ${style.cyan(`→ ${item.hint}`)}`);
  }
  return lines;
}

export function readinessJson(item: ReadinessItem): Record<string, string | boolean | null> {
  return { id: item.id, ok: item.ok, message: item.message, hint: item.hint ?? null };
}
