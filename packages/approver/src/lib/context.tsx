/**
 * 画面が共通に使うもの（API・パスキー・時計・ログインの状態・届いているか）。
 * テストでは偽の fetch・時計を渡す。
 */
import type { DeviceView } from "@aicoop/shared/api";
import { createContext, useContext } from "react";
import type { ApiClient } from "../api/client.ts";
import type { SnapshotCache } from "./cache.ts";
import type { Passkeys } from "./passkeys.ts";

export interface AppDeps {
  readonly fetch: typeof fetch;
  readonly passkeys: Passkeys;
  readonly storage: Storage | null;
  readonly now: () => number;
  /** 既定はブラウザのタイムゾーン（テストで決めるときだけ） */
  readonly timeZone?: string | undefined;
  /** 読み直しの間隔。null なら読み直さない（テスト） */
  readonly pollMs: number | null;
}

export interface Session {
  readonly device: DeviceView;
  readonly expires_at: string;
}

export interface AppContextValue {
  readonly api: ApiClient;
  readonly passkeys: Passkeys;
  readonly now: () => number;
  readonly timeZone: string | undefined;
  readonly pollMs: number | null;
  readonly cache: SnapshotCache;
  /** 制御サーバーに届いているか（最後の呼び出しで） */
  readonly reachable: boolean;
  /** ログインしている端末（届かず確かめられないときは null） */
  readonly session: Session | null;
  readonly onLoggedIn: (session: Session) => void;
  readonly logout: () => Promise<void>;
  /** この端末を取り消したときなど：控えを消してログインの画面へ */
  readonly endSession: (reason: string) => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (value === null) throw new Error("AppContext がありません");
  return value;
}
