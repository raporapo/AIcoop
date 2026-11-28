/**
 * コマンドの一覧（9.1 の P1 の行すべて）と、その使い方。
 *
 * 実行する関数は、使うときにだけ読み込む（`--help` や打ち間違いの案内を速く出すため。
 * `@aicoop/daemon` や Gondolin の読み込みには時間がかかる）。
 */
import type { OptionSpec } from "./args.ts";
import type { CommandDef, CommandSection } from "./command.ts";

export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  {
    name: "home",
    type: "string",
    value: "<dir>",
    description: "設定の置き場所（既定：環境変数 AICOOP_HOME、なければ ~/.aicoop）",
  },
  { name: "no-color", type: "boolean", description: "色を付けない（環境変数 NO_COLOR でも同じ）" },
  { name: "help", short: "h", type: "boolean", description: "使い方を表示する" },
];

const json = (what: string): OptionSpec => ({
  name: "json",
  type: "boolean",
  description: `${what}を JSON で出す（スクリプト向け。色も案内も付けない）`,
});

export const SECTION_TITLES: Readonly<Record<CommandSection, string>> = {
  setup: "はじめる",
  daemon: "制御サーバー",
  secret: "資格",
  work: "仕事",
  approval: "保留・一時権限（見るだけ。承認・却下は承認アプリで）",
  device: "承認アプリの端末",
  record: "記録",
};

