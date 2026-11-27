/**
 * パラメーターの値の glob 照合（5.2.4 の3）。
 *
 * - `*` は任意の文字列（`/` も含む。例：`myorg/*` は `myorg/app` に一致する）
 * - それ以外の文字は、その文字そのもの
 * - 大文字と小文字は区別する。許可は「一覧に一致したものだけ」なので、
 *   区別して一致しなくても拒否側に倒れるだけで、許可が広がることはない
 */
export function matchesGlob(glob: string, value: string): boolean {
  const source = glob.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`, "s").test(value);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}
