/**
 * ハッシュのルーター（`#/pending` など）。daemon は `/app/` の静的ファイルだけを配ればよく、
 * サーバー側の道に依存しない。ID は 7.1 の形（接頭辞 + ULID）を確かめてから API に渡す。
 */
import { useEffect, useState } from "react";

export type Route =
  | { readonly name: "setup" }
  | { readonly name: "settings" }
  | { readonly name: "pending" }
  | { readonly name: "hold"; readonly id: string }
  | { readonly name: "grant"; readonly id: string }
  | { readonly name: "status" }
  | { readonly name: "task"; readonly id: string }
  | { readonly name: "new-task" }
  | { readonly name: "usage" }
  | { readonly name: "audit" }
  | { readonly name: "devices" }
  | { readonly name: "host-tools" }
  | { readonly name: "ceo" }
  | { readonly name: "settings" }
  | { readonly name: "secrets" }
  | { readonly name: "pair"; readonly code: string | null }
  | { readonly name: "not-found"; readonly hash: string };

/** 7.1：接頭辞 + Crockford の base32 の大文字26文字（先頭は 0〜7） */
function isId(value: string | undefined, prefix: string): value is string {
  return value !== undefined && new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`).test(value);
}

/**
 * ペアリングのコード（daemon の normalizePairingCode と同じ形：Crockford の base32 10文字。
 * ハイフン・小文字は許す）。表示の形 `ABCDE-FGHJK` にそろえる。形が違えば入れない（5.14 の2の3）
 */
function pairCode(value: string | null): string | null {
  if (value === null || value.length > 40) return null;
  const v = value.replace(/-/g, "").toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{10}$/.test(v)) return null;
  return `${v.slice(0, 5)}-${v.slice(5)}`;
}

export function parseRoute(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [pathPart = "", queryPart = ""] = raw.split("?", 2);
  const path = pathPart.replace(/\/+$/, "");
  const parts = path.split("/").filter((p) => p !== "");
  const notFound: Route = { name: "not-found", hash };
  const [a, b, c, ...rest] = parts;
  if (rest.length > 0) return notFound;

  switch (a) {
    case undefined:
      return { name: "pending" };
    case "pending":
      if (b === undefined) return { name: "pending" };
      if (b === "hold" && isId(c, "h")) return { name: "hold", id: c };
      if (b === "grant" && isId(c, "g")) return { name: "grant", id: c };
      return notFound;
    case "tasks":
      if (c !== undefined) return notFound;
      if (b === "new") return { name: "new-task" };
      if (isId(b, "t")) return { name: "task", id: b };
      return notFound;
    case "pair":
      if (b !== undefined) return notFound;
      return { name: "pair", code: pairCode(new URLSearchParams(queryPart).get("code")) };
    case "status":
    case "usage":
    case "audit":
    case "devices":
    case "host-tools":
    case "ceo":
    case "setup":
    case "settings":
    case "secrets":
      return b === undefined ? { name: a } : notFound;
    default:
      return notFound;
  }
}

export function hrefOf(route: Route): string {
  switch (route.name) {
    case "hold":
      return `#/pending/hold/${route.id}`;
    case "grant":
      return `#/pending/grant/${route.id}`;
    case "task":
      return `#/tasks/${route.id}`;
    case "new-task":
      return "#/tasks/new";
    case "pair":
      return route.code === null ? "#/pair" : `#/pair?code=${encodeURIComponent(route.code)}`;
    case "not-found":
      return "#/pending";
    default:
      return `#/${route.name}`;
  }
}

export function navigate(route: Route): void {
  window.location.hash = hrefOf(route);
}

/** いまの道（`hashchange` で変わる） */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    onChange();
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
