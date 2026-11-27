/**
 * 操作の特定（5.2.4 の1）：リクエストに一致する操作を、すべてのサービス定義から求める。
 */
import type { CompiledOperation, CompiledService, ServiceCatalog } from "./service.ts";

/** 箱から外へ出ようとしているリクエストの宛先 */
export interface RequestTarget {
  /** HTTPのメソッド。大文字・小文字を区別して照合する */
  readonly method: string;
  /** ホスト名（ポートは含めない） */
  readonly host: string;
  /** パス。クエリ文字列が付いていてもよい（照合には使わない） */
  readonly path: string;
}

export interface OperationMatch {
  readonly operation: CompiledOperation;
  /** パスから取り出したパラメーターの値（例：`{ repo: "myorg/app" }`） */
  readonly params: Readonly<Record<string, string>>;
}

/**
 * ホスト名をそろえる。DNS では大文字と小文字、末尾の `.` の有無は同じ宛先を指すので、
 * そろえないと `API.GitHub.com.` が github ではなく web の `*` に入ってしまう。
 */
export function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

export function identifyOperations(
  catalog: ServiceCatalog,
  request: RequestTarget,
): OperationMatch[] {
  const host = normalizeHost(request.host);
  const matches: OperationMatch[] = [];

  for (const service of catalog.services) {
    if (!servesHost(catalog, service, host)) continue;

    for (const operation of service.operations) {
      for (const matcher of operation.matchers) {
        if (matcher.host !== undefined && matcher.host !== host) continue;
        if (!matcher.methods.has(request.method)) continue;
        const params = matcher.pattern.match(request.path);
        if (params === null) continue;
        matches.push({ operation, params });
        break;
      }
    }
  }

  return matches;
}

function servesHost(catalog: ServiceCatalog, service: CompiledService, host: string): boolean {
  if (service.hosts.has(host)) return true;
  // web の * は、ほかのサービスの hosts に入っているホストを含まない（6.7）
  return service.wildcard && !catalog.explicitHosts.has(host);
}
