#!/bin/sh
# aicoop の P1 結合テスト（p1.vm.e2e.test.ts）で、本物の vm の箱に入れる偽の claude。
# 本物の Claude Code の代わりに、次のことをして終わる。
#   1. stream-json の system/init の行を出す（session_id は自分で作る）
#   2. 箱の中から見えたもの（引数・env・/proc/*/environ・ファイル）を /work/e2e/<session_id>/ に書く
#   3. curl で、資格プロキシ（github.com・api.github.com・許可していないホスト）と、
#      道具ゲート（http://aicoop.internal/mcp。MCP の JSON-RPC をセッションなしで1つずつ）に送り、応答を書く
#   4. report_result で報告し、stream-json の result の行を出して 0 で終わる
# タスク本文に AICOOP_E2E_SLEEP があれば、2 のあと止められるまで眠る（時間切れ・取り消しの確かめ）。
# @E2E_ORG@・@E2E_OTHER_OWNER@ は、テストが箱のイメージに入れる前に置き換える。
set -u

sid="e2e-$(date +%s)-$$"
out="/work/e2e/$sid"
mkdir -p "$out"

printf '{"type":"system","subtype":"init","cwd":"%s","session_id":"%s","tools":["mcp__aicoop__report_result"],"mcp_servers":[{"name":"aicoop","status":"connected"}]}\n' "$(pwd)" "$sid"

# ---- 箱の中から見えるもの ----
printf '%s\0' "$@" > "$out/argv"
pwd > "$out/cwd"
env > "$out/env"

# タスク本文（-p の次の引数）に AICOOP_E2E_SLEEP があれば、止められるまで動き続ける（時間切れ・取り消しの確かめ）
case "${2:-}" in
  *AICOOP_E2E_SLEEP*)
    echo "$$" > "$out/sleeping"
    sleep 600
    echo "止められなかった" > "$out/not-stopped"
    exit 0
    ;;
esac
for f in /proc/[0-9]*/environ; do
  tr '\0' '\n' < "$f" 2>/dev/null
  echo
done > "$out/environ-all" 2>/dev/null
for p in /etc/aicoop/mcp.json /etc/claude-code/managed-settings.json /home/agent/.claude/CLAUDE.md /home/agent/.claude/settings.json /usr/local/bin/claude; do
  if [ -f "$p" ]; then echo "ok $p"; else echo "missing $p"; fi
done > "$out/files"
cp /etc/aicoop/mcp.json "$out/mcp.json" 2>/dev/null
cp /etc/claude-code/managed-settings.json "$out/managed-settings.json" 2>/dev/null
if (echo x > /etc/aicoop/aicoop-e2e-write) 2>/dev/null; then echo writable; else echo readonly; fi > "$out/etc-aicoop-write"

# 11.5：本物の Claude Code が、見えた値をそのまま出力してしまったとき（記録では伏せ字になるはず）
printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"CLAUDE_CODE_OAUTH_TOKEN=%s GITHUB_TOKEN=%s"}]}}\n' "${CLAUDE_CODE_OAUTH_TOKEN:-}" "${GITHUB_TOKEN:-}"
echo "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}" >&2

# ---- 資格プロキシ ----
# req <名前> <curl の引数...>：ステータス・ヘッダー・本文・エラーを書く
req() {
  name=$1
  shift
  code=$(curl -sS -m 60 -o "$out/$name.body" -D "$out/$name.headers" -w '%{http_code}' "$@" 2>"$out/$name.err")
  echo "$code" > "$out/$name.status"
}

# git の資格ヘルパーと同じく、仮の札を Basic 認証で送る（5.1.8 の3）
basic=$(printf 'x-access-token:%s' "${GITHUB_TOKEN:-}" | base64 | tr -d '\n')
# P1 完了条件2：許可していないリポジトリへの push
req push-denied -X POST -H "Authorization: Basic $basic" -H "Content-Type: application/x-git-receive-pack-request" --data-binary 0000 "https://github.com/@E2E_OTHER_OWNER@/app.git/git-receive-pack"
# 許可したリポジトリへの push（forward される。偽のトークンなので GitHub が断る）
req push-allowed -X POST -H "Authorization: Basic $basic" -H "Content-Type: application/x-git-receive-pack-request" --data-binary 0000 "https://github.com/@E2E_ORG@/app.git/git-receive-pack"
# 許可したリポジトリの API（forward される。偽のトークンなので 401）
req api-allowed -H "Authorization: Bearer ${GITHUB_TOKEN:-}" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/@E2E_ORG@/app"
# P1 完了条件3：許可していないホスト
req host-denied "https://example.com/"

# 本物の git での push（許可していないリポジトリ）
repo=/tmp/aicoop-e2e-repo
rm -rf "$repo"
git init -q "$repo" >/dev/null 2>&1
(
  cd "$repo" &&
    git -c user.name=aicoop-e2e -c user.email=e2e@example.invalid commit -q --allow-empty -m e2e &&
    git push "https://github.com/@E2E_OTHER_OWNER@/app.git" HEAD:refs/heads/aicoop-e2e
) > "$out/git-push-denied.out" 2>&1
echo $? > "$out/git-push-denied.status"

# ---- 道具ゲート（MCP、Streamable HTTP） ----
# mcp <名前> <JSON-RPC>：セッションIDを付けずに、1つずつ送る
mcp() {
  code=$(curl -sS -m 30 -X POST "http://aicoop.internal/mcp" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" --data-binary "$2" -o "$out/mcp-$1.body" -w '%{http_code}' 2>"$out/mcp-$1.err")
  echo "$code" > "$out/mcp-$1.status"
}
mcp initialize '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"aicoop-e2e-fake-claude","version":"0.0.0"}}}'
mcp initialized '{"jsonrpc":"2.0","method":"notifications/initialized"}'
mcp list '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
echo "箱の中で書いた報告（$sid）" > "$out/report.md"
mcp report "$(printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"report_result","arguments":{"summary":"箱の中から確かめました（%s）","files":["%s/report.md"]}}}' "$sid" "$out")"

printf '{"type":"result","subtype":"success","is_error":false,"result":"終わりました","session_id":"%s"}\n' "$sid"
exit 0
