/**
 * 承認アプリ（5.8）の外枠：ログインの確かめ、ナビゲーション、制御サーバーに届かないときの表示、
 * 新しい版の知らせ。画面はハッシュの道（`#/pending` など）で切り替える。
 */
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { type ApiFailure, createApiClient } from "./api/client.ts";
import { ErrorBox } from "./components/ui.tsx";
import { createSnapshotCache } from "./lib/cache.ts";
import {
  AppContext,
  type AppContextValue,
  type AppDeps,
  type Session,
  useApp,
} from "./lib/context.tsx";
import { PendingProvider, usePending } from "./lib/pending.tsx";
import { toFailure } from "./lib/resource.ts";
import { type Route, useRoute } from "./lib/router.ts";
import { AuditScreen } from "./screens/AuditScreen.tsx";
import { DevicesScreen } from "./screens/DevicesScreen.tsx";
import { GrantScreen } from "./screens/GrantScreen.tsx";
import { HoldScreen } from "./screens/HoldScreen.tsx";
import { LaterScreen } from "./screens/LaterScreen.tsx";
import { LoginScreen } from "./screens/LoginScreen.tsx";
import { NewTaskScreen } from "./screens/NewTaskScreen.tsx";
import { PairScreen } from "./screens/PairScreen.tsx";
import { PendingScreen } from "./screens/PendingScreen.tsx";
import { SecretsScreen } from "./screens/SecretsScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { StatusScreen } from "./screens/StatusScreen.tsx";
import { TaskScreen } from "./screens/TaskScreen.tsx";
import { UsageScreen } from "./screens/UsageScreen.tsx";

/** 新しい版の承認アプリ（Service Worker）の知らせ。main.tsx が渡す */
export interface UpdateSignal {
  subscribe(listener: () => void): () => void;
  available(): boolean;
  apply(): void;
}

type AuthState =
  | { readonly kind: "checking" }
  | { readonly kind: "logged_out"; readonly reason: string | null }
  | { readonly kind: "logged_in"; readonly session: Session }
  /** 制御サーバーに届かず、ログインしているか確かめられない（最後に見た状態を出す） */
  | { readonly kind: "unreachable" }
  | { readonly kind: "error"; readonly error: ApiFailure };

const SESSION_ENDED =
  "ログインの期限が切れたか、この端末が取り消されました。もう一度パスキーでログインしてください";

const NO_UPDATES: UpdateSignal = {
  subscribe: () => () => {},
  available: () => false,
  apply: () => {},
};

export function App({ deps, update = NO_UPDATES }: { deps: AppDeps; update?: UpdateSignal }) {
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });
  const [reachable, setReachable] = useState(true);
  const cache = useMemo(() => createSnapshotCache(deps.storage), [deps.storage]);

  const api = useMemo(
    () =>
      createApiClient({
        fetch: deps.fetch,
        onReachable: setReachable,
        onUnauthorized: () =>
          setAuth((prev) =>
            prev.kind === "logged_out"
              ? prev
              : { kind: "logged_out", reason: prev.kind === "logged_in" ? SESSION_ENDED : null },
          ),
      }),
    [deps.fetch],
  );

  const checkSession = useCallback(async () => {
    try {
      const me = await api.me();
      setAuth({ kind: "logged_in", session: me });
    } catch (e) {
      const failure = toFailure(e);
      if (failure.status === 401) return; // onUnauthorized がログインの画面にする
      if (failure.code === "offline") {
        setAuth((prev) => (prev.kind === "logged_in" ? prev : { kind: "unreachable" }));
        return;
      }
      setAuth({ kind: "error", error: failure });
    }
  }, [api]);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  // 届かないあいだは、ときどき確かめ直す
  useEffect(() => {
    if (auth.kind !== "unreachable" || deps.pollMs === null) return;
    const timer = setInterval(() => void checkSession(), deps.pollMs);
    return () => clearInterval(timer);
  }, [auth.kind, deps.pollMs, checkSession]);

  const endSession = useCallback(
    (reason: string) => {
      cache.clear();
      setAuth({ kind: "logged_out", reason });
    },
    [cache],
  );

  const ctx: AppContextValue = useMemo(
    () => ({
      api,
      passkeys: deps.passkeys,
      now: deps.now,
      timeZone: deps.timeZone,
      pollMs: deps.pollMs,
      cache,
      reachable,
      session: auth.kind === "logged_in" ? auth.session : null,
      onLoggedIn: (session) => setAuth({ kind: "logged_in", session }),
      logout: async () => {
        try {
          await api.logout();
        } catch {
          // 届かなくても、この画面からはログアウトする（クッキーは期限で切れる）
        }
        cache.clear();
        setAuth({ kind: "logged_out", reason: "ログアウトしました" });
      },
      endSession,
    }),
    [api, deps, cache, reachable, auth, endSession],
  );

  const route = useRoute();

  return (
    <AppContext.Provider value={ctx}>
      <Shell auth={auth} route={route} update={update} onRetry={checkSession} />
    </AppContext.Provider>
  );
}