export const COMMANDS: readonly CommandDef[] = [
  {
    name: "init",
    section: "setup",
    summary: "~/.aicoop に会社の雛形を作る",
    usage: ["init [--name <会社名>]", "init --only-missing"],
    description: [
      "設定ファイル（aicoop.yaml・groups.yaml・roles.yaml・members.yaml・triggers.yaml・prompts/）と",
      ".gitignore、data/・logs/・runtime/・state/holds/ を作り、会社の ID を発行します。",
      "すでに設定があるときは、何も上書きせずに止まります。",
    ],
    options: [
      {
        name: "name",
        type: "string",
        value: "<会社名>",
        description:
          "承認アプリに出す会社の名前（既定：わたしの会社。あとで aicoop.yaml で変えられます）",
      },
      {
        name: "only-missing",
        type: "boolean",
        description: "すでにあるファイルはそのままにして、足りない雛形のファイルだけを作る",
      },
      { name: "force", type: "boolean", description: "（ありません）", hidden: true },
    ],
    positionals: [],
    examples: [
      { command: 'init --name "サンプル商会"', note: "会社を作る" },
      { command: "init --only-missing", note: "消してしまった雛形のファイルだけを作り直す" },
      { command: "--home ./my-company init", note: "~/.aicoop 以外の場所に作る" },
    ],
    related: ["check", "secret set", "image build", "start"],
    load: () => import("./commands/init.ts"),
  },
  {
    name: "check",
    section: "setup",
    summary: "設定を確かめる（エラー・警告と、動かす準備）",
    usage: ["check [--json]"],
    description: [
      "設定ファイルを読み、エラー（daemon が起動しない）と警告を、ファイル・場所・直し方つきで表示します。",
      "続けて、資格の登録・vm のイメージ・この OS で箱が動くか・daemon が動いているかを確かめます",
      "（この「準備の確認」はエラーにはしません）。",
      "終了コード：エラーがあれば 1、警告だけなら 0。",
    ],
    options: [json("結果")],
    positionals: [],
    examples: [
      { command: "check", note: "設定を変えたら、まずこれ" },
      { command: "check --json | jq '.errors'", note: "エラーだけを取り出す" },
    ],
    related: ["reload", "init", "secret set", "image build"],
    load: () => import("./commands/check.ts"),
  },
  {
    name: "image build",
    section: "setup",
    summary: "vm の箱のイメージを作る",
    usage: ["image build [--group <id>] [--claude-version <版>]"],
    description: [
      "ベースイメージ（Alpine + git・ripgrep・Claude Code）を ~/.aicoop/images/base に作ります。",
      "groups.yaml で packages を書いた vm の部署は、その部署のイメージも作ります。",
      "Linux（KVM）か macOS で動かしてください。Windows では WSL2 の中で動かします。",
    ],
    options: [
      {
        name: "group",
        type: "string",
        value: "<id>",
        description: "この部署のイメージだけを作る（groups.yaml の packages を足したもの）",
      },
      {
        name: "claude-version",
        type: "string",
        value: "<版>",
        description: "入れる Claude Code の版（例：2.1.3。既定：最新）",
      },
    ],
    positionals: [],
    examples: [
      { command: "image build", note: "ベースと、packages のある部署のイメージを作る" },
      { command: "image build --group dev", note: "groups.yaml の dev の packages を変えたあと" },
    ],
    related: ["check", "start"],
    load: () => import("./commands/image.ts"),
  },
  {
    name: "daemon",
    section: "daemon",
    summary: "制御サーバーを前面で動かす（Ctrl+C で止める）",
    usage: ["daemon"],
    description: [
      "制御サーバーをこの端末で動かし、ログを標準出力に出します。Ctrl+C で止めます",
      "（動いている実行を止めてから終わります）。ふだんは aicoop start で裏で動かします。",
    ],
    options: [
      {
        name: "background",
        type: "boolean",
        description: "ログを標準出力ではなく ~/.aicoop/logs/ に書く（aicoop start が使う）",
      },
    ],
    positionals: [],
    examples: [{ command: "daemon", note: "ログを見ながら動かす" }],
    related: ["start", "stop", "status"],
    load: () => import("./commands/daemon.ts"),
  },
  {
    name: "start",
    section: "daemon",
    summary: "制御サーバーを裏で起動する",
    usage: ["start"],
    description: [
      "aicoop daemon を裏で起動し、応答するまで待ちます。ログは ~/.aicoop/logs/ に書かれます。",
      "すでに動いていれば、何もしません。",
    ],
    options: [],
    positionals: [],
    examples: [{ command: "start", note: "起動する" }],
    related: ["stop", "status", "daemon"],
    load: () => import("./commands/start.ts"),
  },
  {
    name: "stop",
    section: "daemon",
    summary: "制御サーバーを止める",
    usage: ["stop"],
    description: ["動いている実行を止めてから、制御サーバーを止めます。止まるまで待ちます。"],
    options: [],
    positionals: [],
    examples: [{ command: "stop", note: "止める" }],
    related: ["start", "status"],
    load: () => import("./commands/stop.ts"),
  },
  {
    name: "reload",
    section: "daemon",
    summary: "設定を読み直す",
    usage: ["reload [--json]"],
    description: [
      "設定ファイルを読み直します。エラーがあれば、前の設定のまま変えません。",
      "動いている実行は、始まったときの設定のまま最後まで動きます。",
    ],
    options: [json("結果")],
    positionals: [],
    examples: [{ command: "check && aicoop reload", note: "確かめてから読み直す" }],
    related: ["check", "status"],
    load: () => import("./commands/reload.ts"),
  },
  {
    name: "status",
    section: "daemon",
    summary: "全体の状態（箱・タスク・利用枠・承認待ち・トリガー・警告）",
    usage: ["status [--json]"],
    description: [
      "利用枠で止まっているときは、再開予定時刻を出します（その時刻 + 60秒まで、どのタスクも始めません）。",
      "オーナーの承認待ちがあれば、件数と、承認アプリ（http://localhost:<daemon.port>/app/）を案内します。",
    ],
    options: [json("状態")],
    positionals: [],
    examples: [{ command: "status", note: "いまの状態を見る" }],
    related: ["tasks", "holds", "grants", "start"],
    load: () => import("./commands/status.ts"),
  },
  {
    name: "secret set",
    section: "secret",
    summary: "資格を登録する（標準入力から読む）",
    usage: ["secret set <id> --kind <kind>", "secret set <id> --kind <kind> < 資格.json"],
    description: [
      "標準入力から資格を読み、~/.aicoop/secrets.json に保存します。中身は画面にもログにも出しません。",
      "端末から実行すると、貼り付けを待ちます（打った文字は画面に出ません）。",
      "static_token・anthropic_oauth は、トークンだけを貼っても受け付けます。",
      "",
      "<kind> と中身",
      '  static_token      {"token": "..."}',
      '  anthropic_oauth   {"token": "..."}（claude setup-token で作ったもの）',
      '  github_app        {"app_id": 123, "installation_id": 456, "private_key": "-----BEGIN ..."}',
      '  google_oauth      {"client_id": "...", "client_secret": "...", "refresh_token": "..."}',
    ],
    options: [
      {
        name: "kind",
        type: "string",
        value: "<kind>",
        description: "static_token・github_app・google_oauth・anthropic_oauth のどれか",
        required: true,
      },
    ],
    positionals: [
      {
        name: "id",
        required: true,
        description: "資格の ID（サービスの ID と同じにする。例：anthropic、github）",
      },
    ],
    examples: [
      {
        command: "secret set anthropic --kind anthropic_oauth",
        note: "claude setup-token のトークンを貼り付ける",
      },
      {
        command: "secret set github --kind github_app < github-app.json",
        note: "ファイルから登録する",
      },
    ],
    related: ["secret list", "secret rm", "check"],
    load: () => import("./commands/secret.ts").then((m) => ({ run: m.runSet })),
  },
  {
    name: "secret list",
    section: "secret",
    summary: "資格の ID・種類・更新日時を表示する（中身は出さない）",
    usage: ["secret list [--json]"],
    options: [json("一覧")],
    positionals: [],
    examples: [{ command: "secret list", note: "登録した資格を見る" }],
    related: ["secret set", "secret rm"],
    load: () => import("./commands/secret.ts").then((m) => ({ run: m.runList })),
  },
  {
    name: "secret rm",
    section: "secret",
    summary: "資格を消す",
    usage: ["secret rm <id> [--yes]"],
    description: [
      "端末から実行すると、消してよいか確かめます。スクリプトからは --yes を付けます。",
    ],
    options: [{ name: "yes", short: "y", type: "boolean", description: "確かめずに消す" }],
    positionals: [{ name: "id", required: true, description: "消す資格の ID" }],
    examples: [{ command: "secret rm github", note: "github の資格を消す" }],
    related: ["secret list", "secret set"],
    load: () => import("./commands/secret.ts").then((m) => ({ run: m.runRm })),
  },
  {
    name: "run",
    section: "work",
    summary: "手動で仕事を頼む（タスクを作る）",
    usage: [
      "run <member> --purpose <文> --done-when <文> [--context <文>] [--thread <名>] [--timeout <分>] [--wait]",
    ],
    description: [
      "社員にタスクを作り、順番待ちに入れます。作ったら、すぐにタスクの ID を表示して終わります",
      "（--wait なら、終わるまで待って結果を表示します）。",
    ],
    options: [
      { name: "purpose", type: "string", value: "<文>", description: "目的", required: true },
      {
        name: "done-when",
        type: "string",
        value: "<文>",
        description: "完了の条件（確かめられる形で具体的に）",
        required: true,
      },
      {
        name: "context",
        type: "string",
        value: "<文>",
        description: "背景・知っておいてほしいこと",
      },
      {
        name: "thread",
        type: "string",
        value: "<名>",
        description: "スレッドの名前。同じ名前なら前の会話の続きから（既定：毎回新しい会話）",
      },
      {
        name: "timeout",
        type: "string",
        value: "<分>",
        description: "時間制限（1〜55分。既定：aicoop.yaml の task.timeout_minutes）",
      },
      { name: "wait", type: "boolean", description: "終わるまで待って、結果を表示する" },
      json("作ったタスク"),
    ],
    positionals: [
      { name: "member", required: true, description: "仕事をする社員の ID（members.yaml）" },
    ],
    examples: [
      {
        command:
          'run dev-implementer --purpose "README の誤字を直す" --done-when "PR を出して URL を報告した"',
        note: "開発部の実装AIに頼む",
      },
      {
        command:
          'run sales-researcher --purpose "競合を調べる" --done-when "/work/research/ に md がある" --wait',
        note: "終わるまで待つ",
      },
    ],
    related: ["tasks", "logs", "cancel"],
    load: () => import("./commands/run.ts"),
  },
  {
    name: "tasks",
    section: "work",
    summary: "タスクの一覧（新しい順）",
    usage: ["tasks [--status <状態>[,<状態>...]] [--limit <件数>] [--json]"],
    description: [
      "状態：queued（順番待ち）・starting（起動中）・running（実行中）・done（完了）・",
      "done_without_report（報告なしで終了）・failed（失敗）・timeout（時間切れ）・",
      "waiting_limit（利用枠待ち）・blocked_host_tool（道具待ち）・cancelled（取り消し）",
    ],
    options: [
      {
        name: "status",
        type: "string",
        value: "<状態>",
        description: "この状態のタスクだけ（, で区切って複数）",
      },
      {
        name: "limit",
        type: "string",
        value: "<件数>",
        description: "表示する数（1〜500。既定：100）",
      },
      json("一覧"),
    ],
    positionals: [],
    examples: [
      { command: "tasks", note: "最近のタスク" },
      { command: "tasks --status running,queued", note: "動いているもの・待っているもの" },
    ],
    related: ["run", "logs", "status"],
    load: () => import("./commands/tasks.ts"),
  },
  {
    name: "logs",
    section: "work",
    summary: "タスクの実行の記録を表示する",
    usage: ["logs <task_id> [--follow] [--raw]"],
    description: [
      "Claude の発言・道具の呼び出しと結果・エラーを、時刻つきで読みやすく表示します。",
      "--raw なら、Claude Code の stream-json をそのまま出します（jq などに渡すとき）。",
    ],
    options: [
      {
        name: "follow",
        short: "f",
        type: "boolean",
        description: "終わるまで、増えた分を表示し続ける（Ctrl+C で止める）",
      },
      { name: "raw", type: "boolean", description: "stream-json をそのまま出す" },
    ],
    positionals: [{ name: "task_id", required: true, description: "タスクの ID（t_ で始まる）" }],
    examples: [
      { command: "logs t_01JD6V8X3S0Q5W7KQ9M2T4R6YB --follow", note: "動いているタスクを見守る" },
      {
        command: "logs t_01JD6V8X3S0Q5W7KQ9M2T4R6YB --raw | jq -c 'select(.type==\"result\")'",
        note: "結果の行だけ",
      },
    ],
    related: ["tasks", "run", "cancel"],
    load: () => import("./commands/logs.ts"),
  },
  {
    name: "cancel",
    section: "work",
    summary: "タスクを取り消す（動いていれば止める）",
    usage: ["cancel <task_id>"],
    options: [json("取り消したタスク")],
    positionals: [{ name: "task_id", required: true, description: "タスクの ID（t_ で始まる）" }],
    examples: [{ command: "cancel t_01JD6V8X3S0Q5W7KQ9M2T4R6YB", note: "取り消す" }],
    related: ["tasks", "logs"],
    load: () => import("./commands/cancel.ts"),
  },
  {
    name: "holds",
    section: "approval",
    summary: "保留（承認待ちの重い操作）の一覧・詳細",
    usage: [
      "holds [--status <状態>[,<状態>...]] [--limit <件数>] [--json]",
      "holds <hold_id> [--full] [--json]",
    ],
    description: [
      "AI社員の重い操作（メールの送信・PR のマージなど）は、送らずに保留になり、部長のレビューと",
      "オーナーの承認のあとで1回だけ送られます（5.7.1）。ここでは見るだけです。",
      "承認・却下は、承認アプリ（http://localhost:<daemon.port>/app/）でパスキーの署名で行います（P-4）。",
      "",
      "<hold_id> を書くと、要約・部長のコメント・状態・期限・元のリクエスト・再送の結果を出します。",
      "元のリクエストの本文は、先頭だけを出します（--full で全部）。",
      "",
      "状態：pending_manager（部長のレビュー待ち）・pending_owner（オーナーの承認待ち）・",
      "approved（承認済み・送信中）・replayed（送信済み）・replay_failed（送信に失敗）・",
      "rejected（却下）・expired（期限切れ）",
    ],
    options: [
      {
        name: "status",
        type: "string",
        value: "<状態>",
        description: "この状態の保留だけ（, で区切って複数）",
      },
      {
        name: "limit",
        type: "string",
        value: "<件数>",
        description: "表示する数（1〜500。既定：100）",
      },
      {
        name: "full",
        type: "boolean",
        description: "詳細で、元のリクエストの本文・要約の本文・再送の結果を全部出す",
      },
      json("一覧・詳細"),
    ],
    positionals: [
      { name: "hold_id", required: false, description: "保留の ID（h_ で始まる）。書けば詳細" },
    ],
    examples: [
      { command: "holds --status pending_owner", note: "オーナーの承認を待っているもの" },
      { command: "holds h_01JD6V8X3S0Q5W7KQ9M2T4R6YB", note: "1件の中身を確かめる" },
      { command: "holds h_01JD6V8X3S0Q5W7KQ9M2T4R6YB --full", note: "送る本文を全部見る" },
    ],
    related: ["grants", "status", "pair"],
    load: () => import("./commands/holds.ts"),
  },
  {
    name: "grants",
    section: "approval",
    summary: "一時権限（AI社員の申請を含む）の一覧",
    usage: ["grants [--status <状態>[,<状態>...]] [--limit <件数>] [--json]"],
    description: [
      "AI社員が request_access で申請した一時権限と、その状態です（5.7.3）。ここでは見るだけです。",
      "承認・却下は、承認アプリ（http://localhost:<daemon.port>/app/）でパスキーの署名で行います（P-4）。",
      "",
      "状態：pending_manager（部長のレビュー待ち）・pending_owner（オーナーの承認待ち）・",
      "active（有効）・rejected（却下）・expired（期限切れ）",
    ],
    options: [
      {
        name: "status",
        type: "string",
        value: "<状態>",
        description: "この状態の一時権限だけ（, で区切って複数）",
      },
      {
        name: "limit",
        type: "string",
        value: "<件数>",
        description: "表示する数（1〜500。既定：100）",
      },
      json("一覧"),
    ],
    positionals: [],
    examples: [
      { command: "grants --status pending_owner", note: "オーナーの承認を待っている申請" },
      { command: "grants --status active", note: "いま効いている一時権限" },
    ],
    related: ["holds", "status", "pair"],
    load: () => import("./commands/grants.ts"),
  },
  {
    name: "pair",
    section: "device",
    summary: "承認アプリの端末を登録する（P2 は --local：この PC のブラウザ）",
    usage: ["pair --local"],
    description: [
      "1回限りのコード（10分で失効）と承認アプリの URL を出します。PC のブラウザで開いてコードを入れ、",
      "パスキーを作ると、ここに確認コードと端末の名前が出ます。ブラウザに出た確認コードと同じなら y を押すと、",
      "端末が有効になります（それまでは、その端末でログインも承認もできません）。Ctrl+C で取りやめます。",
      "確認コードを見比べるので、端末から実行してください。",
      "スマホの登録（QRコード・中継）は P3 でできるようになります。",
    ],
    options: [
      {
        name: "local",
        type: "boolean",
        description: "この PC のブラウザ（http://localhost）を登録する",
      },
    ],
    positionals: [],
    examples: [{ command: "pair --local", note: "この PC のブラウザを承認アプリの端末にする" }],
    related: ["devices", "devices revoke"],
    load: () => import("./commands/pair.ts"),
  },
  {
    name: "devices",
    section: "device",
    summary: "承認アプリの端末の一覧",
    usage: ["devices [--json]", "devices revoke <id> [--yes]"],
    description: ["取り消した端末も、取り消した時刻とともに出します。"],
    options: [json("一覧")],
    positionals: [],
    examples: [{ command: "devices", note: "登録した端末を見る" }],
    related: ["devices revoke", "pair"],
    load: () => import("./commands/devices.ts").then((m) => ({ run: m.runList })),
  },
  {
    name: "devices revoke",
    section: "device",
    summary: "承認アプリの端末を取り消す（なくしたとき）",
    usage: ["devices revoke <id> [--yes]"],
    description: [
      "取り消した端末では、ログインも承認もできなくなります。ログイン中のセッションも、すぐ無効になります。",
      "端末から実行すると、取り消してよいか確かめます。スクリプトからは --yes を付けます。",
    ],
    options: [
      { name: "yes", short: "y", type: "boolean", description: "確かめずに取り消す" },
      json("取り消した端末"),
    ],
    positionals: [{ name: "id", required: true, description: "端末の ID（d_ で始まる）" }],
    examples: [
      { command: "devices revoke d_01JD6V8X3S0Q5W7KQ9M2T4R6YB", note: "なくした端末を取り消す" },
    ],
    related: ["devices", "pair"],
    load: () => import("./commands/devices.ts").then((m) => ({ run: m.runRevoke })),
  },
  {
    name: "audit verify",
    section: "record",
    summary: "監査ログのつながりを確かめる",
    usage: ["audit verify [--json]"],
    description: [
      "state.db の監査ログを最初から最後まで読み、ハッシュのつながりが壊れていないかを確かめます。",
      "daemon が動いていなくても使えます。終了コード：通れば 0、壊れていれば 1。",
    ],
    options: [json("結果")],
    positionals: [],
    examples: [{ command: "audit verify", note: "記録が書き換えられていないかを確かめる" }],
    related: ["status"],
    load: () => import("./commands/audit.ts"),
  },
];

