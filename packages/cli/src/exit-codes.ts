/**
 * aicoop コマンドの終了コード。スクリプトから使えるように、意味を固定する。
 *
 * | コード | 意味 |
 * |---|---|
 * | 0 | 成功（警告だけのときも 0） |
 * | 1 | 失敗：設定のエラー、検証の失敗（監査ログが壊れている）、操作の失敗、準備ができていない |
 * | 2 | 使い方の誤り：知らないコマンド・オプション、足りない引数、値の形の誤り |
 * | 3 | 制御サーバー（daemon）に接続できない（動いていない） |
 * | 130 | Ctrl+C で中断した |
 */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  daemonUnavailable: 3,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
