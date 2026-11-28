/**
 * 制御サーバーに届かないとき（5.8 の6）に見せる「最後に受け取った状態」の控え。
 *
 * 端末に残すのは、件数・状態・期限など一覧の骨組みだけにする。メールの本文・申請の理由・
 * 元のリクエストなどの中身は残さない（要約は除いてから書く）。ログアウトしたら消す。
 */
import type { ListGrantsResponse, ListHoldsResponse } from "@aicoop/shared/api";

const PREFIX = "aicoop.approver.snapshot.";

export interface Snapshot<T> {
  readonly savedAt: number;
  readonly value: T;
}

export interface SnapshotCache {
  read<T>(name: string): Snapshot<T> | null;
  write(name: string, value: unknown, now: number): void;
  clear(): void;
}

/** 読み書きできない（プライベートウィンドウなど）ときは、何もしない */
export function createSnapshotCache(storage: Storage | null): SnapshotCache {
  return {
    read<T>(name: string): Snapshot<T> | null {
      try {
        const raw = storage?.getItem(PREFIX + name);
        if (raw === null || raw === undefined) return null;
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed !== "object" || parsed === null) return null;
        const p = parsed as { savedAt?: unknown; value?: unknown };
        if (typeof p.savedAt !== "number" || p.value === undefined) return null;
        return { savedAt: p.savedAt, value: p.value as T };
      } catch {
        return null;
      }
    },
    write(name, value, now) {
      try {
        storage?.setItem(PREFIX + name, JSON.stringify({ savedAt: now, value }));
      } catch {
        // 書けなくても画面は動く
      }
    },
    clear() {
      try {
        if (storage === null) return;
        const keys: string[] = [];
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k?.startsWith(PREFIX)) keys.push(k);
        }
        for (const k of keys) storage.removeItem(k);
      } catch {
        // 消せなくても続ける
      }
    },
  };
}

export function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 控えに書く前に、保留の要約（メールの本文など）を除く */
export function holdsForCache(res: ListHoldsResponse): ListHoldsResponse {
  return { holds: res.holds.map((h) => ({ ...h, summary: null })) };
}

/** 控えに書く前に、一時権限の申請の理由（AI 社員が書いた文章）を除く */
export function grantsForCache(res: ListGrantsResponse): ListGrantsResponse {
  return { grants: res.grants.map((g) => ({ ...g, reason: "" })) };
}
