/**
 * 承認まわり（ペアリング・ログイン・承認の署名）が使う、daemon の中身。
 */
import type { Logger } from "pino";
import type { StateDb } from "../db/open.ts";
import { invalidInput } from "./errors.ts";

export interface ApprovalContext {
  readonly db: StateDb;
  readonly logger: Logger;
  readonly now: () => Date;
  /** daemon が待ち受けているポート（オリジン `http://localhost:<port>` に使う） */
  readonly port: () => number;
  /** aicoop.yaml の company（payload の company_id、パスキーの RP の名前） */
  readonly company: () => { readonly id: string; readonly name: string };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SAFE_KEY = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * 本文が JSON のオブジェクトで、キーが `allowed` だけであることを確かめる（知らないキーは誤り）。
 * 誤りの文には、形の安全なキーの名前だけを出す
 */
export function objectBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(body)) throw invalidInput("本文は JSON のオブジェクトにしてください");
  const extra = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extra.length > 0) {
    const named = extra.filter((k) => SAFE_KEY.test(k)).slice(0, 5);
    throw invalidInput(
      `知らないキーが ${extra.length}個 あります${named.length > 0 ? `（${named.join("、")}）` : ""}。書けるのは ${allowed.join("・")} です`,
    );
  }
  return body;
}
