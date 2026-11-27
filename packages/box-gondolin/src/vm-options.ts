import { statSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import type { BoxSpec, Mount, NetworkPolicy } from "@aicoop/shared";
import {
  type HttpFetch,
  type HttpHooks,
  ReadonlyProvider,
  RealFSProvider,
  type VirtualProvider,
  type VMOptions,
} from "@earendil-works/gondolin";

/** 5.1.6 の既定 */
export const DEFAULT_MEMORY_MIB = 2048;
export const DEFAULT_CPUS = 2;

/** 箱の中の既定の PATH（Alpine の /etc/profile と同じ） */
export const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** 道具ゲートの名前（5.3.1 の2） */
export const GATEWAY_HOST = "aicoop.internal";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** 素通しにしてはならない名前の末尾（ホストの内側を指す） */
const INTERNAL_SUFFIXES = [".internal", ".local", ".localhost"];
/** 箱の中で、マウントしてはならない場所（Gondolin とカーネルが使う） */
const RESERVED_GUEST_PATHS = ["/data", "/etc/gondolin", "/proc", "/sys", "/dev", "/run"];

export interface VmOptionsInput {
  readonly spec: BoxSpec;
  readonly httpHooks: HttpHooks;
  /** 箱の環境変数に入れる仮の札 */
  readonly placeholders: Readonly<Record<string, string>>;
  readonly defaultImage?: string;
  readonly upstreamFetch?: HttpFetch;
}

/** BoxSpec を Gondolin の VMOptions にする。誤りがあれば、VM を作る前に例外で止める */
export function toVmOptions(input: VmOptionsInput): VMOptions {
  const { spec } = input;
  if (spec.kind !== "vm") {
    throw new Error(`この箱のドライバーは vm だけを作ります（kind: ${String(spec.kind)}）`);
  }
  const memoryMiB = spec.memoryMiB ?? DEFAULT_MEMORY_MIB;
  if (!Number.isInteger(memoryMiB) || memoryMiB < 128 || memoryMiB > 1_048_576) {
    throw new Error(`memoryMiB が不正です：${String(memoryMiB)}`);
  }
  const cpus = spec.cpus ?? DEFAULT_CPUS;
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > 256) {
    throw new Error(`cpus が不正です：${String(cpus)}`);
  }

  const image = spec.image ?? input.defaultImage;

  return {
    memory: `${memoryMiB}M`,
    cpus,
    env: toEnv(spec.env, input.placeholders),
    httpHooks: input.httpHooks,
    // tcp.hosts には、ホストごとの合成DNSが要る（Gondolin の qemu/tcp.js）
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
    tcp: { hosts: toTcpHosts(spec.network) },
    // WebSocket に切り替えたあとの中身は判定できないので、使わせない（P-3）
    allowWebSockets: false,
    vfs: { mounts: toMounts(spec.mounts) },
    // GONDOLIN_DEBUG があっても、通信の中身をログに出さない（11.5）
    sandbox: { debug: false, ...(image === undefined ? {} : { imagePath: image }) },
    debugLog: null,
    sessionLabel: `aicoop ${spec.groupId} ${spec.runId}`,
    ...(input.upstreamFetch === undefined ? {} : { fetch: input.upstreamFetch }),
  };
}

function toEnv(
  env: Readonly<Record<string, string>>,
  placeholders: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = { PATH: DEFAULT_PATH };
  for (const [name, value] of Object.entries(env)) {
    assertEnvEntry(name, value);
    if (Object.hasOwn(placeholders, name)) {
      // 値は出さない（本物の資格が紛れ込んでいるかもしれない）
      throw new Error(`環境変数 ${name} は資格（secrets）と同じ名前なので env には書けません`);
    }
    out[name] = value;
  }
  return { ...out, ...placeholders };
}

export function assertEnvEntry(name: string, value: unknown): void {
  if (!ENV_NAME.test(name)) {
    throw new Error(`環境変数の名前が不正です：${JSON.stringify(name)}`);
  }
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`環境変数 ${name} の値が不正です`);
  }
}

function toTcpHosts(network: NetworkPolicy): Record<string, string> {
  const port = network.gatewayPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`gatewayPort が不正です：${String(port)}`);
  }
  const hosts: Record<string, string> = {
    // V-2：道具ゲート（5.3.1 の2）
    [`${GATEWAY_HOST}:80`]: `127.0.0.1:${port}`,
  };
  for (const host of network.passthroughHosts) {
    assertPassthroughHost(host);
    // V-1：Anthropic 宛ては、暗号を解かずにそのまま流す（5.2.7 の1）
    hosts[`${host}:443`] = `${host}:443`;
  }
  return hosts;
}

function assertPassthroughHost(host: string): void {
  const ok =
    HOSTNAME.test(host) &&
    isIP(host) === 0 &&
    host !== GATEWAY_HOST &&
    !INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
  if (!ok) {
    throw new Error(`素通しにできないホストです：${JSON.stringify(host)}`);
  }
}

function toMounts(mounts: readonly Mount[]): Record<string, VirtualProvider> {
  const out: Record<string, VirtualProvider> = {};
  for (const mount of mounts) {
    assertGuestPath(mount.guestPath);
    if (Object.hasOwn(out, mount.guestPath)) {
      throw new Error(`同じ場所に2つマウントしています：${mount.guestPath}`);
    }
    assertHostDirectory(mount.hostPath);
    const provider = new RealFSProvider(mount.hostPath);
    out[mount.guestPath] = mount.readOnly ? new ReadonlyProvider(provider) : provider;
  }
  return out;
}

function assertGuestPath(guestPath: string): void {
  const invalid = () => new Error(`箱の中のパスが不正です：${JSON.stringify(guestPath)}`);
  if (typeof guestPath !== "string" || !guestPath.startsWith("/") || guestPath === "/") {
    throw invalid();
  }
  if (guestPath.includes("\\") || guestPath.includes("\0")) throw invalid();
  const segments = guestPath.slice(1).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw invalid();
  for (const reserved of RESERVED_GUEST_PATHS) {
    if (guestPath === reserved || guestPath.startsWith(`${reserved}/`)) throw invalid();
  }
}

function assertHostDirectory(hostPath: string): void {
  if (typeof hostPath !== "string" || !isAbsolute(hostPath)) {
    throw new Error(`ホストのパスは絶対パスで書きます：${JSON.stringify(hostPath)}`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(hostPath).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    throw new Error(`ホストのフォルダがありません：${hostPath}`);
  }
}
