/**
 * 設定の誤りを、利用者が読める日本語で返す（11.7）。
 *
 * zod の既定のメッセージは英語なので、読むたびに日本語の対応表（`z.locales.ja()`）を渡す。
 * よく出る誤り（型・範囲・選択肢・知らないキー）は、「どう直せばよいか」まで書いた独自の文にする。
 * `z.config()` で全体を切り替えないのは、同じプロセスでほかに zod を使うものへ影響させないため。
 */
import { type core, z } from "zod";
import type { ConfigIssue } from "../config-issue.ts";

const ja = z.locales.ja().localeError;

const TYPE_NAMES: Readonly<Record<string, string>> = {
  string: "文字列",
  number: "数値",
  int: "整数",
  boolean: "真偽値（true か false）",
  array: "配列（[a, b] か、- で始まる行の並び）",
  object: "キーと値の組",
  null: "null",
};

/** 誤りのあった値を、短く見せる（長い値はそのまま出さない） */
export function showValue(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? `"${value}"` : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

const now = (input: unknown) => (input === undefined ? "" : `（いまの値：${showValue(input)}）`);

/** zod に渡す日本語のメッセージ（読むたびに `{ error: configErrorMap }` で渡す） */
export const configErrorMap: core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case "invalid_type": {
      if (issue.input === undefined) return "必須です。値を書いてください";
      const expected = TYPE_NAMES[issue.expected] ?? issue.expected;
      return `${expected}で書いてください${now(issue.input)}`;
    }
    case "too_small": {
      const min = String(issue.minimum);
      if (issue.origin === "number") {
        return `${min}${issue.inclusive ? "以上" : "より大きい値"}にしてください${now(issue.input)}`;
      }
      if (issue.origin === "array") {
        return min === "1" ? "1つ以上書いてください" : `${min}個以上書いてください`;
      }
      if (issue.origin === "string") {
        return min === "1"
          ? "空にはできません。値を書いてください"
          : `${min}文字以上にしてください`;
      }
      return ja(issue);
    }
    case "too_big": {
      const max = String(issue.maximum);
      if (issue.origin === "number") {
        return `${max}${issue.inclusive ? "以下" : "より小さい値"}にしてください${now(issue.input)}`;
      }
      if (issue.origin === "array") return `${max}個以下にしてください`;
      if (issue.origin === "string") return `${max}文字以下にしてください`;
      return ja(issue);
    }
    case "invalid_value":
      return `次のどれかにしてください：${issue.values.map((v) => String(v)).join("、")}${now(issue.input)}`;
    case "unrecognized_keys":
      return `知らないキーです：${issue.keys.join("、")}。打ち間違いでないか確かめてください（書いていないことは使えません）`;
    case "invalid_key": {
      const inner = issue.issues[0];
      return inner?.message ?? ja(issue);
    }
    case "invalid_union": {
      if ("discriminator" in issue && typeof issue.discriminator === "string") {
        const options = Array.isArray(issue.options) ? issue.options.map(String).join("、") : "";
        const input = isRecord(issue.input) ? issue.input[issue.discriminator] : undefined;
        return `${issue.discriminator} は次のどれかにしてください：${options}${now(input)}`;
      }
      return ja(issue);
    }
    default:
      return ja(issue);
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 設定ファイルの中の場所を、`groups.dev.ceiling.0.op` の形で書く */
export function formatPath(path: readonly PropertyKey[]): string {
  return path.map((p) => String(p)).join(".");
}

/** 「どのファイルの・どのキーが」を前に付けたメッセージにする */
export function describeAt(source: string | undefined, path: string, detail: string): string {
  const where = [source, path].filter((s) => s !== undefined && s !== "").join(" の ");
  return where === "" ? detail : `${where}：${detail}`;
}

export function makeIssue(
  code: ConfigIssue["code"],
  source: string | undefined,
  path: string,
  detail: string,
): ConfigIssue {
  return {
    code,
    message: describeAt(source, path, detail),
    ...(source !== undefined && { source }),
    ...(path !== "" && { path }),
  };
}

/**
 * zod の誤りを ConfigIssue（E-013：値が型・範囲に合わない）にする。
 * 知らないキーには、そこに書けるキーと、近いものがあれば「もしかして」を添える。
 */
export function zodIssuesToConfigIssues(
  error: z.ZodError,
  source: string | undefined,
  schema?: z.ZodType,
  input?: unknown,
): ConfigIssue[] {
  return error.issues.map((issue) => {
    const path = formatPath(issue.path);
    let detail = issue.message;
    if (issue.code === "unrecognized_keys" && schema !== undefined) {
      const allowed = allowedKeysAt(schema, input, issue.path);
      if (allowed !== undefined && allowed.length > 0) {
        const hints = issue.keys
          .map((k) => [k, closest(k, allowed)] as const)
          .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
          .map(([k, c]) => `${k} → ${c}`);
        detail +=
          (hints.length > 0 ? `。もしかして：${hints.join("、")}` : "") +
          `。ここに書けるキー：${allowed.join("、")}`;
      }
    }
    return makeIssue("E-013", source, path, detail);
  });
}

// ---- 知らないキーのときに、書けるキーを調べる（できる範囲で。分からなければ undefined） ----

interface DefLike {
  readonly type: string;
  readonly shape?: Record<string, z.ZodType>;
  readonly valueType?: z.ZodType;
  readonly element?: z.ZodType;
  readonly innerType?: z.ZodType;
  readonly out?: z.ZodType;
  readonly in?: z.ZodType;
  readonly options?: readonly z.ZodType[];
  readonly discriminator?: string;
  readonly transform?: (value: unknown, ctx: unknown) => unknown;
}

function defOf(schema: z.ZodType): DefLike {
  return (schema as unknown as { _zod: { def: DefLike } })._zod.def;
}

function allowedKeysAt(
  schema: z.ZodType,
  input: unknown,
  path: readonly PropertyKey[],
): string[] | undefined {
  try {
    let current: z.ZodType | undefined = schema;
    let value: unknown = input;
    let i = 0;
    for (let guard = 0; current !== undefined && guard < 100; guard++) {
      const def = defOf(current);
      if (["default", "prefault", "optional", "nullable", "readonly", "catch"].includes(def.type)) {
        current = def.innerType;
        continue;
      }
      if (def.type === "pipe") {
        // preprocess は in が変換、out が本体。変換したあとの値で続きを調べる
        const inDef = def.in === undefined ? undefined : defOf(def.in);
        if (inDef?.type === "transform" && typeof inDef.transform === "function") {
          value = inDef.transform(value, { issues: [], value });
          current = def.out;
        } else {
          current = def.in;
        }
        continue;
      }
      if (def.type === "union" && def.discriminator !== undefined && def.options) {
        const key = isRecord(value) ? value[def.discriminator] : undefined;
        current = def.options.find((o) => {
          const d = defOf(o).shape?.[def.discriminator as string];
          const values = (d as unknown as { _zod?: { values?: Set<unknown> } })?._zod?.values;
          return values?.has(key) === true;
        });
        continue;
      }
      if (i === path.length) {
        return def.type === "object" && def.shape ? Object.keys(def.shape) : undefined;
      }
      const step = path[i++];
      value = isRecord(value) || Array.isArray(value) ? (value as never)[step as never] : undefined;
      if (def.type === "object") current = def.shape?.[String(step)];
      else if (def.type === "record") current = def.valueType;
      else if (def.type === "array") current = def.element;
      else return undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 打ち間違いらしい近いキー（編集距離が2以下で一番近いもの） */
function closest(key: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const c of candidates) {
    const d = editDistance(key.toLowerCase(), c.toLowerCase());
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j] as number;
      row[j] = Math.min(
        (row[j] as number) + 1,
        (row[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = temp;
    }
  }
  return row[b.length] as number;
}
