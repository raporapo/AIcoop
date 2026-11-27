/**
 * 承認アプリのログインのセッション（9.2）。
 *
 * - 値はランダム（32バイト、base64url）。サーバーは SHA-256 のハッシュだけを持つ（メモリの中）
 * - 期限は作ってから8時間（延ばさない）。daemon を起動し直すと、すべてのセッションが消える
 * - 端末を取り消したら、その端末のセッションはすぐ消す（T-12）
 * - 持てるのは 32 個まで。超えたら古いものから消す
 */
import { randomBase64url, sha256Hex } from "./webauthn.ts";

export const SESSION_COOKIE = "aicoop_session";
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const MAX_SESSIONS = 32;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface Session {
  readonly deviceId: string;
  readonly expiresAt: Date;
}

export interface SessionStore {
  create(deviceId: string): { readonly token: string; readonly expiresAt: Date };
  /** 有効なセッション（期限内）。なければ undefined */
  resolve(token: string | undefined): Session | undefined;
  remove(token: string): void;
  /** その端末のセッションをすべて消す。消した数を返す */
  removeDevice(deviceId: string): number;
}

export function createSessionStore(now: () => Date): SessionStore {
  /** トークンのハッシュ → セッション（入れた順） */
  const sessions = new Map<string, { deviceId: string; expiresAt: number }>();

  const prune = () => {
    const t = now().getTime();
    for (const [key, s] of sessions) if (s.expiresAt <= t) sessions.delete(key);
  };

  return {
    create(deviceId) {
      prune();
      while (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
      const token = randomBase64url(32);
      const expiresAt = now().getTime() + SESSION_TTL_MS;
      sessions.set(sha256Hex(token), { deviceId, expiresAt });
      return { token, expiresAt: new Date(expiresAt) };
    },
    resolve(token) {
      if (token === undefined || !TOKEN.test(token)) return undefined;
      const key = sha256Hex(token);
      const s = sessions.get(key);
      if (s === undefined) return undefined;
      if (s.expiresAt <= now().getTime()) {
        sessions.delete(key);
        return undefined;
      }
      return { deviceId: s.deviceId, expiresAt: new Date(s.expiresAt) };
    },
    remove(token) {
      if (TOKEN.test(token)) sessions.delete(sha256Hex(token));
    },
    removeDevice(deviceId) {
      let n = 0;
      for (const [key, s] of sessions) {
        if (s.deviceId === deviceId) {
          sessions.delete(key);
          n++;
        }
      }
      return n;
    },
  };
}
