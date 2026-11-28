/**
 * 承認待ち（保留と一時権限の申請）を、画面をまたいで1か所で読み直す。
 * ナビゲーションの件数と、承認待ちの一覧の両方が使う。
 */
import type {
  GrantView,
  HoldView,
  ListGrantsResponse,
  ListHoldsResponse,
} from "@aicoop/shared/api";
import { createContext, type ReactNode, useContext } from "react";
import type { ApiFailure } from "../api/client.ts";
import { grantsForCache, holdsForCache } from "./cache.ts";
import { useApp } from "./context.tsx";
import { type Resource, useResource } from "./resource.ts";

export interface PendingValue {
  readonly holds: Resource<ListHoldsResponse>;
  readonly grants: Resource<ListGrantsResponse>;
  /** オーナーの承認を待っているものの件数（まだ読めていなければ null） */
  readonly ownerCount: number | null;
  readonly ownerHolds: readonly HoldView[];
  readonly ownerGrants: readonly GrantView[];
  readonly managerHolds: readonly HoldView[];
  readonly managerGrants: readonly GrantView[];
  readonly errors: readonly { readonly what: string; readonly error: ApiFailure }[];
}

const PendingContext = createContext<PendingValue | null>(null);

export function PendingProvider({ children }: { readonly children: ReactNode }) {
  const app = useApp();
  const holds = useResource(() => app.api.listHolds(["pending_manager", "pending_owner"]), {
    key: "holds",
    cache: { name: "holds", sanitize: holdsForCache },
  });
  const grants = useResource(() => app.api.listGrants(["pending_manager", "pending_owner"]), {
    key: "grants",
    cache: { name: "grants", sanitize: grantsForCache },
  });

  const allHolds = holds.data?.holds ?? [];
  const allGrants = grants.data?.grants ?? [];
  const ownerHolds = allHolds.filter((h) => h.status === "pending_owner");
  const ownerGrants = allGrants.filter((g) => g.status === "pending_owner");
  const ready = holds.data !== undefined || grants.data !== undefined;
  const errors: { what: string; error: ApiFailure }[] = [];
  if (holds.error !== undefined && holds.error.code !== "offline") {
    errors.push({ what: "保留", error: holds.error });
  }
  if (grants.error !== undefined && grants.error.code !== "offline") {
    errors.push({ what: "一時権限の申請", error: grants.error });
  }

  const value: PendingValue = {
    holds,
    grants,
    ownerCount: ready ? ownerHolds.length + ownerGrants.length : null,
    ownerHolds,
    ownerGrants,
    managerHolds: allHolds.filter((h) => h.status === "pending_manager"),
    managerGrants: allGrants.filter((g) => g.status === "pending_manager"),
    errors,
  };
  return <PendingContext.Provider value={value}>{children}</PendingContext.Provider>;
}

export function usePending(): PendingValue {
  const value = useContext(PendingContext);
  if (value === null) throw new Error("PendingProvider がありません");
  return value;
}
