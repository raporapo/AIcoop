import { isIP } from "node:net";

/**
 * 箱から届いてはならないアドレスか（5.1.4、docs/development.md の未決 #2）。
 *
 * 名前解決のあとの IP アドレスで判定する。Gondolin の既定の判定
 * （ループバック・プライベート・リンクローカル・CGNAT）に、抜けている範囲
 * （文書用・ベンチマーク用・マルチキャスト・予約、IPv6 の IPv4 互換・NAT64・6to4・Teredo など）を足す。
 * 読めない値は、届かない側（`true`）に倒す。
 */
export function isBlockedAddress(ip: string): boolean {
  if (ip.includes("%")) return true; // ゾーンIDつき（fe80::1%eth0 など）はリンクローカル
  const family = isIP(ip);
  if (family === 4) {
    const v4 = parseIPv4(ip);
    return v4 === null || isBlockedIPv4(v4);
  }
  if (family === 6) {
    const v6 = parseIPv6(ip);
    return v6 === null || isBlockedIPv6(v6);
  }
  return true;
}

type IPv4 = readonly [number, number, number, number];

function parseIPv4(ip: string): IPv4 | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
  return bytes as unknown as IPv4;
}

function isBlockedIPv4([a, b, c]: IPv4): boolean {
  if (a === 0) return true; // 0.0.0.0/8 この網
  if (a === 10) return true; // 10.0.0.0/8 プライベート
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 ループバック
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 リンクローカル（クラウドのメタデータ）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 プライベート
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24 予約、192.0.2.0/24 文書用
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 の中継（廃止）
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 プライベート
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 ベンチマーク用
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 文書用
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 文書用
  if (a >= 224) return true; // 224.0.0.0/4 マルチキャスト、240.0.0.0/4 予約、ブロードキャスト
  return false;
}

/** 8つの16ビットの値 */
type IPv6 = readonly number[];

function parseIPv6(ip: string): IPv6 | null {
  const lower = ip.toLowerCase();
  const halves = lower.split("::");
  if (halves.length > 2) return null;
  const head = parseHextets(halves[0] ?? "");
  const tail = halves.length === 2 ? parseHextets(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function parseHextets(part: string): number[] | null {
  if (part === "") return [];
  const out: number[] = [];
  const groups = part.split(":");
  for (const [index, group] of groups.entries()) {
    if (group.includes(".")) {
      // 埋め込みの IPv4 は最後の区切りにだけ書ける
      if (index !== groups.length - 1) return null;
      const v4 = parseIPv4(group);
      if (v4 === null) return null;
      out.push(v4[0] * 256 + v4[1], v4[2] * 256 + v4[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    out.push(Number.parseInt(group, 16));
  }
  return out;
}

function embeddedIPv4(high: number, low: number): IPv4 {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isBlockedIPv6(h: IPv6): boolean {
  const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = h;
  const firstFiveZero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;
  // ::/96（未指定・ループバック・IPv4 互換）。IPv4 互換は廃止されたので、まとめて塞ぐ
  if (firstFiveZero && h5 === 0) return true;
  // ::ffff:0:0/96 IPv4 射影
  if (firstFiveZero && h5 === 0xffff) return isBlockedIPv4(embeddedIPv4(h6, h7));
  // 64:ff9b::/96 NAT64。変換先の IPv4 で判定する
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) {
    return isBlockedIPv4(embeddedIPv4(h6, h7));
  }
  // 64:ff9b:1::/48 NAT64 のローカル用
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 1) return true;
  // 100::/64 破棄用
  if (h0 === 0x100 && h1 === 0 && h2 === 0 && h3 === 0) return true;
  // 2001::/32 Teredo（中の IPv4 は読めないので塞ぐ）、2001:db8::/32 文書用
  if (h0 === 0x2001 && (h1 === 0 || h1 === 0xdb8)) return true;
  // 2002::/16 6to4。中の IPv4 で判定する
  if (h0 === 0x2002) return isBlockedIPv4(embeddedIPv4(h1, h2));
  // fc00::/7 ULA
  if ((h0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 リンクローカル、fec0::/10 サイトローカル（廃止）
  if ((h0 & 0xffc0) === 0xfe80 || (h0 & 0xffc0) === 0xfec0) return true;
  // ff00::/8 マルチキャスト
  if ((h0 & 0xff00) === 0xff00) return true;
  return false;
}
