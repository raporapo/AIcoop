/**
 * 保存した本文の先頭を、見せられる形にする（要約・承認アプリ・タスク本文）。
 */

const fatal = new TextDecoder("utf-8", { fatal: true });

export interface BodyHead {
  /** UTF-8 として読めれば、その文字列 */
  readonly text: string | null;
  /** 読めなければ base64 */
  readonly base64: string | null;
  /** 先頭だけを切り出した */
  readonly truncated: boolean;
}

/**
 * 先頭 `maxBytes` バイトを、UTF-8 として読めれば文字列で、読めなければ base64 で返す。
 * 切ったところで文字が途中になったときは、その文字の手前まで（最大3バイト戻る）を読む。
 */
export function bodyHead(bytes: Uint8Array, maxBytes: number): BodyHead {
  const truncated = bytes.byteLength > maxBytes;
  const head = bytes.subarray(0, Math.min(bytes.byteLength, maxBytes));
  const text = decodeUtf8(head, truncated);
  if (text !== null) return { text, base64: null, truncated };
  return { text: null, base64: Buffer.from(head).toString("base64"), truncated };
}

/** UTF-8 として読む。`cut` なら、末尾の途中の文字（最大3バイト）を落として読む。読めなければ null */
export function decodeUtf8(bytes: Uint8Array, cut = false): string | null {
  const tries = cut ? 4 : 1;
  for (let drop = 0; drop < tries && drop <= bytes.byteLength; drop++) {
    try {
      return fatal.decode(bytes.subarray(0, bytes.byteLength - drop));
    } catch {
      // 次へ
    }
  }
  return null;
}

/** 先頭 `max` 文字（コードポイントで数える）。超えたら truncated */
export function headChars(text: string, max: number): { text: string; truncated: boolean } {
  const chars = [...text];
  if (chars.length <= max) return { text, truncated: false };
  return { text: chars.slice(0, max).join(""), truncated: true };
}
