/**
 * 1つの出力先（標準出力か標準エラー）に、色の決まりを添えたもの。
 */
import type { OutputStream } from "../context.ts";
import { createStyle, type Style } from "./style.ts";

export interface Printer {
  readonly style: Style;
  readonly isTTY: boolean;
  /** 端末の幅（パイプ・リダイレクトなら undefined。表を切らない） */
  readonly columns: number | undefined;
  line(text?: string): void;
  lines(texts: readonly string[]): void;
  write(text: string): void;
}

export function createPrinter(stream: OutputStream, color: boolean): Printer {
  return {
    style: createStyle(color),
    isTTY: stream.isTTY,
    columns: stream.isTTY ? stream.columns : undefined,
    line: (text = "") => stream.write(`${text}\n`),
    lines: (texts) => {
      if (texts.length > 0) stream.write(`${texts.join("\n")}\n`);
    },
    write: (text) => stream.write(text),
  };
}
