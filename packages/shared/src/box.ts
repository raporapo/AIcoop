/**
 * 差し替えのための境界：箱（4.4）。
 *
 * 箱の実装は、このインターフェースを通してだけ使う。Gondolin や srt を直接呼ぶのは、
 * それぞれのドライバー（`packages/box-*`、`packages/daemon/src/box/host.ts`）の中だけにする。
 */

export type BoxKind = "vm" | "srt" | "none";

export interface BoxSpec {
  readonly groupId: string;
  /** この実行で動く社員（箱の中で同時に動くのは1人だけ。5.1.3） */
  readonly memberId: string;
  readonly runId: string;
  readonly kind: BoxKind;
  /** vm のみ */
  readonly memoryMiB?: number;
  /** vm のみ */
  readonly cpus?: number;
  /**
   * vm のみ：使うイメージ（`aicoop image build` で作ったもの）。
   * なければドライバーの既定のイメージを使う（5.1.8）。
   */
  readonly image?: string;
  /** 5.1.7 */
  readonly mounts: readonly Mount[];
  /** 箱の中の環境変数（設定のパスなど）。本物の資格は入れない。資格は `secrets` で渡す */
  readonly env: Readonly<Record<string, string>>;
  /**
   * 本物の資格（5.2.1）。ドライバーは仮の札を作り、箱の中には仮の札だけを環境変数 `env` で渡す。
   * 仮の札は、資格プロキシの判定が `forward` を返したリクエストのヘッダーで、`hosts` 宛てのときだけ本物に置き換わる。
   */
  readonly secrets: readonly BoxSecret[];
  /** 5.1.4 */
  readonly network: NetworkPolicy;
}

export interface Mount {
  readonly hostPath: string;
  readonly guestPath: string;
  readonly readOnly: boolean;
}

export interface BoxSecret {
  /** 箱の中での環境変数の名前（サービス定義の `secret.env`） */
  readonly env: string;
  /** 置き換えてよい宛先（サービス定義の `hosts`） */
  readonly hosts: readonly string[];
  /** 本物の値。ログ・エラーメッセージに出してはならない（5.2.8、11.5） */
  readonly value: string;
}

export interface NetworkPolicy {
  /** Anthropic 宛て（5.2.7）。中身を開かずに素通しする */
  readonly passthroughHosts: readonly string[];
  /** 道具ゲートのポート（5.3.1）。vm では `aicoop.internal:80` をここへ向ける */
  readonly gatewayPort: number;
  /** 資格プロキシ（vm のみ）。箱から外へ出る HTTP/HTTPS のリクエストごとに呼ばれる */
  readonly onRequest: (req: ProxiedRequest) => Promise<ProxyDecision>;
}

/** 箱から外へ出ようとしている HTTP/HTTPS のリクエスト */
export interface ProxiedRequest {
  readonly method: string;
  readonly protocol: "http" | "https";
  /** 小文字のホスト名（ポートは含めない） */
  readonly host: string;
  readonly port: number;
  /** パス。クエリ文字列を含む（照合には使わない） */
  readonly path: string;
  /**
   * ヘッダー（名前は小文字）。仮の札はまだ置き換わっていない。
   * ログに書くときは値を伏せ字にする（11.5）。
   */
  readonly headers: Readonly<Record<string, string>>;
  /** 本文のバイト数（分かるときだけ） */
  readonly bodyBytes: number | null;
  /** 本文を読む（保留で保存するときだけ使う。5.2.6） */
  readonly readBody: () => Promise<Uint8Array>;
}

export type ProxyDecision =
  /** そのまま外へ送る。仮の札はこのときだけ本物に置き換わる（5.2.1 の2） */
  | { readonly action: "forward" }
  /** 外へ送らず、この応答を箱へ返す（拒否・保留。5.2.5） */
  | {
      readonly action: "respond";
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    };

export interface ExecLine {
  readonly stream: "stdout" | "stderr";
  readonly line: string;
}

export type ExecHandle = AsyncIterable<ExecLine> & { readonly exitCode: Promise<number> };

export interface Box {
  exec(
    cmd: readonly string[],
    opts: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
  ): ExecHandle;
  /** 動いているコマンドを止める（時間切れ・取り消し。5.5.5） */
  kill(): Promise<void>;
  /** 箱を壊す（5.1.7）。何度呼んでもよい */
  destroy(): Promise<void>;
}

export interface BoxDriver {
  readonly kind: BoxKind;
  create(spec: BoxSpec): Promise<Box>;
}
