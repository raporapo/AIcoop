# 開発の進め方

## テスト駆動のサイクル

1. 設計書（`docs/design.md`）から、作る節の「仕様」と「受け入れ条件」を選ぶ。
2. 受け入れ条件を1つずつテストに書く。`pnpm test:watch` で**失敗するのを確かめる**（Red）。
3. 通る最小の実装を書く（Green）。
4. 緑のまま整える（Refactor）。`pnpm verify` が通ったらコミットする。

テストの名前には設計書の節番号を入れて、「どの決定を守るテストか」を追えるようにする。

## P1 の進み具合

P1 の完了条件は設計書の第14章にある。OSに依存しない部品から先に作り、箱（Gondolin）は Linux（CI の KVM）で確かめる。

### できたもの

`packages/shared`（OSに依存しない純粋なロジック）

- [x] 正規化JSON（5.8 の3の4、5.10 の2、5.3.5 の1）— `canonical-json.ts`
- [x] パスのパターン `*`・`**`・`{name}`（5.2.3 の3・4）— `path-pattern.ts`
- [x] サービス定義のスキーマと、組み込みの3つ（5.2.3、6.7）、E-010・E-011 — `service.ts`、`services/*.yaml`
- [x] 操作の特定（5.2.4 の1）— `operation.ts`
- [x] 有効な許可 E(m) とルールの判定 allow・hold・deny（5.2.4 の2〜4）— `permission.ts`
- [x] ID：種類の接頭辞＋ULID（7.1）— `ids.ts`
- [x] 監査ログのハッシュの連鎖と、つながりの確認（5.10）— `audit.ts`
- [x] 拒否と保留の返し方（5.2.5）— `decision-response.ts`
- [x] 設定ファイルのスキーマ 6.2〜6.9 と、設定の検証 E-001〜E-014・W-001〜W-003（6.10）— `config/`
- [x] `aicoop init` の雛形 — `templates/`
- [x] プロンプトの組み立て（5.4.3）と、外から来た文章の囲み — `prompt.ts`
- [x] 順番待ちの判定（5.5.1、5.5.4、5.1.3、5.1.5）と、タスクの状態の変化（5.5.3）— `scheduler.ts`、`task-state.ts`
- [x] 箱の境界（4.4）— `box.ts`

`packages/daemon`

- [x] `state.db`（better-sqlite3 + Drizzle、7章）、監査ログの追記・確かめ・保存期間、制御サーバーの再起動（8.6）— `db/`
- [x] `~/.aicoop` の中のパス（6.1）、資格保管庫（5.2.8）、ローカルAPI の形（9.2）— `paths.ts`、`secrets/store.ts`、`api/contract.ts`

`packages/box-gondolin`（CI の `vm integration (Gondolin, KVM)`・`vm image` のジョブで実機を確かめる）

- [x] `vm` の箱のドライバー（4.4、5.1、5.2.1、5.2.7、5.3.1）とベースイメージ（5.1.8）
- [x] 16章の V-1・V-2・V-4・V-6・V-9 を確かめた（結果は設計書の16章）

`packages/daemon`（つづき）と `packages/cli`

- [x] 1件の実行（8.1）：掃除（5.4.4）、CLAUDE.md、管理設定（5.3.8・V-8）、資格の発行（5.2.8）、道具ゲートの `report_result`（5.3.1、5.3.3）、資格プロキシの判定（5.2.4〜5.2.6 の1）、時間制限（5.5.5）、セッションの続き（5.4.5）、利用枠（5.4.6）— `run/`・`gateway/`・`proxy/`・`secrets/issue.ts`
- [x] 制御サーバー本体：順番待ちのループ、`cron`・`manual` トリガー（5.5.1）、ローカルAPI（9.2）、読み直し（6.1）、ログ（11.5）— `daemon/`・`scheduler/`・`triggers/`・`api/server.ts`
- [x] P1 の CLI（9.1）— `packages/cli`
- [x] 乗っ取られた AI 社員の目での見直し（T-13 のホームの掃除、道具ゲートの認証など。PR #13）、WebSearch を使わせない（T-3。PR #16）
- [x] P1 の完了条件1〜5 を端から端まで通す結合テスト（偽の箱は `p1.e2e.test.ts`、CI の KVM の本物の箱は `p1.vm.e2e.test.ts`。PR #11）。完了条件6 の V-1・V-2・V-4・V-6・V-8・V-9 は設計書の16章

### 次に作るもの

- [x] P2：パスキーでの承認・`aicoop pair --local`・ログイン・`aicoop devices`（5.8。PR #18）
- [x] P2：保留と再送・部長のレビュー・一時権限（5.2.6、5.7）、S-1・S-4 の受け入れテスト（PR #19）
- [x] P2：承認アプリ（PWA）の画面（PR #22）。要約のハッシュが daemon と一致することも受け入れテストで確かめる（PR #23）
- [x] P2 の完了条件 S-1・S-4（PR #19、`daemon/p2-acceptance.test.ts`）・S-5（PR #25、`daemon/s5-acceptance.test.ts`）を本物の daemon で通す。`aicoop holds`・`aicoop grants`、決まった保留のファイルの片付け、保留・申請の上限（PR #25）
- [ ] V-7（`rate_limit_event` に使用率が入っているか）：本物のログインで確かめる（設計書 16章）
- [ ] PC の画面での準備と設定（設計書 5.14、D-26〜D-30。2026-11-28 にオーナーが決定）
  - [ ] ランチャーと `aicoop open`（5.14 の1・2）
  - [x] 設定の画面と資格の画面（署名つきの変更。5.14 の4・5・6。daemon は PR #30、承認アプリは PR #32。受け入れ条件は `daemon/settings-acceptance.test.ts`）
  - [ ] 準備の画面（Claude へのログイン・GitHub・イメージ。5.14 の3）

### この先（設計書 14章）

- [ ] P3：中継・スマホの端末の登録・プッシュ通知・`github` トリガー・上流MCP・道具の説明文の固定・スキル
- [ ] P4：依頼票・CEO（`none`）・ホストの道具（ComfyUI）・`srt` の箱
- [ ] 本物のログインで仕事をさせての確かめ：V-1 の3、V-4 の仕事中のメモリ、V-7、V-8 のプラグイン・フックの禁止

## 設計書に記録が必要な決定（未記録）

実装の途中で、設計書に書かれていない判断が必要になったもの。オーナーが決めたら第18章に追記し、本文を直してから、ここから消す。迷ったものは、どれも拒否側（許可が広がらない側）に倒してある。

### 最初の一歩（ルールの判定）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| 1 | 解釈が分かれるパス（`.`・`..` の区切り、`%2e`・`%2f`・`%5c`、`\`、制御文字）の扱い | どの操作にも一致させない → `deny`（`no_operation`） | 外のサーバーがパスを正規化すると、判定したものと違うリソースに届く（例：`/repos/myorg/app/../../other/secret`）。P-3 |
| 2 | `web.read` の `*` が、ループバック・プライベート・リンクローカルのアドレスを含むか | 含まない。vm の箱のドライバーが、名前解決のあとのアドレスで塞ぐ（C-6） | 箱から制御サーバーのAPI・ComfyUI・LAN・クラウドのメタデータへ届かないように |
| 3 | 許可項目がパラメーターを制限しているのに、その操作のパスにそのパラメーターがない | 一致しない → `deny`。設定の検証でも E-001（A-14） | 拒否側に倒す（P-3） |
| 4 | パラメーターの glob の大文字・小文字 | 区別する | GitHub の owner/repo は大文字・小文字を区別しないが、区別しても拒否側に倒れるだけで許可は広がらない |
| 5 | HTTPメソッドの大文字・小文字 | 区別する（`get` は `GET` に一致しない） | 拒否側に倒す |
| 6 | 設定の誤りのメッセージの言語 | zod の日本語ロケール＋独自の日本語（A-1） | 11.7 |

### 土台・境界（PR #1・#5・#6）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| M-1 | `BoxSpec` に `secrets: BoxSecret[]`（環境変数名・宛先・本物の値）と `image?` を足す | 足した | 5.2.1 は「本物の資格を Gondolin の秘密情報の機能に渡す」としているが、4.4 の型に渡し口がない。`env` には仮の札だけを入れる |
| M-2 | `ProxiedRequest`・`ProxyDecision` の形 | `forward` か `respond`（ステータス・ヘッダー・本文） | daemon を Gondolin に依存させない |
| M-3 | home の決め方 | 環境変数 `AICOOP_HOME`、なければ `~/.aicoop` | テストや、複数の会社を試すときに場所を変えたい |
| M-4 | `secrets.json` の形 | `{"version":1,"secrets":{"<id>":{"kind","value","updated_at"}}}` | 5.2.8 に形の決めがない |
| M-5 | ローカルAPI に足したもの | `POST /reload`、`POST /shutdown`、`runtime/daemon.json`（pid・ポート） | 9.1 の `aicoop reload`・`aicoop stop` を API で行う（Windows でもシグナルに頼らず止められる） |
| M-6 | better-sqlite3 のインストールスクリプト | 動かさない（同梱のビルド済みファイルを使う） | Visual Studio の無い Windows で `pnpm install` が失敗する |

