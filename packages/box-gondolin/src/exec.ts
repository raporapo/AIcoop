/**
 * 箱の中でコマンドを動かすための部品（4.4 の `Box.exec`・`Box.kill`）。
 *
 * Gondolin の配列の exec は `$PATH` を探さない（README）。`claude` のような名前でも動くよう
 * `/bin/sh -c` を通すが、コマンドと引数はシェルの文字列に組み立てず、位置引数（`"$@"`）で渡す。
 * 止めるときのために、シェルの PID（`exec` のあとはコマンドの PID）を箱の中のファイルに残す。
 */

/** 箱の中で、実行中のコマンドの PID を置くディレクトリ */
export const PID_DIR = "/run/aicoop-exec";

/** 固定のスクリプト。$1 が PID のファイル、残りがコマンド */
const WRAPPER_SCRIPT = `p="$1"; shift; mkdir -p ${PID_DIR} 2>/dev/null; echo "$$" > "$p" 2>/dev/null; exec "$@"`;

export function pidFile(execId: number): string {
  return `${PID_DIR}/${execId}.pid`;
}

/** 動いている exec を止めるコマンド */
export function killCommand(execIds: readonly number[]): string[] {
  return ["/bin/sh", "-c", KILL_SCRIPT, "aicoop-kill", ...execIds.map(String)];
}

export function wrapCommand(cmd: readonly string[], pidFile: string): string[] {
  if (cmd.length === 0 || cmd[0] === "") {
    throw new Error("exec のコマンドが空です");
  }
  if (cmd.some((arg) => arg.includes("\0"))) {
    throw new Error("exec の引数に NUL は使えません");
  }
  return ["/bin/sh", "-c", WRAPPER_SCRIPT, "aicoop-exec", pidFile, ...cmd];
}

/**
 * 動いている exec（位置引数で渡した番号）の PID とその子孫をすべて止める。
 * 子孫は先に集める（親が止まると init に付け替わるため）。
 * 子孫は `/proc/<pid>/status` の `PPid:` からたどる（busybox だけで動く）。
 */
export const KILL_SCRIPT = `
collect() {
  echo "$1"
  for f in $(grep -l "^PPid:[[:space:]]*$1\\$" /proc/[0-9]*/status 2>/dev/null); do
    c="\${f#/proc/}"; c="\${c%/status}"
    [ "$c" = "$1" ] || collect "$c"
  done
}
pids=""
for id in "$@"; do
  case "$id" in ''|*[!0-9]*) continue ;; esac
  f="${PID_DIR}/$id.pid"
  [ -f "$f" ] || continue
  read -r p < "$f" || continue
  case "$p" in ''|*[!0-9]*) continue ;; esac
  pids="$pids $(collect "$p")"
done
[ -n "$pids" ] || exit 0
kill -TERM $pids 2>/dev/null
sleep 2
kill -KILL $pids 2>/dev/null
exit 0
`;

/** バイト列を行に分ける。UTF-8 の文字がチャンクの境目で割れても崩さない */
export class LineSplitter {
  readonly #decoder = new TextDecoder("utf-8");
  #rest = "";

  push(chunk: Uint8Array): string[] {
    const text = this.#rest + this.#decoder.decode(chunk, { stream: true });
    const parts = text.split("\n");
    this.#rest = parts.pop() ?? "";
    return parts.map(stripCr);
  }

  end(): string[] {
    const text = this.#rest + this.#decoder.decode();
    this.#rest = "";
    return text === "" ? [] : [stripCr(text)];
  }
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