/** 名前の前半だけで、まとまりになっているもの（`aicoop secret` → set・list・rm） */
export const GROUPS: Readonly<Record<string, string>> = {
  secret: "資格を登録する・一覧を見る・消す",
  image: "vm の箱のイメージを作る",
  audit: "監査ログを確かめる",
};

/** よく打たれる別の言い方と、正しいコマンド（実行はせず、案内だけする） */
export const SYNONYMS: Readonly<Record<string, string>> = {
  ps: "tasks",
  list: "tasks",
  ls: "tasks",
  task: "tasks",
  log: "logs",
  kill: "cancel",
  abort: "cancel",
  verify: "audit verify",
  build: "image build",
  secrets: "secret list",
  setup: "init",
  validate: "check",
  lint: "check",
  info: "status",
  hold: "holds",
  grant: "grants",
  pending: "holds --status pending_owner",
  restart: "stop と aicoop start",
  serve: "daemon",
  "secret ls": "secret list",
  "secret show": "secret list",
  "secret add": "secret set",
  "secret put": "secret set",
  "secret delete": "secret rm",
  "secret remove": "secret rm",
  "secret del": "secret rm",
  "secret unset": "secret rm",
  "image create": "image build",
  "image make": "image build",
  "audit check": "audit verify",
  "audit validate": "audit verify",
  device: "devices",
  pairing: "pair --local",
  unpair: "devices revoke",
  "devices list": "devices",
  "devices ls": "devices",
  "devices show": "devices",
  "devices rm": "devices revoke",
  "devices remove": "devices revoke",
  "devices delete": "devices revoke",
  "devices del": "devices revoke",
  "devices disable": "devices revoke",
};