### 設定の読み込みと検証（PR #3）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| A-1 | 設定の誤りのメッセージの言語（development.md #6） | `z.locales.ja()` を読むたびに渡す（`z.config()` で全体は切り替えない）＋よく出る誤りは独自の日本語 | 11.7。同じプロセスでほかに zod を使うものへ影響させない |
| A-2 | ID の先頭のハイフン | 許さない（`^[a-z0-9][a-z0-9-]{0,39}$`） | `aicoop run -x` のようにオプションと取り違える |
| A-3 | トリガー・上流MCP・資格の ID の形 | 社員IDと同じ規則 | 6.6・6.8 に定めがない |
| A-4 | CEO が0人 | 許す | CEO は P4 |
| A-5 | E-002 の範囲 | `box: none` を部署 `ceo` 以外に使う、部署 `ceo` が `box: none` でない、も E-002 | 5.1.2 の表「CEOだけ」、5.11 の1 |
| A-6 | E-003 の判定 | 役職の `allow` が空でない、で判定。さらに `srt` の部署の `ceiling` が空でないことも E-003 | 一時権限は ceiling で効くので、ceiling が空でないと実行中に操作が足せてしまう |
| A-7 | E-004 の追加 | `manages` に `executives`・`ceo` は書けない（E-004）。`manager` 以外の `manages` は E-013 | 拒否側に倒す |
| A-8 | E-012 | `executives` が `box: vm` でなければ、部長がいなくてもエラー | 本文の「または」を独立した条件と読んだ |
| A-9 | `humans.intake_member` の確かめ方 | 書いたとき、または人間の社員がいるときだけ E-001 を見る | 既定の `ceo` は P4 までいないので、P1 の会社が必ず E-001 になってしまう |
| A-10 | `daemon.home` の既定 | 書かなければ「実際に読んでいる home」。書けば `~` を展開して比べる | 既定を `~/.aicoop` 固定にすると、ほかの場所の home では必ず E-013 になる |
| A-11 | 必須のファイルがないときのコード | E-013 | 6.10 に当てはまる ID がない |
| A-12 | プロンプトの md がないときのコード | E-001（`company.md` も） | 5.4.3 の必須のファイルを参照しているとみなした |
| A-13 | スキル | `skills/<name>/` がなければ E-001 | 6.10 の E-001 の列挙にはないが、存在しないものの参照 |
| A-14 | 許可項目の `params` | 操作のパスにないパラメーター名は E-001 | 打ち間違い（`repos`）で許可が黙って効かなくなる（判定は #3 のとおり deny のまま） |
| A-15 | `anthropic_passthrough_hosts` | サービスの `hosts` と重なれば E-013。空・`*`・URL も E-013 | 素通しした宛先はルールの判定を通らない |
| A-16 | `timezone` の「IANA形式」 | `Area/Location`（3つまで）か `UTC` だけ。`JST`・`Japan`・`+09:00`・小文字は E-013 | 実行環境が受け付けても IANA の正式な名前でないものは拒否側に |
| A-17 | cron式 | 5項目だけ（秒つきの6項目・`@daily` は E-007）。一度も起きない式（2月31日など）も E-007 | 6.6「5項目のcron式」 |
| A-18 | `enabled: false` のトリガー | これも検証する | 有効にしたときに初めて壊れないように |
| A-19 | github トリガーのテンプレート | 受けるイベントのすべてで使える変数だけ。`*` の変数は `thread` に使えない。`cron` では `{{}}` を使えない。組にならない `{{`・`}}` は E-013 | 外の人がスレッドを選べないようにする。値が決まらない変数を残さない |
| A-20 | `on_hold_resolved` の `task`・`thread` | 書けない（E-013） | 6.6 で固定。書いても効かないものを書かせない |
| A-21 | トリガーの `id` の重なり | E-013 | 6.6「一意」 |
| A-22 | URL の scheme | `relay.url` は https だけ。`mcp_servers` の `url` は https か、ループバックの http。`host_tools` の `health` はループバックの http。`runtimes.local_llm` は http・https | 資格・承認を載せる通信を平文で外へ出さない |
| A-23 | 役職・社員の `prompt` | `prompts/` からの相対パスの `.md` だけ。`..`・絶対パス・`\`・`:`・`~` は E-013 | `prompts/` の外を箱の中に書き出させない |
| A-24 | `prompts/` の中のシンボリックリンク | E-013 | `secrets.json` などを指して、箱の中に持ち込ませない |
| A-25 | `groups.packages` | Alpine のパッケージ名の形だけ（`-` で始まる値・空白は E-013） | `apk add` に渡る |
| A-26 | `roles.model` | `-` で始まる値は E-013 | `--model` に渡る |
| A-27 | `roles.tools` | `generate_image`・`<上流>.<道具>`・`<上流>.*` だけ。組み込み道具の名前（`assign_task` など）は E-013 | 組み込み道具は自動で付く。CEO の道具を書いて得られないように |
| A-28 | `generate_image` | `host_tools.yaml` に `comfyui` がなければ E-001 | ホストの道具の参照とみなした |
| A-29 | 6.9 の表がない部分 | `start`・`cwd`・`health`・`custom_nodes_dir` は必須。`stop` は `SIGTERM`・`SIGINT`・`SIGKILL`（既定 `SIGTERM`）、`start_timeout_seconds` は 1〜600（既定 120）、`allowed_custom_nodes` 既定 `[]`、`presets_dir` は任意 | 6.9 に表がない |
| A-30 | `mcp_servers.yaml` の `secret` / `daemon.port` | `secret` の既定は `null` / `port` は 1〜65535 | 表に既定・範囲がない |
| A-31 | `secrets.json` の権限 | `0600` と完全に一致しなければ E-008（`0400` もエラー）。ファイルがなければよい | 本文のとおり |
| A-32 | `.yml` のファイル | 読まずに E-013（`triggers.yml` など、`services/*.yml` も） | 名前の誤りで設定が黙って効かないのを防ぐ |
| A-33 | `home/services/` で同じ `id` が2つ | E-013 | どちらが効くか決まらない |
| A-34 | `company.id` | `c_` + ULID の形でなければ E-013 | 7.1 |
| A-35 | スキーマの誤りがあるとき | ファイルどうしの検証はしない（そこで止める） | 読めていないファイルを参照して、誤りが連鎖して出るのを防ぐ |
| A-36 | W-001・W-002・W-003 の数え方 | W-001 は（役職, 部署, 項目）ごと。W-002 は部署ごと・送る側の役職ごとに1つで、一時権限は数えない（設定の時点の有効な許可）。W-003 は循環（強連結成分）ごとに1つ | 同じ警告を何度も出さない |
| A-37 | 読んだ結果の `groups`・`roles`・`members`・`mcpServers` | プロトタイプを持たないオブジェクト | `constructor` は ID として正しい形なので、ふつうのオブジェクトだと「書いていない部署 constructor」を「ある」と取り違える（テストで確かめた不具合） |
| A-38 | 雛形の開発部 | `web.read` を入れない（W-002 を避けるため）。そのため `npm install` などはできない。コメントで理由と、足し方を書いた | 開発部はリポジトリ（社内のデータ）を読めるので、Web への GET で持ち出せる |
設計書の表記ゆれ：5.2.8 の1 は「6.10 の E-009」と書いているが、6.10 では `secrets.json` の権限は E-008。E-008 にした。

### ID・監査ログ・プロンプト・順番待ち・state.db（PR #4）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| B-1 | ID の ULID の形 | Crockford の base32 の大文字26文字、先頭は0〜7だけを認める。小文字・知らない接頭辞・`_` の数が違うものは ID ではない | 正規の形を1つにして、取り違えを防ぐ（拒否側） |
| B-2 | 監査ログの hash の内容（5.10 の2） | `prev_hash` + 正規化JSON `{seq, ts, actor, kind, subject, data}`（data は JSON として読んだ値）を UTF-8 で SHA-256、16進の小文字 | seq を入れて削除・入れ替えでつながりが切れるようにする |
| B-3 | data の保存の形 | 必ず正規化JSONで保存し、確かめるときに正規化JSONでなければ改ざんとみなす（`data_invalid`） | 同じ意味の別の書き方への書き換えも見逃さない |
| B-4 | checkpoint 行（5.10 の5） | 末尾に追記。`kind: checkpoint`、`actor: system`、`subject: audit_log`、data は `{from_seq, to_seq, last_hash, last_ts, cutoff, deleted_rows}` だけ。残った最初の行の prev_hash が GENESIS でなければ、`to_seq` = 最初の seq − 1 かつ `last_hash` = その prev_hash の checkpoint が要る。どの checkpoint も `to_seq` < 最初の seq、`last_ts` < `cutoff` ≤ checkpoint の時刻 − 30日、`deleted_rows` = to − from + 1 | 偽の checkpoint で、新しい行の削除や、消していない行の削除をごまかせないようにする |
| B-5 | 保存期間の削除の範囲 | 先頭から続く「cutoff より古い行」だけを消す。つながりが壊れていたら消さない | 改ざんの跡を checkpoint で隠さない |
| B-6 | audit_log の seq | AUTOINCREMENT。`sqlite_sequence` の最後の seq と比べて、末尾の削除を見つける（`last_seq_mismatch`）。消された seq は使い回さない | 鍵なしの連鎖では見つけられない末尾の削除を、素朴なものだけでも見つける |
| B-7 | audit_log の書き換えの禁止 | `BEFORE UPDATE` のトリガーで止める（削除は保存期間のために残す） | 追記だけ（5.10 の1）をコードの誤りからも守る |
| B-8 | task.state の data | `{from, to}` に、決まった理由の符号 `reason`（いまは `daemon_restart` だけ）を足せる。作ったときも `task.state`（`from: null` → `queued`）を書く。error の文章は書かない | 再起動での失敗を見分ける。自由な文章に資格が混ざらないようにする |
| B-9 | タスクの状態の変化（5.5.3 の図に足したもの） | `starting → queued`（8.6 の3）、`starting → failed`（箱の起動に失敗）、`starting`・`running`・`waiting_limit`・`blocked_host_tool → cancelled`（`aicoop cancel`。動いていれば止める） | 図だけでは、再起動・箱の起動の失敗・待っているタスクの取り消しができない |
| B-10 | report_result の記録 | `running` のときだけ書ける。2回目は上書き。summary は1〜4000文字（コードポイントで数える）。files は空でない文字列を50個まで | 5.3.3 の上限。パスが作業ディレクトリ以下かは道具ゲートで確かめる |
| B-11 | 拒否の応答の operation | 操作が決まらないときは JSON の `null`（文字列の `"null"` ではない）。ヘッダーは `X-Aicoop-Decision` と `Content-Type: application/json; charset=utf-8` | 5.2.5 の表の「null」を JSON の値として読んだ |
| B-12 | 外から来た文章の無害化（5.4.3 の4） | 改行を LF に、タブと改行以外の制御文字・書式文字（ゼロ幅・向きの上書き・タグ文字）を取り除く。山かっこに見える文字が（空白・見えない文字・空白に見える字をはさんで）重み3以上続くところは `&lt;`・`&gt;` に、「外から来た文章」（旧字体・互換漢字・間の空白を含む）は `〔囲みの印に似た文字列〕` に書き換える | 印をそのまま使い（設計書のとおり）、中の文章だけで抜けられないようにする。言い換えまでは見つけない |
| B-13 | タスク本文の形の細部（5.4.3 の3） | `## 保留の結果` は結果があるときだけ書く。背景が空なら「（なし）」。目的・完了の条件の続きの行は2文字字下げ。返し方に意味の説明を添える。外から来た文章でない部分の中の囲みの印も無害化する | 見出しの形を崩させない。本文の中の囲みを、組み立てる側が入れたものだけにする |
| B-14 | 保留の結果の中身 | 再送の応答の本文と、部長のコメントは外から来た文章として囲む | 応答は外のサービス、部長も外の文章を読む AI なので |
| B-15 | CLAUDE.md の細部（5.4.3 の1） | 任意の部分は空白だけでも省く。必須の部分は空でも見出しを残す。CRLF は LF にそろえる | Windows で書いた md でも同じ形にする |
| B-16 | 「使える道具とルール」の書き方 | 決して一致しない許可（範囲が空、その操作にないパラメーターの制限）は書かない。パラメーターは実際に効く範囲に縮めて書く。HTTP の形・資格の環境変数（仮の札）・タグの注意も書く。srt では `workDir` で `/work` を置き換える | AI社員が迷わず、実際に使える形で伝える |
| B-17 | 順番待ちの細部 | `none` の部署も同時に1つだけ（上限には数えない）。同じ優先度・同じ時刻なら ID の順。読めない時刻は最後。利用枠が `rejected` で再開予定時刻が分からない・読めないときは、止まったままにする | 5.1.3 を CEO にも当てはめる（セッションの取り合いを防ぐ）。拒否側 |
| B-18 | 列の NULL | 設計書で NULL と書いていない列は NOT NULL。ただし `runs.ended_at`・`end_reason`（終わるまで）、`devices.x25519_public_key`、`tool_pins.approved_at`・`approval_id`（初めて見せたときは承認なし）、`host_tool_state.pid`・`started_at`・`started_by` は NULL 可。`tasks.created_at`・`grants.created_at` は NOT NULL | 実際に値がない時期がある列だけを NULL にする |
| B-19 | state.db を開く条件 | 版の記録がないのに表があるデータベース、この aicoop より新しい版は、触らずにエラー。ファイルで WAL にできなければエラー | 知らないデータベースを書き換えない（拒否側） |
| B-20 | スレッド名・セッションID | 1〜200文字で、制御文字・書式文字・行区切りを含まない。社員ID・部署IDは 6.5 の形を書く前に確かめる | `--resume` の引数やプロンプトに入るので |
### vm の箱（Gondolin）（PR #2）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| C-1 | 仮の札の形 | Gondolin の `unique` 形式 `GONDOLIN_SECRET_<48桁の16進>` | 11.5 の伏せ字の例（`GONDOLIN_SECRET_****`）と同じ形。資格ごとに別の乱数 |
| C-2 | 仮の札を `hosts` 以外へ送ったとき | 置き換えないうえに、Gondolin が通信ごと `403`（text/plain）で止める | 5.2.1 は「置き換わらない（認証エラーになる）」。止める方が拒否側 |
| C-3 | 置き換えるヘッダー | `hosts` 宛てなら、どのヘッダーでも（サービス定義の `secret.header` に限らない） | Gondolin の仕様。`BoxSecret` に `header` がない。宛先は `hosts` で絞られている |
| C-4 | ドライバーが拒否するときの `reason` | 判定の例外・知らない形・不正な status は `proxy_error`。Host ヘッダーと宛先が食い違うものは `invalid_request`（判定に回さない） | 5.2.5 の deny の形で返す。判定したものと届くものを一致させる |
| C-5 | リダイレクト | Gondolin が箱の外で追う（最大10回）。毎回 `onRequest`（判定）を通る。判定の前に本物を仮の札に戻す | Gondolin の仕様。判定に本物を見せない |
| C-6 | 内部アドレス（未決 #2） | 名前解決のあとのアドレスで、`isBlockedAddress` の範囲を塞ぐ（判定が forward でも）。応答は Gondolin の `403`（text/plain） | 箱から制御サーバー・LAN・メタデータに届かないように。読めない値は塞ぐ |
| C-7 | WebSocket | 使わせない | 切り替えたあとの中身を判定できない（P-3） |
| C-8 | 素通し（`passthroughHosts`） | 443 番だけ。ワイルドカード・IP・ポートつき・大文字・`aicoop.internal`・`.internal`/`.local`/`.localhost`・資格の `hosts` と同じ名前は、箱を作らずに失敗 | 素通しは Gondolin がホストで名前解決して直接つなぎ、IP の判定をしない。資格の宛先を素通しにすると判定を通らない |
| C-9 | Gondolin のデバッグログ | `GONDOLIN_DEBUG` があっても出さない | 通信の URL などがログに出るのを防ぐ（11.5） |
| C-10 | 環境変数の名前の重なり | `BoxSpec.env`・`exec` の `env` に `secrets` と同じ名前があれば失敗 | 本物が紛れ込んで仮の札を上書きするのを防ぐ |
| C-11 | 箱の大きさの範囲 | 既定は 2048 MiB・2 CPU（5.1.6）。範囲は memoryMiB 128〜1048576、cpus 1〜256 | 不正な値で VM を作らない |
| C-12 | マウントできない箱の中のパス | `/`、`/data`（Gondolin の FUSE）、`/etc/gondolin`、`/proc`、`/sys`、`/dev`、`/run` とその下。`.`・`..`・空の区切り。ホストのパスは絶対パスのフォルダだけ | Gondolin とカーネルの場所を守る |
| C-13 | exec の終了コード | シグナルで止まったら 128 + シグナル。`kill`・`destroy` で待つのをやめたら 137 | `Promise<number>` で返すため |
| C-14 | kill のしかた | 箱の中で、動いている exec の PID とその子孫に TERM → 2秒後 KILL。止まらなければ 5 秒で待つのをやめる | Gondolin の exec の中断は、箱の中のプロセスを止めない |
| C-15 | イメージの置き場所 | `~/.aicoop/images/base/`、部署ごとは `~/.aicoop/images/groups/<group>/`。中に Gondolin の資産と `aicoop-image.json`（Claude Code の版と SHA-256、パッケージ）。作り直しは別の場所で組み立ててから入れ替える | 6.1 の一覧に `images/`（gitに入れない）を足す必要 |
| C-16 | Claude Code の取り方 | 公式インストーラーと同じ配布元の `latest`（版の指定もできる）の `linux-x64-musl`／`linux-arm64-musl` を、`manifest.json` の SHA-256 で確かめて `/usr/local/bin/claude` に置く。`claude install` は使わない | 公式のバイナリをそのまま使う（15.1 の1）。箱は使い捨てなので更新の仕組みは要らない |
| C-17 | イメージの環境変数 | `USE_BUILTIN_RIPGREP=0`、`DISABLE_AUTOUPDATER=1`、`GIT_TERMINAL_PROMPT=0` | musl 版は箱の中の rg を使う。版はイメージで決める。資格が足りないとき git が止まらない |
| C-18 | git の資格ヘルパーの範囲 | `/etc/gitconfig` の `[credential "https://github.com"]` だけ | github.com 以外に仮の札を出さない（出しても C-2 で止まる） |
6.1 の一覧に `images/`（gitに入れない）を足す必要がある（C-15）。

### 制御サーバー本体（PR #8）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| DM-1 | 二重起動の確かめ方 | `daemon.json` の pid が動いていれば断る。さらに起動の最初に `runtime/daemon.lock`（中身は pid、排他で作る）を取り、止めたら外す。持ち主の pid が動いていない古いものは消して起動する | `daemon.json` は待ち受けのあとに書くので、それより前に2つが同時に起動すると、片方の 8.6 の後始末が、もう片方の動いているタスクを failed にしてしまう |
| DM-2 | シグナルを受けるのはどちらか | daemon の側。`startDaemon` の `handleSignals: true` で SIGINT・SIGTERM を受けて `stop()` し、止まったら登録を外す。`aicoop daemon` は true を渡す（既定は false） | 止め方を `stop()` 1つにまとめる。テストや埋め込みで登録を残さない |
| DM-3 | API の HTTP ステータス | 上の「CLI に向けて」の表のとおり | `contract.ts` にはコードだけがある |
| DM-4 | 確かめる順 | Host → トークン → 本文の上限（64 KiB）→ 道。ない道も、トークンがなければ 401 | 道があるかを、トークンのない者に教えない |
| DM-5 | 許す Host | `127.0.0.1:<port>`・`localhost:<port>` だけ（大文字・小文字は区別しない）。ポートなし・別のポート・`[::1]` は 403 | 9.2 のとおり、拒否側 |
| DM-6 | トークンの形 | 32バイトの乱数の base64url（43文字）、`api_token` は改行なし。`Authorization` は `Bearer` と空白1つとトークン（512文字まで）だけを受ける | 形の揺れを受けない |
| DM-7 | `POST /tasks` の上限 | purpose・done_when は2000文字、context は32000文字。改行・タブ以外の制御文字は 400。知らないキーも 400。`Content-Type: application/json` でなければ 415 | 設計書に上限がない。拒否側 |
| DM-8 | CLI からの操作の監査ログの actor | `owner:cli`（手動のタスク・取り消し・読み直し） | 7.2 の actor は `owner:<device_id>` だが、CLI には端末IDがない。`api_token` を読めるのはPCのオーナー本人 |
| DM-9 | 手動・cron のタスクの `context_untrusted` | false | どちらもオーナーが書いた文章 |
| DM-10 | P1 で動かせる社員 | AI の社員で、動く部署（部長は役員室）の箱の種類にドライバーがあるもの（P1 は vm だけ）。CEO（none）・srt・人間・設定にいない社員は、API では 422 `unknown_member`、cron では起こさない（ログに警告） | P1 の範囲で動かせないものを、作ってから失敗させない |
| DM-11 | `github`・`on_hold_resolved` のトリガー | 設定にあっても動かさず、`/status` の triggers では `enabled: false`（ログに警告）。動かせない社員の cron も同じ | `/status` の `enabled` を「この daemon が実際に起こすか」にそろえる |
| DM-12 | cron が遅れたとき | PCが眠っていたなどで遅れたら、遅れた回を1回だけ起こし、次は今より後の回。daemon が止まっていたあいだの回は起こさない | まとめて何度も起こさない |
| DM-13 | 同じ cron のタスクが重なったとき | 前のタスクが終わっていなくても、新しいタスクを作る（順番待ちに並ぶ） | 設計書に決めがない。黙って飛ばすと気づきにくい |
| DM-14 | 実行の記録がないのに starting・running のタスク | その部署は動いているものとして数え、次のタスクを入れない | 5.1.3 を守る側に倒す |
| DM-15 | `startRun` が例外を投げたとき | そのタスクを starting → failed（`error: start_failed`） | 同じ失敗を5秒ごとに繰り返さない |
| DM-16 | 止めるときの待ち | 実行が終わるのを最大60秒（`stopTimeoutMs`）待ち、過ぎたらログに残して閉じる | `aicoop stop` が終わらなくなるのを防ぐ |
| DM-17 | 読み直しで変えられないもの | `daemon.port` の変更は起動し直すまで効かない（ログに警告）。`company.id` が変わっていれば E-013 で読み直さない | 待ち受けは変えられない。`company.id` は「変えてはならない」（6.2） |
| DM-18 | `config.load` の subject | `company.id` | 何の設定かを表す ID |
| DM-19 | ログのファイル名 | `logs/daemon-YYYY-MM-DD.log`（`aicoop.yaml` の timezone の日付）、0600。11.5 の `daemon.log` を日付つきにした | 1日ごとの切り替えを名前で分かるように |
| DM-20 | ログで伏せるもの | キー（authorization・proxy-authorization・cookie・set-cookie・token・api_token・access_token・password・secret・secrets。1段目と2段目）の値、書き出す文字列の中の仮の札（`GONDOLIN_SECRET_****`）・Bearer/Basic/token の値・GitHub のトークンの形・`sk-ant-`・ローカルAPI のトークン | 11.5。資格がほかのキーに混ざっても出さない |
| DM-21 | 古いログの消し方 | daemon のログは名前の日付で、`logs/runs/*.jsonl` は最後に書いた時刻で、30日より前のものを、起動時と1日1回消す | 11.5 |
| DM-22 | 監査ログの保存期間の片付けが失敗したとき（つながりが壊れているなど） | 起動は続け、ログにエラーを残す | 改ざんの跡は消さない（B-5）。起動できなくすると、タスクの取り消しもできなくなる |
| DM-23 | `GET /holds` | `pending_manager`・`pending_owner` のものだけ、新しい順 | 承認を待っているものの一覧 |
| DM-24 | `runtime/` フォルダ | なければ 0700 で作る | `api_token` を置く |
| DM-25 | 取り消す前に終わったとき | `POST /tasks/{id}/cancel` は 409 `invalid_state`（状態つき） | 取り消せていないのに成功と見せない |

### 1件の実行（PR #9）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| R-1 | 資格の ID | サービスの ID と同じ（`github`・`gmail`）。Claude のログインは `anthropic` | 指示のとおり |
| R-2 | 資格の種類とサービスの組み合わせ | 登録した資格の `kind` で扱う。`static_token` はどのサービスにも使える（GitHub の fine-grained PAT など）。`github_app`・`google_oauth` は、サービス定義の `secret.kind` が同じときだけ。`anthropic_oauth` はサービスに使えない。合わなければ `failed` | 5.2.8 の表は種類ごとの扱いだけで、サービスとの組み合わせを決めていない |
| R-3 | GitHub App のトークンのリポジトリ | E(m) の github の項目の `repo` が、すべてワイルドカードなしの値で、同じ owner のときだけ名前で絞る。それ以外（制限のない項目・`*`・複数の owner）は絞らず、資格プロキシの判定で守る | インストールトークンは1つの owner のリポジトリしか名前で指定できない。指示のとおり |
| R-4 | 資格の発行に失敗したとき・未登録のとき | 発行の失敗（HTTP のエラー、通信できない）は `failed`（箱を起こさない）。未登録は渡さずに警告し、CLAUDE.md の「使える道具とルール」の最後に「登録されていない資格」の節を足す | 失敗したまま動かすと、原因の分からない認証エラーになる |
| R-5 | 準備の順番 | 道具ゲートを開く → 実行を作る → 掃除 → 資格 → ファイル → 箱 | `runs.gateway_port` が必須、隔離先 `.aicoop-quarantine/<run_id>/` に run_id が要る |
| R-6 | vm 以外の箱 | `srt`・`none` は、ドライバーが渡されても `failed`（P4） | 起動のしかたが違う（`none` で `--dangerously-skip-permissions` を付けてはならない。5.4.2、5.11） |
| R-7 | 資格プロキシのポートとプロトコル | 既定でないポート（https の 443、http の 80 以外）と、資格を使うサービスへの http は、どの操作にも当てない（`deny`・`no_operation`） | 5.2.4 はポートを見ない。平文で本物の資格を流さない |
| R-8 | 保留のファイルの形 | 1行目に `{"format":"aicoop-hold/1","method","url","headers","body_bytes"}` の JSON と改行、そのあとに本文。除くヘッダーは `authorization`・`proxy-authorization`・`cookie` と、その資格の `header` | 5.2.6 の1 に形の決めがない |
| R-9 | 保留の要約（P1） | `{kind, method, host, path, body_bytes}` だけ。5.7.1 の表の要約は P2 で作る | 部長のレビューは P2 |
| R-10 | 監査ログの対象と中身 | `proxy.decision`・`box.lifecycle`・`quarantine` の subject は run_id、`gateway.call` は task_id、`hold.state` は hold_id（by は `system`、actor は `member:<id>`）。`proxy.decision` のパスはクエリ・フラグメントを除き2048文字で切る。`quarantine` の paths は作業フォルダからの相対の元の名前 | 5.10 に subject の決めがない |
| R-11 | `report_result` を2回呼んだとき | あとのもので上書きする（どちらも受け付ける） | db の `recordTaskResult` と同じ |
| R-12 | `report_result` の `files` | `/work/...` と相対パスを受け、作業フォルダからの相対パス（`/` 区切り）にそろえ、重複は1つにして記録する。`..` を含むものはすべて不可（外に出なくても）。`\`・制御文字・リンク（とリンクを通るパス）は不可。ディレクトリは可。知らない引数は不可。タスクが動いていなければ `not_allowed` | 9.3 の `invalid_input` を拒否側で |
| R-13 | 道具ゲートの形 | セッションを持たない形（POST ごと）。GET は 405。`Origin` のあるリクエスト（ブラウザ）は 403。受け付ける Host は `aicoop.internal`・`aicoop.internal:80`・`127.0.0.1:<ポート>` | Claude Code がつなぎ直しても状態に左右されない。DNS リバインディングを防ぐ |
| R-14 | 掃除で足したもの | `projects/` の中のリンクとふつうでないファイル、`projects/<project>/memory/`（Claude Code が自動で読む指示ファイル）を消す。作業フォルダの直下は大文字・小文字を区別せずに探し、`CLAUDE.local.md` も隔離する。`.claude`・`projects`・`.claude.json` がリンクならリンクだけを消す（`projects` がリンクならセッションは引き継げない）。ホーム・作業フォルダそのものがリンクなら実行を止める。`.aicoop-quarantine` がリンクなら作り直す。移せなかったものは消す | 5.4.4 の目的（次の実行に仕掛けを残せない）を、リンクで回り道されないように |
| R-15 | スキルの複製 | ふつうのファイルとフォルダだけ。リンクは複製しない。無いスキルは警告して飛ばす | ホストのパスを指すリンクを箱へ持ち込まない |
| R-16 | 結果の決め方の優先 | 取り消し ＞ 時間切れ ＞ 報告あり（`done`）＞ 利用枠（`waiting_limit`）＞ 終了コード0（`done_without_report`）＞ `failed`。時間切れの前に報告していても `timeout`（要約は残る） | 5.5.5 の2 をそのまま読んだ |
| R-17 | 利用枠の見分け方 | `rate_limit_event` の最後の状態が `rejected`、または結果のエラーの文言（`usage limit`・`limit reached`・`hit your limit`）。再開予定時刻が分からないときは1時間後とみなし、`usage_state` にも書く。使用率は0〜1のときだけ記録 | 再開予定時刻が null のままだと、順番待ちが止まりっぱなしになる（`isUsageBlocked`） |
| R-18 | `cancel("daemon_stop")` の、Claude Code が動き出す前 | starting なら `queued` に戻す（8.6 の3 と同じ）。箱を起こす前（queued のまま）なら、そのまま | まだ何もしていないので、頼み直してよい |
| R-19 | 箱の起動に失敗した実行の `runs` | `exit_code` は null、`end_reason` は `exited` | 7.2 の `end_reason` に合う値がない |
| R-20 | 実行の記録（jsonl）の形 | 標準出力の JSON の行はそのまま（伏せ字にして）。標準エラーの行と JSON でない標準出力の行は `{"type":"aicoop_stderr"\ | "aicoop_stdout_text","text":...}` で包む。伏せ字は `****`、仮の札は `GONDOLIN_SECRET_****` | 11.5。jsonl の形を崩さない |
| R-21 | セッションID | `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` だけを記録し、`--resume` に使う | 箱の中から来る値。オプションに見える値で引数を取り違えない |
| R-22 | Claude のトークンの渡し方 | `BoxSpec.env` ではなく、`claude` の exec の環境変数にだけ渡す。`HOME` と `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` は `BoxSpec.env` | Anthropic は素通し（5.2.7）なので仮の札にはできない。渡す範囲を狭く |
| R-23 | 箱のイメージ | 部署に `packages` があれば部署のイメージが必須（なければ `failed`、`aicoop image build --group` を案内）。なければベースのイメージ、それもなければドライバーの既定 | 5.1.8 の2 |
| R-24 | タスクの終わりの状態を書く時 | 箱を壊し、実行を終えたあと | 箱が残っているうちに、同じ部署の次の実行が始まらないように（5.1.3） |
| R-25 | 時間制限を数え始める時 | Claude Code を起動するとき（running） | 資格の発行から起動までの数秒は、55分＋数秒 ＜ 60分に収まる |

### CLI（PR #10）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| CL-1 | 終了コード | 0 成功（警告だけも 0）、1 失敗（設定のエラー・検証の失敗・操作の失敗・準備ができていない）、2 使い方の誤り、3 daemon に接続できない、130 Ctrl+C | スクリプトから「daemon がいない」と「失敗」を分けたい |
| CL-2 | CLI からの監査ログの actor | `owner:cli`（`secret.change`） | CLI はオーナーがホストで打つもの。端末の ID はない |
| CL-3 | `secret set` の入力の形 | `static_token`・`anthropic_oauth` は、印字できる ASCII で空白がなく `{`・`[`・`"` で始まらなければ、トークンだけとして受け付ける。ほかは JSON | `claude setup-token` の出力をそのまま貼れるように。形が違うものは拒否側に倒す |
| CL-4 | `secret set` の誤りの文 | 中身を一切出さない。JSON.parse の文（入力の一部を含む）も使わない。**知らないキーは名前も出さない** | キーの位置にトークンを貼る事故（`{"ghp_...": ""}`）。※ `daemon/src/secrets/store.ts` の `safeKeyName` は40文字までのキー名を出すので、GitHub の古い形のトークン（ちょうど40文字）がそのまま出ます。CLI では先に弾いていますが、store.ts 側も直すのを提案します |
| CL-5 | 端末からの資格の入力 | raw モードで画面に出さずに読む。Enter で終わり、`{` で始めた JSON は括弧が閉じるまで複数行。Backspace・Ctrl+U が効く。Ctrl+C で取りやめ（130、何も保存しない）。上限 64 KiB | 貼り付けで漏らさない。GitHub App の JSON も貼れるように |
| CL-6 | `secret rm` の確かめ | 端末なら `[y/N]`、端末でなければ `--yes` が要る（なければ 2） | 消すと元のトークンがないと戻せない |
| CL-7 | 資格の ID とサービス | 資格の ID はサービスの ID と同じとみなす（`github` のサービス → secrets.json の `github`）。Claude は `anthropic`（5.4.1 の例） | 設計書に対応の決まりがない。`aicoop check` の準備の確認で使う。daemon（D）の資格の引き方と合わせる必要あり |
| CL-8 | `aicoop init` の上書き | 一切しない。`--force` は設けない（付けたら説明して 2）。`--only-missing` で足りない雛形だけを作る。aicoop.yaml がないのに state.db か secrets.json があれば作らない（会社の ID が変わるため） | 設定・会社の ID・資格を消さない |
| CL-9 | home の権限 | `init` が新しく作るときは 0700（Linux・macOS）。すでにあってほかのユーザーが読めるなら注意を出す | 本物の資格と state.db が入る |
| CL-10 | 会社の名前 | 既定「わたしの会社」。改行・制御文字・向きを変える文字は不可、100文字まで | 承認アプリに出す表示名 |
| CL-11 | `check` の「準備の確認」 | Anthropic と、設定で使うサービスの資格（種類も）、雛形の `your-org`、vm のイメージ（ベースと部署ごと、packages の足りないもの）、OS（Windows → WSL2、Linux → /dev/kvm、QEMU とイメージを作る道具 mke2fs・cpio・lz4 が PATH にあるか）、daemon（動いているか、`config_loaded_at` より新しい設定ファイルがあれば reload を案内） | 依頼の項目に、つまずきやすいもの（your-org・KVM・QEMU・読み直し忘れ）を足した |
| CL-12 | `image build` の対象 | 引数なし：ベース（images/base）と、packages のある vm の部署（images/groups/&lt;id&gt;）。`--group` で packages がなければ作らない（ベースを使う）。Windows では作らない。`--claude-version` で版を指定 | 5.1.8 の2。**daemon（D）が images/groups/&lt;id&gt; があればそれを、なければ base を使う前提** |
| CL-13 | `aicoop start` | 子は `aicoop daemon --background --home <home>`（logToStdout: false）。ログが始まる前の失敗は `logs/daemon-console.log`。約30秒待つ。すでに動いていれば 0。設定にエラーがあれば起こさない | 11.5 のログは daemon が書く |
| CL-14 | `aicoop stop` | `POST /shutdown` のあと、API が止まるまで（約2分）、続いてプロセスが消えるまで（約15秒）待つ。動いていなければ 0 | 動いている実行を止めるのに時間がかかる |
| CL-15 | `aicoop daemon` の Ctrl+C | 1回目で `stop()`、2回目で待たずに終わる（130。残った箱は次の起動で片付く。8.6） |  |
| CL-16 | Windows での daemon | vm のドライバーを渡さずに起動し、警告を出す（vm の部署のタスクは失敗する） | 4.3 の4。API や check は使える |
| CL-17 | 「daemon が動いている」の判定 | daemon.json があり、`GET /status` が daemon の形で応答する（ApiError の形の 4xx も「動いている」） | daemon.json が古く、ほかのソフトがそのポートを使っていることがある |
| CL-18 | 表示のタイムゾーン | aicoop.yaml の `timezone` を直接読む。読めなければ 6.2 の既定（Asia/Tokyo）。表では年を省く（`11-28 08:30`）こともある |  |
| CL-19 | `logs` で読むファイル | `log_path` が `~/.aicoop/logs/runs/` の中のふつうのファイルのときだけ読む（外・シンボリックリンクは読まない） | 拒否側に倒す |
| CL-20 | 外から来た文字列の表示 | 目的・要約・ファイル名・実行の記録は、端末に出す前に制御文字（ESC など）と向きを変える文字を消す（`--raw` もパイプ以外では消す） | 箱の中（Z3）の AI が、オーナーの画面を偽れないように |
| CL-21 | `run` | `--timeout` は CLI でも 1〜55 を確かめる。`--wait` は done なら 0、ほかは 1。Ctrl+C は待つのをやめるだけ（130、タスクは取り消さない） | 5.5.5 |
| CL-22 | `tasks --status` | `,` 区切りで複数。日本語の呼び名（実行中など）も受け付ける。`--limit` は 1〜500 |  |
| CL-23 | 打ち間違いの案内 | 編集距離（入れ替えを1回）と NFKC で候補を出す。よくある別の言い方（`ps`→`tasks`、`secret ls`→`secret list`、`restart` など）は、実行せずに正しいコマンドを案内する | 勝手に別のコマンドを動かさない |
| CL-24 | `aicoop login`（9.1 の表にないコマンド） | 公式の `claude setup-token` を `script`（Linux は util-linux、macOS は BSD）の擬似端末で動かし、画面はそのまま見せ、記録はメモリだけに持つ。記録から `sk-ant-oatNN-` で始まるトークンを取り出し（色・カーソル・リンクの符号を除き、端末の幅で折り返された行はつなぐ。描き直しは最後のもの）、資格 `anthropic`（`anthropic_oauth`）に保存して `secret.change` を書く。保存のあと画面と端末の履歴を消す。取り出せなければ保存せずに貼り付けを待つ。setup-token が0以外で終われば何も保存しない。登録済みなら `[y/N]`。端末からだけ（でなければ 2）。Windows では WSL2 を案内。init・check・daemon の案内は `aicoop login` に替えた | オーナーの依頼（ログインを1回で、コピーと貼り付けを要らなく）。PC の Claude Code のログイン情報は使い回さない（更新用トークンの取り合い・箱に長く使える資格を渡すことになる）。setup-token の最後の画面（トークンの出し方）は本物のログインでまだ見ていないので、取り出しに失敗しても貼り付けで続けられるようにした |

### 実行まわりの補強（PR #13）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| H-1 | 5.4.4 の掃除の範囲 | ホームの中は `.claude/projects/` 以外すべて消す（ホームの直下の `.bashrc`・`.profile`・`.gitconfig`・`.config/`・`.local/`・`.cache/` なども。`.claude.json` もここで消える）。`.claude` と大文字・小文字だけが違う名前も消す | T-13。Bash の道具は `~/.bashrc`・`~/.zshrc` を読み込み、git は `~/.gitconfig`・`~/.config/git/` を読む。何が読まれるかを数え上げると漏れる。残したい知識は `/work/notes/`（5.4.3 の2） |
| H-2 | `projects/<project>/memory/` | 大文字・小文字を区別せずに消す | 区別しないファイルシステム（macOS）では `MEMORY/` も読まれる |
| H-3 | 道具ゲートの認証（5.3.1） | 実行ごとに 32 バイトの乱数（base64url）のトークン。`Authorization: Bearer <トークン>` を SHA-256 にそろえて時間が一定の比較。Host・Origin の確認（403）のあと、パスの確認の前に見る。ない・違うものは 401 `{"error":"unauthorized"}`（`WWW-Authenticate` は付けない）。`mcp.json` の `mcpServers.aicoop.headers.Authorization` にそのまま書く。ログでは伏せ字 | ホストのほかのプロセスから呼べないように。`${VAR}` の展開は使わない（公式ドキュメントでは、資格らしい変数は url・headers で空に読まれる。`--mcp-config` での展開は書かれていない）。`WWW-Authenticate` を付けると Claude Code が OAuth の発見を始めうる |
| H-4 | 実行が動いていないときの資格プロキシ | Claude Code の exec が動いているあいだだけ判定する。それ以外は 403 `{"aicoop":"deny","operation":null,"reason":"not_allowed"}`、監査ログの `reason` は `run_not_active`。`report_result` も `not_allowed` | 5.1.3 の2「実行が終わったら札は無効」を、箱のドライバーの revoke だけに頼らない（`destroy` の失敗・箱に残ったプロセス）。5.2.5 の reason に新しい値を足さない |
| H-5 | 保留のファイル（R-8 に足す） | 仮の札（`GONDOLIN_SECRET_`）の入ったヘッダーは名前を問わず保存しない。URL の中の仮の札は `GONDOLIN_SECRET_****`。監査ログ `proxy.decision` と保留の要約の `path` の仮の札も伏せ字。本文はそのまま | C-3（どのヘッダーでも置き換わる）。11.5。本文は送るものとして保存する（5.2.1 の3） |
| H-6 | `--resume` に失敗したとき（5.4.5） | 出力（標準エラーでも stream-json の行でも）に `No conversation found with session ID` があり、init がなく、報告なし・取り消しなし・時間切れなし・終了コードが0でないときだけ、同じ箱で `--resume` なしで1回だけやり直す。時間制限は1回目と合わせて数える。見分けられないときは、error に手がかりと直し方 | 5.4.5 の5 の考え方。文言は公式ドキュメント（sessions）。箱の中から偽っても、新しいセッションで1回やり直すだけ |
| H-7 | 制御サーバーの起動時（8.6 に足す） | `runtime/` の中の実行のフォルダ（`r_…`）をすべて消す。ほかのもの（`daemon.json` など）は触らない | 落ちたときに残る（ゲートのトークン入りの `mcp.json` など）。二重起動の確かめのあとなので、動いている実行のものは消さない |
| H-8 | タスクの部署と、社員のいまの部署が違うとき | 箱を起こさずに failed（「部署が変わっています。頼み直してください」）。`RunHandle.groupId` はタスクの部署 | 順番待ちはタスクの部署で「1つの箱で1人」（5.1.3）を数える |
| H-9 | 利用枠の rejected の再開予定時刻（5.4.6、R-17 を広げる） | 実行中の記録でも、分からなければ1時間後。いまから7日より先なら7日後 | 箱の中から偽の rate_limit_event を出されても、会社全体を止めっぱなしにさせない。週の枠より先の再開はない |
| H-10 | 資格の発行の待ち時間（5.2.8） | 30秒（`AbortSignal.timeout`）。過ぎたら failed | 実行を starting のまま止めない |
| H-11 | `report_result` の summary（B-10 に足す） | タブ・改行・復帰以外の制御文字（C0・DEL・C1）と、向きを変える文字（U+061C・U+200E・U+200F・U+202A〜U+202E・U+2066〜U+2069）は `invalid_input` | オーナーの画面（CLI・承認アプリ）にそのまま出る。CLI の無害化と同じ範囲 |

### P1 の結合テストと、そこで見つけたもの（PR #11・#16）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| E-1 | 5.4.2 の環境変数の表 | vm の箱だけ `IS_SANDBOX=1` を足す | 箱の中のコマンドは root で動き、Claude Code は root では `--dangerously-skip-permissions` を断って何も出さずに終わる（本物の Claude Code で見つけた不具合）。root でないユーザーで動かす案は、Gondolin の exec にユーザーを選ぶ口がなく、マウントの権限も変わるので退けた |
| E-2 | 本物の VM の結合テスト | `AICOOP_VM_E2E=1` のときだけ動かす。CI では偽の `claude` のイメージと本物の Claude Code のイメージを毎回作る。forward したリクエストは本物の GitHub に偽のトークンで届く | 完了条件を変更のたびに確かめ続ける |
| E-3 | WebSearch | 箱の中では常に使わせない（起動の引数 `--disallowedTools WebSearch` と管理設定の `permissions.deny`） | WebSearch は Anthropic の側で動き、素通しの通信の中を通るので、資格プロキシの判定を通らずに外へ文字列を出せる（T-3）。Web は `web.read` で読む |

### 端末・パスキーでのログイン・承認の署名（PR #18）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| AP-1 | 端末の登録・取り消しの監査ログ | 種類 `device.state`、data は `{from: null\|"active", to: "active"\|"revoked", by}`、subject は端末ID。名前などは書かない | 5.10 の3の表にない。取り消しは `approval` ではない |
| AP-2 | 署名カウンターの「増加」 | WebAuthn の仕様と @simplewebauthn/server のとおり：保存した値か新しい値が0より大きければ、増えなければ拒否（0 に戻るのも拒否）。両方0（数えない認証器）なら受ける | 同期するパスキー（iCloud キーチェーン・Google パスワードマネージャー）はずっと0。常に増加を求めると使えない。使い回しは nonce と1回限りのチャレンジで防ぐ（テストで確かめた） |
| AP-3 | ペアリングのコード | Crockford の base32 で10文字（50ビット）、`XXXXX-XXXXX`。ハイフン・空白・小文字は許す。違うコード（知らない・壊れた・取り消したもの）が合わせて5回来たら、いまのコードも無効（`too_many_attempts`）。有効なコードは同時に1つ（新しいコードで前のコードは `superseded`）。状態はメモリだけ | 5.8 の2の1に長さ・回数の定めがない |
| AP-4 | 確認コード | SHA-256（正規化JSON `{v:"aicoop-pair-local-1", code, credential_id, public_key}`）の先頭4バイトを 10⁶ で割った余り、6桁 | 「パスキーの公開鍵（とコード）から決まる6桁」 |
| AP-5 | 登録の期限 | コードの10分は `y` まで含む（登録したまま10分たてば、`y` を押しても有効にしない）。登録の確かめに失敗したら、そのチャレンジは捨てる。名前・確認コードを返すのは registered・activated のときだけ | 拒否側 |
| AP-6 | パスキーの作り方 | rpName `AIcoop（会社名）`、userID は SHA-256(`aicoop-owner:` + company_id) の先頭16バイト、residentKey `preferred`、UV `required`、attestation `none`、excludeCredentials は登録済みのすべて（取り消したものも）、方式は EdDSA・ES256・RS256（ML-DSA は入れない）、timeout 2分。応答の id と authenticatorData の資格情報の ID が違えば拒否 | ML-DSA は Node の実験的な機能で、警告が出る。同じ認証器を2回登録させない |
| AP-7 | @simplewebauthn/server が確かめないもの | iframe の中の応答（`crossOrigin: true`・`topOrigin` つき）は自分で拒否。署名の応答の資格情報の ID が、確かめる端末のものかも自分で確かめる | ライブラリは topOrigin のない crossOrigin を通し、資格情報の ID は比べない |
| AP-8 | セッション | 32バイトの乱数（base64url）。サーバーは SHA-256 だけをメモリに持つ（daemon を起動し直すとログアウト）。期限は8時間（延ばさない）。32個まで（古いものから捨てる）。リクエストのたびに端末が有効かを state.db で確かめる。端末を取り消したらすぐ消す | 期限の定めがない |
| AP-9 | クッキーの属性 | `HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=28800`。`Secure` は付けない | 指示は `Path=/` だったが、クッキーはポートで分かれず、localhost のほかのポートのサーバーにも送られる。送る範囲を API に絞った（承認アプリの動きは変わらない）。http://localhost で配るので Secure は付けられない |
| AP-10 | CSRF | クッキーで来た GET・HEAD 以外は、`Origin` が `http://localhost:<port>` と完全に一致しなければ 403 `forbidden_origin`（新しいエラーコード）。`Sec-Fetch-Site` があれば `same-origin`・`none` だけ（GET でも）。認証なしの POST（ペアリング・ログイン）も `Origin` を確かめる | SameSite=Strict でも、localhost のほかのポートは同じサイトなので、クッキーが送られる |
| AP-11 | 道ごとの認証 | Bearer だけ：`/shutdown`・`/reload`・`/pairing/local*`。クッキーだけ：`/approvals/*`・`/auth/me`・`/auth/logout`。認証なし：`/pairing/options`・`/pairing/register`・`/auth/login/*`・`/app/*`・`/`。そのほか（既存の道、`/devices*`、これから足す道）は両方。`Authorization` があれば Bearer として確かめ、違えばクッキーに切り替えない | 指示のとおり。承認は承認アプリの署名だけ（P-4）。止める・読み直す・登録のコードは CLI だけ |
| AP-12 | 確かめる順（DM-4 を変えた） | Host → 本文の上限 → 認証なしの道 → 認証。認証なしの道は、Hono の道として認証より前に登録する | パスの書き方（%xx など）で、認証の分け方と道が食い違わないように |
| AP-13 | 承認アプリからの操作の actor | タスクの作成・取り消し、端末の取り消しは `owner:<device_id>`（CLI は `owner:cli` のまま） | どの端末がしたかを監査ログに残す |
| AP-14 | 出した payload の覚え方 | daemon のメモリだけ（起動し直すと、出してあった payload は使えない）。64個まで。期限を過ぎても10分は覚えておき、`approval_expired` と答える。assert で1回使ったら（失敗しても）捨てる。出した端末以外のセッションからは `payload_mismatch` | 拒否側。決まった形がない |
| AP-15 | assert で確かめる順とエラー | 形 → nonce（知らないもの：使い済みなら `nonce_used`、でなければ `payload_mismatch`）→ 正規化JSON の完全一致 → 出した端末 → 期限（`expires_at` ちょうどまで受ける）→ 署名 → トランザクションの中で used_nonces の期限切れを消す → nonce → 対象がまだ待っているか（`not_pending`）→ 要約の SHA-256 が payload と同じか（違えば `payload_mismatch`）→ カウンターの比較更新 → used_nonces → approvals → 監査ログ `approval` → `target.apply`。HTTP は `signature_invalid`・`payload_mismatch`・`approval_expired` が 400、`nonce_used`・`not_pending` が 409、`pairing_invalid` が 404 | オーナーが見た要約と、効力を持つものを一致させる |
| AP-16 | `afterApply` | 応答は待たない（`subject_status` は apply のあとの状態）。daemon を止めるときは終わるのを待つ。失敗はログだけで、承認の記録は残す | 保留の再送で応答が遅れないように |
| AP-17 | approvals の保存の形 | `payload` も `assertion` も正規化JSON | あとで同じバイト列で確かめ直せる |
| AP-18 | used_nonces の掃除 | assert のたびに、期限を過ぎた行を消す | 7.2「期限を過ぎたら消す」 |
| AP-19 | 承認アプリの配信 | 認証なし。拡張子のないパスは index.html、拡張子があって無ければ 404。`.` で始まる名前・`\`・`/`（%2f）・`:` などを含む名前・制御文字は 404、realpath で dist の外は 404、16 MiB まで。CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、COOP・CORP `same-origin`、`Cache-Control: no-store`。dist が無ければ 503 の HTML。`127.0.0.1` で開いたら `localhost` へ転送 | パスキーの RP ID は localhost なので、127.0.0.1 の画面では使えない。承認アプリ（P2-c）は inline の script・style を使わないこと |
| AP-20 | ログインの options | 有効な端末がなければ 409 `invalid_state`。チャレンジは2分・1回限り（確かめる前に消す）、16個まで | 拒否側 |
| AP-21 | 端末の名前 | 前後の空白を除いて1〜40文字、制御文字・書式文字・行区切りを含まない | api.ts の「1〜40文字」 |
| AP-22 | CLI の決まり | `pair --local` は端末（TTY）からだけ（`--yes` はない）。承知は `y`・`yes`・`はい` だけ。Ctrl+C（待ち・確かめのどちらでも）はコードを取り消して 130、N は 1。`pair`（`--local` なし）は 2。`devices revoke` は端末なら `[y/N]`、でなければ `--yes` が要る（2）。ない端末・取り消し済みは 1。`approve`・`reject` などは「承認をするコマンドはない」と案内（2） | 確認コードを見比べるのは人。9.1・P-4 |
| AP-23 | 承認アプリからの端末の取り消し | ログインしていればできる（自分の端末も）。パスキーの署名は要らない | 5.8 の4の(6)。なくした端末をすぐ止めるのは守りを強める側。消されても CLI で登録し直せる |

設計書の本文では、5.10 の表に `device.state`（端末の登録・取り消し）、9.2 の表に端末・ペアリング・ログイン・承認アプリの配信の道を足す必要がある。

### 保留と再送・一時権限・部長のレビュー（PR #19）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| HL-1 | state.db 版2 | `holds.resolved_at`（結果が出た時刻）・`grants.manager_comment` を足した | 「前回の実行以降に結果が出たもの」を決めるため。7.2 の grants に部長のコメントの列がない |
| HL-2 | `drafts/send` の保留 | 取ってきた下書きの中身で `messages/send` に固めて保存・再送する（下書きは残る） | 社員は `draft.update` を持つので、ID のまま送ると承認のあとに中身を差し替えられる |
| HL-3 | `pr.merge` の保留 | 本文に取得時の head の `sha` を付ける（指定済みで違えば警告） | 承認のあとの push で中身を変えさせない |
| HL-4 | 下書き・PR を取れないとき | 保留にせず 403 `hold_failed`（DenyReason に追加、プロンプトにも説明） | 中身を確かめられないものを承認に回さない |
| HL-5 | 二重に送らない方法 | 送る前に `response_path` を書く（claim）。起動時、印のある approved は送り直さず `replay_failed`、印のない approved は期限内なら送る | 5.2.6 の2「1回だけ」 |
| HL-6 | 再送の直前の確かめ | いまの設定で判定が deny・操作が食い違う・http・既定でないポートなら送らず `replay_failed` | 設定から外した操作を送らない |
| HL-7 | 資格ヘッダーの形 | 保存時に `Bearer GONDOLIN_SECRET_****` のような形（auth.template）を残し、再送で本物を入れる。なければ `Bearer` | Bearer 以外の資格でも送った形のまま付け直す |
| HL-8 | 結果の範囲 | replayed・replay_failed・rejected・expired すべてを結果とし、タスク本文と on_hold_resolved の対象にする | 却下・期限切れも続きを考えるのに要る |
| HL-9 | on_hold_resolved の完了の条件 | 「保留の結果を確かめ、続きの作業をして、report_result で報告した」 | 6.6 で書けないので固定 |
| HL-10 | 申請中の一時権限の期限 | 申請から `holds.ttl_hours` で expired | 決まらない申請を残さない（拒否側） |
| HL-11 | レビューのタスクのスレッド | 毎回新しい（`task-<task_id>`） | 前のレビューの外の文章を持ち込ませない |
| HL-12 | review_decision の上限 | comment は必須・2000文字・制御文字不可。担当外と無い項目は同じ not_allowed。`k_` は not_allowed（P4） | 9.3 に上限がない |
| HL-13 | request_access の params | 値は文字列か配列。上限の範囲の中か（glob は同じ・`*`・前方一致の `*` の中だけ）。mode は範囲を含む ceiling の項目の厳しい方 | 広さを比べられないものは範囲の外 |
| HL-14 | 承認の対象 | pending_owner で期限内のときだけ。部長のレビュー前はオーナーも決められない | 「部長 → オーナー」の順 |
| HL-15 | API の形 | `HoldView.operation` は `<service>.<operation>`。`HoldView.summary` は要約＋`manager_comment`（describe と同じ）。`GrantView` に `manager_comment`・`summary` を足した。`GET /holds` は status がなければすべての状態 | summary_sha256 のもとを API と describe でそろえる |
| HL-16 | 要約に足したもの | gmail は From・添付ファイル名・警告（同名ヘッダーが複数・Resent-*・読めない文字コード）、pr.merge は head・base・merge_method | 宛先を読み違えて隠されないように |
| HL-17 | タスク本文の保留の結果 | 20件まで、応答の本文は UTF-8 で読めるときだけ先頭4000文字 | プロンプトを大きくしすぎない |

### 承認アプリ（PWA）の画面（PR #22）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| UI-1 | 署名の前の、承認アプリ側の確かめ | payload の type・id・decision が選んだものと同じ、チャレンジ = base64url(SHA-256(正規化JSON(payload)))、summary_sha256 = SHA-256(正規化JSON(表示した要約。保留は `HoldDetailView.summary`、一時権限は `GrantView.summary`))、allowCredentials が空でない。1つでも合わなければ署名しない。要約のない一時権限は承認・却下させない | 中継（P3）を通っても、表示したもの以外に署名しない（P-4、T-4）。拒否側 |
| UI-2 | userVerification | daemon の options に何が書いてあっても `required` にして呼ぶ（ログイン・登録・署名） | 5.8 の2・3。弱める側に倒さない |
| UI-3 | 元のリクエスト全体を開くまで承認を押せない | 要約の種類が gmail_message・social_post・知らない種類・種類なしの保留は、開くまで「承認する」を押せない（却下は押せる）。github_pr_merge は促すだけ | 10.2 の「推奨」を、送信系では強めた |
| UI-4 | Gmail の raw | 本文が `{"raw": base64url}` なら、読める形（RFC 2822 のまま。MIME はほどかない）も見せる | Bcc・添付・HTML を承認の前に見られるように |
| UI-5 | 承認・却下できない条件 | 届いていない、期限が過ぎた（読めない期限も過ぎたとみなす）、最新を確かめられていない（控え・前に読めたものを見ている）、pending_owner でない | 5.8 の6 を広げた。拒否側 |
| UI-6 | 署名を送ったあとに届かない・5xx | 「決定が効いたか分からない」と言い、やり直しのボタンを出さずに読み直す | 効いていないのに効いたと思わせない。二重に決めない |
| UI-7 | 端末に残す控え（5.8 の6） | localStorage に `/holds`（要約を除く）・`/grants`（理由を除く）・`/status`・`/usage` だけ。ログアウト・この端末の取り消しで消す。Service Worker は API の応答を控えない | 「最後に受け取った状態」と、中身（メールの本文など）を端末に残さないことの両立 |
| UI-8 | 期限の目立たせ方 | 1時間を切ったら ⚠ と強い枠、6時間を切ったら ◔。並びは期限の近い順、一時権限の申請（承認を待つ期限がない）は保留のあとに古い順 | 5.8 の4 |
| UI-9 | 見えない文字の範囲 | 改行・タブ以外の C0・DEL・C1、向きを変える文字、`\p{Cf}`（ゼロ幅・タグ文字・BOM など）、U+2028・U+2029、ハングルの埋め字など、対にならないサロゲート、単独の CR を `[U+XXXX]` の印に（文字そのものは出さない） | H-11・CL-20 の範囲に足した |
| UI-10 | 新しい版の入れ替え | 知らせるだけ。「読み込み直す」を押したら入れ替える | 承認の途中で勝手に読み込み直さない |
| UI-11 | 確かめの窓 | はじめのフォーカスは「やめる」。Esc で閉じる | Enter だけで決まらない |
| UI-12 | 端末の名前・手動のタスクの入力 | 送る前にも確かめる（名前は1〜40文字で制御文字・書式文字・行区切りなし、タスクは DM-7・B-20・A-2 の形） | 打ち間違いを daemon に送らない |
| UI-13 | 監査ログを新しいものから | `after` を倍々にしてから二分探索で最後の seq を探し、そこから200件ずつ。種類の絞り込みは読み込んだ分の中で | API に「新しい順」「種類」の問い合わせがない |
| UI-14 | 一時権限の詳細 | `GET /grants`（状態の指定なし。既定の100件）から ID で探す | `GET /grants/{id}` がない。古い申請は見つからないことがある |
| UI-16 | 承認待ちの一覧の読み方 | `GET /holds?status=pending_manager,pending_owner`・`GET /grants?status=pending_manager,pending_owner` | status なしはすべての状態で、決まったものが100件を埋めうる |
| UI-15 | `#/pair?code=…` | コードを入れておく（押すのは人） | CLI の URL にコードを足せば手で打たなくてよい（いまの CLI は `#/pair` だけ） |

### P2 の仕上げ：S-5・aicoop holds/grants・片付け・上限（PR #25）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| FN-1 | 保留の出しすぎの上限 | 1つの実行で10件・1人の社員の直近24時間で30件。作ったものを状態を問わず数える（却下・期限切れも）。超えたら 403 deny `reason: hold_limit`（`DenyReason` に足し、「使える道具とルール」にも説明を足した） | 保留1件ごとに部長のレビューのタスク（Claude Code の実行）ができる。乗っ取られた社員に利用枠を使い切らせない。承認アプリを埋めさせない |
| FN-2 | 一時権限の申請の上限 | 1つの実行で3件・1人の社員の直近24時間で10件。超えたら `daily_limit`（実行あたりも同じコード。メッセージで分ける）。実行あたりの数は道具ゲートのメモリで数える | 9.3 に `daily_limit` がある。`grants` 表に実行の ID がない |
| FN-3 | 「1日」の数え方 | 直近24時間（ちょうど24時間前のものも数える） | `tickets.daily_limit`（timezone の0時から）と違うが、0時をまたいで2倍出せないほうが拒否側。timezone に頼らない |
| FN-4 | 上限を設定にするか | 固定の値（`aicoop.yaml` にキーを足していない） | キーを足すのは 6.2 の変更。要るなら `holds.per_run`・`holds.daily_limit` などを足すことを提案 |
| FN-5 | 保留のファイルを残す日数 | 決まってから30日（`resolved_at`、なければ `decided_at`）。まだ決まっていない・`approved`（送る前・送っている途中）のものは消さない。state.db の行は残す。決まった時刻が読めないものも消さない | 11.5 のログの30日にそろえた。送るもの・見せるものを消さない |
| FN-6 | 行のない保留のファイル | `h_<ULID>.bin`・`h_<ULID>.response.bin` の名前で行のないものは、ファイルの時刻から30日で消す。ほかの名前は触らない。消す場所は ID から決め（行のパスは使わない）、リンクはたどらない | 保存してから保留を作るまでに落ちると残る |
| FN-7 | 消したあとの見え方 | `GET /holds/{id}` の `request` は空（method・url が `""`）、`response_text` は null（API の形は変えない）。CLI は「保存したリクエストは残っていません」。30日以上動かなかった社員に届く保留の結果は、応答の本文なしで届く | 承認アプリと形を共有しているので、API の形を変えない |
| FN-8 | `aicoop holds`・`grants` の一覧の形 | 1件を2行（1行目：ID・状態・操作・期限（grants は時間も）の表、2行目：社員と要約・理由）。状態は短い呼び名（承認待ち・部長待ち・送信済みなど）。詳細では長い呼び名 | ID が27桁なので、1行に並べると80桁に収まらない |
| FN-9 | 本文の「先頭だけ」 | 20行・2000文字（要約の本文・元のリクエストの本文・再送の結果）。テキストでない本文は `--full` のときだけ base64。`--full` でも daemon が見せる先頭 256 KiB まで | 設計書に長さの決めがない |
| FN-10 | `aicoop status` の承認待ちの数え方 | `GET /holds`・`GET /grants`（`status=pending_manager,pending_owner`、500件まで）で数える。`StatusResponse` は変えない。`/holds` のない古い daemon では、これまでの「承認待ち N件」だけ | `StatusResponse` は承認アプリと形を共有している。`holds.pending` は部長待ちも含み、一時権限を含まない |
| FN-11 | 止まったままの利用枠の表示 | `rejected` のまま再開予定時刻 + 60秒を過ぎていたら、CLI は「止まっていた（再開予定時刻を過ぎたので、タスクを始めています）・〜に戻る予定でした」と出す。`usage_state` は書き換えない | `usage_state` は次の `rate_limit_event` まで `rejected` のまま。daemon はもうタスクを始めている |
| FN-12 | 承認・却下の打ち間違い | `holds`・`grants`・`hold`・`grant` のあとの `approve`・`reject`・`accept`・`deny`・`sign`・`pass`・`decide` は、引数として読まず、承認アプリの案内で終了コード 2（何も送らない） | 9.1・P-4（AP-22 と同じ） |
| FN-13 | `aicoop run --wait` と利用枠 | `waiting_limit` は終わりの状態ではないので待ち続け、「利用枠待ち（〜に再開する予定）」と出す | 再開すれば同じタスクが done になる |

### 設定の画面と資格の画面（PR #30・#32）

| # | 内容 | いまの実装 | 理由 |
|---|---|---|---|
| ST-1 | 設定の画面で扱えるパス | `CONFIG_FILE_PATH_PATTERN`（`@aicoop/shared/api`）：6.1 の7つの yaml、`services/<ID の形>.yaml`、`prompts/` の下の md（フォルダは2段まで、各段は英数字・`_`・`-` で1〜64文字）。大文字・`.yml`・ほかの拡張子は扱わない | 5.14 の4の1 は「6.1 の yaml と prompts の md」だけ。書き方の揺れ（大文字・`.`・`..`）は拒否側 |
| ST-2 | パスの書き方の確かめ | URL のパスをデコードせずにパターンと照らし、`%` を1つでも含めば「ない」（404）。扱えないパス・シンボリックリンク・ないファイルは、どれも 404 `not_found`（あるかどうかを見せない）。本文の `path` で扱えないものは 400 | `%2e`・`%2f`・`%5c`・`%00` をデコードして読み直すと、確かめと道が食い違いうる |
| ST-3 | シンボリックリンク | home からファイルまでの途中のフォルダとファイルを1つずつ lstat し、リンク（ふつうのファイル・フォルダでないもの）なら一覧に出さず、読み書きしない。書く直前にもう一度確かめる | 5.14 の4の1・受け入れ条件。リンクの指す先を書き換えない |
| ST-4 | 大きさの上限 | 1つのファイル 256 KiB、1回の変更で 20 ファイル、`POST /config/changes` の本文 1 MiB（この道だけ。ほかは 64 KiB のまま）。UTF-8 として読めないファイルは扱わない | 64 KiB では、プロンプトを含む変更に足りない |
| ST-5 | 署名を待つ変更 | daemon のメモリの中だけ（daemon を起動し直すと消える）。作ってから10分で失効。期限内のものは設定・資格を合わせて同時に16件まで（超えたら 409 `invalid_state`）。ID は新しい接頭辞 `x_`（`IdKind` に `change` を足した。7.1 の表にない） | 資格の値を state.db に書かない。payload（2分）と同じくメモリに置く |
| ST-6 | 検証のしかた | `loadConfig` に `overrides`（相対パス → 中身）を渡し、本物のファイルを書かずに、変えたファイルを重ねた全体を検証する。変更を作るときと、署名が通って書く直前の2回 | 6.10 と同じ検証を、一時ディレクトリに写さずに行う。変更に入っていないファイルが、作ったあとで壊れることがある |
| ST-7 | 保存の順と失敗 | 署名が通ったら、`approvals` の記録と同じトランザクションの中で：①ファイルが base_sha256 のままか（違えば 409 `conflict`）②もう一度検証（422 `config_invalid`）③一時ファイルから rename で書く ④読み直す（`aicoop reload` と同じ）。読み直しに失敗したら書いたファイルを元に戻し（新しいファイルは消す。作ったフォルダは残す）422。どれかで失敗したら、`approvals` に記録せず、その変更も捨てる（作り直してもらう） | 5.14 の4の4。失敗した変更を、同じ署名で使い直させない |
| ST-8 | `company.id` の変更 | 変更を作るときの検証は通り、書いたあとの読み直しで拒まれて元に戻る（422） | 読み直しの決まり（変えられない）を1か所にしておく |
| ST-9 | ApiErrorCode `conflict` | 新しく足した（409）。変更を作ったあとで、ファイル・資格が書き換えられたとき（作るときの base_sha256 が違うとき、新しいファイルのつもりがもうあるときも） | 9.2 のエラーの一覧にない |
| ST-10 | 資格の書き換えの確かめ | 変更を作ったときの資格（種類・中身・更新日時）の SHA-256 をメモリに持ち、署名のあとに違えば 409 で書かない | 設定と同じく、あとから来た変更（CLI の `secret set` など）を黙って消さない |
| ST-11 | 要約の形 | 設定：`{files: [{path, before_sha256, after_sha256, diff}]}`（新しいファイルは before_sha256 が null）。資格：`{id, kind, action}`（action は `create`・`replace`・`delete`。削除の kind はいま登録されている種類）。どちらも `kind` の欄（保留の要約の種類）は持たない | 5.14 の5「資格の ID・種類・登録か削除か」。置き換えと登録を分けて見せる |
| ST-12 | 差分 | unified diff（前後3行、Myers）。変更が大きすぎる（編集の距離が2000を超える）ときは、前をすべて消して後をすべて足す差分にする。中身が変わらないファイルの変更は 400 | 計算の時間とメモリを抑える |
| ST-13 | 監査ログ | `config.change`：subject は変更の ID、data は `{change, files: [{path, before_sha256, after_sha256}]}`（中身は書かない。5.10 の表にない行）。資格は CLI と同じ `secret.change` `{secret_id, change: set|rm}`。actor は署名した端末 `owner:<device_id>`。読み直しの `config.load` の actor も、その端末にした | 5.14 の4の5 |
| ST-14 | 状態の呼び名 | 変更の状態は `pending`・`expired`、署名のあとは `applied`（保存した）・`cancelled`（reject で取り消した） | 承認の `subject_status` に返す値。`reject` は「取り消し」 |
| ST-15 | Bearer・中継から | `requireLocalSession`：クッキーのセッションだけ通す。Bearer は 401 `unauthorized`、それ以外（P3 の中継の呼び手）は 404 `not_found`（いまは中継がないので、来ることはない） | 5.14 の6、D-27 |
| ST-16 | 資格の値の受け取り | `{id, kind, value}`。value は種類の形のオブジェクト（`validateSecretValue`）か、`static_token`・`anthropic_oauth` ならトークンだけの文字列（前後の空白を除き、中に空白・全角の文字があれば誤り。CLI と同じ）。本文の知らないキーは、名前も出さずに数だけ言う | 11.5。資格をキーの位置に貼ることがある |
| ST-17 | `approvals.subject_type` | `config_change`・`secret_change` も入る（7.2 の表にない） | 5.8 の3 の payload の type に足したもの |
| ST-18 | 書いたファイルの権限 | 0644（一時ファイルを `wx` で作って rename）。`secrets.json` は今までどおり 0600 | 設定（yaml・md）は git で管理する前提のふつうのファイル |
| ST-19 | 承認アプリの道 | `#/settings`（設定）・`#/secrets`（資格）。ナビの最後に「設定」「資格」を足した。ファイルの選択は道に入れない（画面の中の状態） | router の変更を最小にする。パスを道に入れると、確かめる場所が増える |
| ST-20 | 署名の部品の使い回し | 既存の ApprovalPanel・ConfirmDialog を、文言（見出し・ボタン・結果）を渡せるようにして使う。「保存する」が approve、「取り消す」が reject。設定・資格の確かめと署名は `components/ChangeReview.tsx`（`ConfigChangeReview`・`SecretChangeReview`）にまとめ、準備の画面からも使えるようにした | 署名の手順（要約のハッシュの照合を含む）を1か所に保つ |
| ST-21 | 署名の前の要約の照合 | 変更を作ったときの応答の `summary` をそのまま表示し、その正規化JSON の SHA-256 が payload の `summary_sha256` と合わなければ署名しない（保留・一時権限と同じ） | 5.8。daemon と同じ値になることは daemon の受け入れテストで確かめる |
| ST-22 | 署名のあとの失敗 | `conflict`・`config_invalid` は「やり直す」を出さない（変更はもう使えないので、読み直して作り直す）。`config_invalid` の issues は、その場に並べる | ST-7 |
| ST-23 | 編集の形 | 1度に1ファイル（API は20ファイルまで受ける）。中身を変えるまで「確かめる」は押せない。変更を作ったあとは、編集欄を読み取りだけにする（「編集に戻る」で作り直す） | 表示した差分と、保存するものを食い違わせない |
| ST-24 | 新しいファイル | パスを入れて「新しいファイルを作る」。daemon と同じパターンで確かめてから開く（扱えないパスは送らない）。もうあるパスなら、そのファイルを開く | 5.14 の4の1 |
| ST-25 | 資格の入力欄 | 中身の欄はすべて `type="password"`（`autocomplete="off"`、パスワード管理ソフトの保存の印も外す）。React の状態に入れず、「変更を作る」を押したら送る前に欄を空にする（ID の誤りなどで送らないときも空にする）。ID・App ID・Installation ID・クライアント ID はふつうの欄 | 5.14 の5「値を画面に残さない」 |
| ST-26 | 秘密鍵（PEM）の改行 | 1行の欄は改行を落とすので、`-----BEGIN … -----` と `-----END … -----` のあいだを64文字ずつに折り直して送る | GitHub App の .pem を type=password の欄で受けるため |
