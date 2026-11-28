# AIcoop

自分のPCの中に「AIの会社」を作り、部署に分かれたAI社員に、営業・開発・マーケティング・デザインの仕事をさせるOSSです。

- AI社員には本物の資格（トークンやパスワード）を一切渡しません。箱（microVM）に閉じ込め、外への通信はすべて資格プロキシがルールで判定します。
- メール送信や main へのマージのような外に出る大事な操作は、オーナーがスマホでパスキー署名して承認してから実行されます。
- 公式の Claude Code を、そのままオーナー本人のサブスクの枠で動かします。

> **状態：P1（1つの箱で、資格を渡さずに動く）と P2（承認と継続。承認アプリは PC のブラウザだけ）ができたところです。**
> AI社員は vm の箱（microVM）の中で公式の Claude Code として動き、外への通信は資格プロキシのルールで判定されます。
> 重い操作は保留され、部長AIのレビューのあと、オーナーが承認アプリでパスキーで署名して承認したときだけ1回送られます。
> スマホからの承認・中継・GitHub のトリガー（P3）、部署間の依頼・CEO・ComfyUI（P4）は、これから作ります（設計書 14章）。

## 設計書

全体の設計は [docs/design.md](docs/design.md) にあります。本書に書いたことはすべて「決定」として扱い、変えるときは第18章「決定の記録」に追記してから本文を直します。

## 使い方（P1）

必要なもの：Node.js 24 LTS、pnpm 11。vm の箱を動かすには、Linux（KVM が使えること）か macOS と、QEMU。
Linux では、イメージを作る道具（`mke2fs`・`cpio`・`lz4`）も要ります（Debian・Ubuntu なら `sudo apt install qemu-system-x86 e2fsprogs cpio lz4`）。足りないものは `aicoop check` が教えます。

Windows では、WSL2 の中で動かします（設計書 4.3。Windows 11 の WSL2 で箱が動くことを確かめました。16章 V-3）。

1. 管理者のターミナルで `wsl --install` を実行し、再起動して、Ubuntu のユーザー名とパスワードを決める
2. Ubuntu の中で、上の apt のパッケージと Node.js 24・pnpm 11 を入れ、`sudo usermod -aG kvm $USER` のあと、Windows 側で `wsl --shutdown` して開き直す
3. リポジトリは Ubuntu の中（`~/AIcoop` など）に clone する。`/mnt/c/...`（Windows の C ドライブ）は読み書きが遅い。設定の置き場所（`AICOOP_HOME`）も `/mnt/c` に置かない（既定では `chmod 600` が効かず、`secrets.json` の確かめ（E-008）で止まる）

```sh
git clone https://github.com/raporapo/AIcoop.git && cd AIcoop
pnpm install
alias aicoop="node $PWD/packages/cli/bin/aicoop.ts"   # または、リポジトリの中で pnpm aicoop <コマンド>

aicoop init --name "サンプル商会"   # ~/.aicoop に雛形を作る。次にすることが番号つきで出ます
# ~/.aicoop/groups.yaml の your-org を、自分の GitHub のユーザー名か組織名に書き換える
claude setup-token                  # Claude のトークンを作る
aicoop secret set anthropic --kind anthropic_oauth            # 貼り付ける（画面には出ません）
aicoop secret set github --kind github_app < github-app.json  # GitHub App の資格
#   （かんたんに試すなら、fine-grained の個人アクセストークンを --kind static_token で登録してもよい）
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
- 保留と一時権限は、ターミナルでも `aicoop holds`（`aicoop holds <hold_id>` で詳細）・`aicoop grants` で見られます。承認・却下のコマンドはありません（承認はパスキーの署名だけ。設計書 P-4）。

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

設計書の第13章のとおりに育てていきます。いまあるのは ✅ のものです。

```text
aicoop/
├── packages/
│   ├── shared/        ✅ 型、設定のスキーマ（zod）と検証、ルールの判定、正規化JSON、ローカルAPI の型
│   ├── daemon/        ✅ 制御サーバー・資格プロキシ・道具ゲート・ローカルAPI・承認の署名の確かめ
│   ├── box-gondolin/  ✅ BoxDriver: vm（ベースイメージも、ここの image.ts で作る）
│   ├── box-srt/          BoxDriver: srt（P4）
│   ├── cli/           ✅ aicoop コマンド
│   ├── approver/      ✅ 承認アプリ（PWA）
│   └── relay/            中継（Cloudflare Worker。P3）
├── services/          ✅ 組み込みのサービス定義（github・gmail・web）
├── templates/         ✅ aicoop init で配る雛形
└── docs/              ✅ 設計書・開発の進め方（設計書にない決定の一覧も）
```

- テストは `pnpm verify` で回ります。CI では、ubuntu の KVM で本物の vm の箱を起こして、P1 の完了条件を端から端まで確かめています（`vm e2e (P1, Gondolin, KVM)`）。

## ライセンス

[Apache-2.0](LICENSE)。依存するOSSの表示は [NOTICE](NOTICE) にあります。
