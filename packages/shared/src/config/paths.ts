/**
 * 設定に関わる場所。
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 組み込みのサービス定義（リポジトリの `services/`。5.2.3 の1） */
export function builtinServicesDir(): string {
  return fileURLToPath(new URL("../../../../services/", import.meta.url));
}

/** `aicoop init` で `~/.aicoop/` に複製する雛形（リポジトリの `templates/`。6.1） */
export function templatesDir(): string {
  return fileURLToPath(new URL("../../../../templates/", import.meta.url));
}

/**
 * 先頭の `~` を、ホームディレクトリに展開する（`~` と `~/...` だけ。`~user` は展開しない）。
 */
export function expandHome(path: string, userHome: string): string {
  if (path === "~") return userHome;
  if (path.startsWith("~/")) return join(userHome, path.slice(2));
  return path;
}

/** 2つのパスが同じ場所を指すか（Windows では大文字と小文字を区別しない） */
export function isSamePath(a: string, b: string): boolean {
  return isAbsolute(a) && isAbsolute(b) && relative(resolve(a), resolve(b)) === "";
}