function Shell({
  auth,
  route,
  update,
  onRetry,
}: {
  auth: AuthState;
  route: Route;
  update: UpdateSignal;
  onRetry: () => Promise<void>;
}) {
  const mainRef = useRef<HTMLElement>(null);
  const routeKey = JSON.stringify(route);
  const first = useRef(true);

  // 画面が変わったら、読み上げのために本文へフォーカスを移す（はじめの表示では移さない）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 道が変わったときだけ
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus();
    window.scrollTo?.(0, 0);
  }, [routeKey]);

  const signedIn = auth.kind === "logged_in" || auth.kind === "unreachable";

  let body: ReactNode;
  if (route.name === "pair") {
    body = <PairScreen code={route.code} />;
  } else if (auth.kind === "checking") {
    body = (
      <p className="muted" role="status">
        ログインしているか確かめています…
      </p>
    );
  } else if (auth.kind === "logged_out") {
    body = <LoginScreen reason={auth.reason} />;
  } else if (auth.kind === "error") {
    body = (
      <>
        <h1>承認アプリを始められません</h1>
        <ErrorBox error={auth.error} />
        <button type="button" onClick={() => void onRetry()}>
          もう一度確かめる
        </button>
      </>
    );
  } else {
    body = <RoutedScreen route={route} />;
  }

  const content = (
    <>
      <button
        type="button"
        className="skip-link"
        onClick={() => {
          mainRef.current?.focus();
        }}
      >
        本文へ移る
      </button>
      <Header signedIn={signedIn} />
      <Banners update={update} />
      {signedIn && <Nav route={route} />}
      <main id="main" ref={mainRef} tabIndex={-1}>
        {body}
      </main>
      <footer className="footer">
        <p>
          AIcoop 承認 — 承認も却下も、この端末のパスキーで署名し、PC
          の制御サーバーが確かめてから効きます。
        </p>
      </footer>
    </>
  );

  return signedIn ? <PendingProvider>{content}</PendingProvider> : content;
}

function Header({ signedIn }: { signedIn: boolean }) {
  const app = useApp();
  return (
    <header className="header">
      <p className="brand">
        <img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width="28" height="28" />
        <span>AIcoop 承認</span>
      </p>
      {signedIn && (
        <div className="header-session">
          {app.session !== null ? (
            <span className="muted small">
              ログイン中：<strong>{app.session.device.name}</strong>
            </span>
          ) : (
            <span className="muted small">ログインを確かめられていません</span>
          )}
          {app.session !== null && (
            <button type="button" className="button-small" onClick={() => void app.logout()}>
              ログアウト
            </button>
          )}
        </div>
      )}
    </header>
  );
}

function Banners({ update }: { update: UpdateSignal }) {
  const app = useApp();
  const updateAvailable = useSyncExternalStore(update.subscribe, update.available, () => false);
  return (
    <>
      {!app.reachable && (
        <div className="banner banner-offline" role="alert">
          <p>
            <span aria-hidden="true">⚠ </span>
            <strong>制御サーバーに届いていません。</strong>
            表示しているのは、最後に受け取った状態です。届くまで、承認・却下はできません。 PC で
            aicoop が動いているか（aicoop start）確かめてください。
          </p>
        </div>
      )}
      {updateAvailable && (
        <div className="banner banner-update" role="status">
          <p>
            新しい版の承認アプリがあります。
            <button type="button" className="button-small" onClick={() => update.apply()}>
              読み込み直す
            </button>
          </p>
        </div>
      )}
    </>
  );
}

const NAV_ITEMS: ReadonlyArray<{
  readonly href: string;
  readonly label: string;
  readonly match: readonly Route["name"][];
}> = [
  { href: "#/pending", label: "承認待ち", match: ["pending", "hold", "grant"] },
  { href: "#/status", label: "稼働状況", match: ["status", "task", "new-task"] },
  { href: "#/usage", label: "利用枠", match: ["usage"] },
  { href: "#/audit", label: "記録", match: ["audit"] },
  { href: "#/devices", label: "端末", match: ["devices"] },
  { href: "#/host-tools", label: "ホストの道具", match: ["host-tools"] },
  { href: "#/ceo", label: "CEO に頼む", match: ["ceo"] },
  // 5.14 の4・5（PC のブラウザだけ）
  { href: "#/settings", label: "設定", match: ["settings"] },
  { href: "#/secrets", label: "資格", match: ["secrets"] },
];

function Nav({ route }: { route: Route }) {
  const pending = usePending();
  const count = pending.ownerCount;

  useEffect(() => {
    document.title = count !== null && count > 0 ? `（${count}）AIcoop 承認` : "AIcoop 承認";
  }, [count]);

  return (
    <nav className="nav" aria-label="画面">
      <ul>
        {NAV_ITEMS.map((item) => {
          const current = item.match.includes(route.name);
          return (
            <li key={item.href}>
              <a href={item.href} aria-current={current ? "page" : undefined}>
                {item.label}
                {item.href === "#/pending" && count !== null && count > 0 && (
                  <span className="count">
                    {count}
                    <span className="sr-only">件</span>
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function RoutedScreen({ route }: { route: Route }) {
  switch (route.name) {
    case "pending":
      return <PendingScreen />;
    case "hold":
      return <HoldScreen key={route.id} id={route.id} />;
    case "grant":
      return <GrantScreen key={route.id} id={route.id} />;
    case "status":
      return <StatusScreen />;
    case "task":
      return <TaskScreen key={route.id} id={route.id} />;
    case "new-task":
      return <NewTaskScreen />;
    case "usage":
      return <UsageScreen />;
    case "audit":
      return <AuditScreen />;
    case "devices":
      return <DevicesScreen />;
    case "host-tools":
      return <LaterScreen kind="host-tools" />;
    case "ceo":
      return <LaterScreen kind="ceo" />;
    case "settings":
      return <SettingsScreen />;
    case "secrets":
      return <SecretsScreen />;
    case "pair":
      return <PairScreen code={route.code} />;
    case "not-found":
      return (
        <>
          <h1>その画面はありません</h1>
          <p>
            アドレスが正しいか確かめてください。<a href="#/pending">承認待ちの一覧へ</a>
          </p>
        </>
      );
  }
}
