# AIcoop

自分のPCの中に「AIの会社」を作り、部署に分かれたAI社員に、営業・開発・マーケティング・デザインの仕事をさせるOSSです。

- AI社員には本物の資格（トークンやパスワード）を一切渡しません。箱（microVM）に閉じ込め、外への通信はすべて資格プロキシがルールで判定します。
- メール送信や main へのマージのような外に出る大事な操作は、オーナーがスマホでパスキー署名して承認してから実行されます。
- 公式の Claude Code を、そのままオーナー本人のサブスクの枠で動かします。

> **状態：開発の初期段階（P1 の途中）です。まだ動かして使うことはできません。**
> いま入っているのは、資格プロキシのルール判定などの「どのOSでもテストできる中心のロジック」だけです。

## 設計書

全体の設計は [docs/design.md](docs/design.md) にあります。本書に書いたことはすべて「決定」として扱い、変えるときは第18章「決定の記録」に追記してから本文を直します。

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