/**
 * ないコマンドと、その理由（実行はせず、案内だけする）。
 * 承認をするコマンドは作らない（9.1・P-4：承認は承認アプリのパスキーの署名だけで行う）
 */
const NO_APPROVAL_COMMAND: readonly string[] = [
  "承認をするコマンドはありません。承認・却下は、承認アプリでパスキーの署名で行います（設計書 9.1・P-4）",
  "承認アプリは、daemon が動いている PC のブラウザで http://localhost:<daemon.port>/app/ を開きます（端末の登録：aicoop pair --local）",
];

/** 保留・一時権限のあとに続けて書かれそうな、承認・却下の言い方（`aicoop holds approve <id>` など） */
const APPROVAL_WORDS = ["approve", "reject", "accept", "deny", "sign", "pass", "decide"] as const;

export const NOT_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  approve: NO_APPROVAL_COMMAND,
  reject: NO_APPROVAL_COMMAND,
  accept: NO_APPROVAL_COMMAND,
  deny: NO_APPROVAL_COMMAND,
  sign: NO_APPROVAL_COMMAND,
  approvals: NO_APPROVAL_COMMAND,
  ...Object.fromEntries(
    ["holds", "grants", "hold", "grant"].flatMap((noun) =>
      APPROVAL_WORDS.map((w) => [`${noun} ${w}`, NO_APPROVAL_COMMAND]),
    ),
  ),
};

export function findCommand(name: string): CommandDef | undefined {
  return COMMANDS.find((c) => c.name === name);
}
