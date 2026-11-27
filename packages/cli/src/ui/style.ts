/**
 * 色。端末に出すときだけ付ける（パイプ・リダイレクト、`NO_COLOR`、`--no-color`、`TERM=dumb` では付けない）。
 */

export interface Style {
  readonly enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  magenta(text: string): string;
}

function wrap(enabled: boolean, open: number, close: number) {
  return (text: string) =>
    enabled && text !== "" ? `\u001b[${open}m${text}\u001b[${close}m` : text;
}

export function createStyle(enabled: boolean): Style {
  return {
    enabled,
    bold: wrap(enabled, 1, 22),
    dim: wrap(enabled, 2, 22),
    red: wrap(enabled, 31, 39),
    green: wrap(enabled, 32, 39),
    yellow: wrap(enabled, 33, 39),
    cyan: wrap(enabled, 36, 39),
    magenta: wrap(enabled, 35, 39),
  };
}

/** 色を付けるか。`NO_COLOR` は値が空でなければ有効（https://no-color.org/） */
export function shouldColor(options: {
  readonly isTTY: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly noColorFlag: boolean;
}): boolean {
  if (options.noColorFlag) return false;
  if ((options.env.NO_COLOR ?? "") !== "") return false;
  if (options.env.TERM === "dumb") return false;
  return options.isTTY;
}
