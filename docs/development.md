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

- [ ] P2：保留と再送・部長のレビュー・一時権限（5.2.6、5.7）、パスキーでの承認と `aicoop pair --local`（5.8）、承認アプリ（PWA）

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
| CL-11 | `check` の「準備の確認」 | Anthropic と、設定で使うサービスの資格（種類も）、雛形の `your-org`、vm のイメージ（ベースと部署ごと、packages の足りないもの）、OS（Windows → WSL2、Linux → /dev/kvm、QEMU が PATH にあるか）、daemon（動いているか、`config_loaded_at` より新しい設定ファイルがあれば reload を案内） | 依頼の項目に、つまずきやすいもの（your-org・KVM・QEMU・読み直し忘れ）を足した |
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
