# AIcoop

自分のPCの中に「AIの会社」を作り、部署に分かれたAI社員に、営業・開発・マーケティング・デザインの仕事をさせるOSSです。

- AI社員には本物の資格（トークンやパスワード）を一切渡しません。箱（microVM）に閉じ込め、外への通信はすべて資格プロキシがルールで判定します。
- メール送信や main へのマージのような外に出る大事な操作は、オーナーがスマホでパスキー署名して承認してから実行されます。
- 公式の Claude Code を、そのままオーナー本人のサブスクの枠で動かします。

> **状態：開発の初期段階（P1 の途中）です。AI社員に仕事をさせるところまでは、まだ動きません。**
> `aicoop` コマンドで、会社の雛形づくり・設定の検証・資格の登録・箱のイメージづくり・監査ログの確認はできます。
> 制御サーバーの本体（タスクの実行・資格プロキシ）は作っているところで、入るまでは `aicoop daemon`・`aicoop start` が「まだ入っていません」と言って止まります。

## 設計書

全体の設計は [docs/design.md](docs/design.md) にあります。本書に書いたことはすべて「決定」として扱い、変えるときは第18章「決定の記録」に追記してから本文を直します。

## 使い方（P1）

必要なもの：Node.js 24 LTS、pnpm 11。vm の箱を動かすには、Linux（KVM が使えること）か macOS と、QEMU。
Windows では、WSL2 の中で動かします（設計書 4.3）。

```sh
git clone https://github.com/raporapo/AIcoop.git && cd AIcoop
pnpm install
alias aicoop="node $PWD/packages/cli/bin/aicoop.ts"   # または、リポジトリの中で pnpm aicoop <コマンド>

aicoop init --name "サンプル商会"   # ~/.aicoop に雛形を作る。次にすることが番号つきで出ます
# ~/.aicoop/groups.yaml の your-org を、自分の GitHub のユーザー名か組織名に書き換える
claude setup-token                  # Claude のトークンを作る
aicoop secret set anthropic --kind anthropic_oauth            # 貼り付ける（画面には出ません）
aicoop secret set github --kind github_app < github-app.json  # GitHub App の資格
aicoop check                        # 設定のエラー・警告と、動かす準備を確かめる
aicoop image build                  # vm の箱のイメージを作る（数分）
aicoop start                        # 制御サーバーを裏で起動する

aicoop run dev-implementer --purpose "README の誤字を直す" --done-when "PR を出して URL を報告した"
aicoop logs <task_id> --follow      # 実行の様子を見る
aicoop tasks                        # タスクの一覧（aicoop status で全体の状態）
aicoop audit verify                 # 監査ログが書き換えられていないかを確かめる
aicoop stop
```

- 各コマンドの使い方・例は `aicoop --help`、`aicoop <コマンド> --help`。打ち間違えると「もしかして」が出ます。
- 設定の置き場所は `~/.aicoop`。環境変数 `AICOOP_HOME` か、`--home <dir>` で変えられます。
- 設定を変えたら `aicoop check` で確かめてから `aicoop reload` で読み直します（保存しただけでは反映されません）。
- `--json` を付けると機械向けの出力になります（`check`・`status`・`tasks`・`secret list`・`audit verify` など）。
  色は端末に出すときだけ付きます（`NO_COLOR` か `--no-color` で消せます）。
- 終了コード：`0` 成功、`1` 失敗（設定のエラー・検証の失敗など）、`2` 使い方の誤り、`3` 制御サーバーに接続できない、`130` Ctrl+C で中断。

### 承認アプリ（P2：PC のブラウザ）

外に出る重い操作（メールの送信・main へのマージなど）と、一時権限の申請は、承認アプリでパスキーで署名して承認・却下します（設計書 5.8）。
承認アプリは制御サーバーが `http://localhost:7070/app/` で配ります（ポートは `aicoop.yaml` の `daemon.port`）。

```sh
pnpm --filter @aicoop/approver build   # 承認アプリを作る（packages/approver/dist/。初めてのときと、更新したとき）
aicoop start
aicoop pair --local                    # この PC のブラウザを端末として登録する。コードと URL が出ます
# 出た URL（http://localhost:7070/app/#/pair）をブラウザで開き、コードと端末の名前を入れてパスキーを作る
# ブラウザに出た6桁の数字が、ターミナルの数字と同じか確かめて、ターミナルで y を押す
```

- そのあとは `http://localhost:7070/app/` を開き、パスキーでログインします。`127.0.0.1` ではパスキーを使えないので、`localhost` で開いてください。
- 画面：承認待ち（期限の近いものから）・承認待ちの詳細（要約・部長のコメント・元のリクエスト全体）・稼働状況（手動のタスクもここから）・利用枠・記録（監査ログ）・端末。
- 送信系の承認は、元のリクエスト全体を開いて確かめるまで「承認する」を押せません（10.2「要約だけを見て承認しない」）。
- 承認も却下も、確かめの窓を挟んで、パスキーで署名します。署名の期限は2分です。制御サーバーに届いていないときは、最後に受け取った状態を見られますが、承認はできません。
- 端末の一覧と取り消しは、承認アプリの「端末」か、`aicoop devices`・`aicoop devices revoke <id>` で。

## 開発の始め方

必要なもの：Node.js 24 LTS、pnpm 11

```sh
pnpm install
pnpm test          # テストを1回実行
pnpm test:watch    # ファイルの変更を見てテストを実行し続ける（TDDのとき）
pnpm verify        # lint・型チェック・テストをすべて実行（コミット前に必ず）
```

開発はテスト駆動（TDD）で進めます。進め方と、P1 で次に作るものは [docs/development.md](docs/development.md) にあります。

## リポジトリの構成

設計書の第13章のとおりに育てていきます。いまあるのは ✅ のものだけです。

```text
aicoop/
├── packages/
│   ├── shared/        ✅ 型、設定のスキーマ（zod）、ルールの判定、正規化JSON
│   ├── daemon/           制御サーバー・資格プロキシ・道具ゲート・ローカルAPI
│   ├── box-gondolin/     BoxDriver: vm
│   ├── box-srt/          BoxDriver: srt
│   ├── cli/              aicoop コマンド
│   ├── approver/         承認アプリ（PWA）
│   └── relay/            中継（Cloudflare Worker）
├── services/          ✅ 組み込みのサービス定義（github・gmail・web）
├── templates/            aicoop init で配る雛形
├── images/               vm のベースイメージの定義
└── docs/              ✅ 設計書・開発の進め方
```

## ライセンス

[Apache-2.0](LICENSE)。依存するOSSの表示は [NOTICE](NOTICE) にあります。
