/**
 * 一時権限（5.7.3）の見せ方。
 */
import type { GrantView } from "@aicoop/shared/api";
import { revealedString } from "./visible.ts";

/** パラメーターの制限（`repo=myorg/new`）。制限がなければ null（すべてに効く） */
export function grantParamsText(params: GrantView["params"]): string | null {
  const entries = Object.entries(params);
  if (entries.length === 0) return null;
  return entries
    .map(([k, values]) => `${revealedString(k)}=${values.map((v) => revealedString(v)).join(",")}`)
    .join("・");
}

export const GRANT_MODE_TEXT: Readonly<Record<GrantView["mode"], string>> = {
  allow: "許可（承認なしで、そのまま通る）",
  hold: "保留（使うたびに、部長とあなたの承認が要る）",
};
