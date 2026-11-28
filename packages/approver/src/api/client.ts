/**
 * ローカルAPI（9.2）の呼び出し。承認アプリから API を呼ぶのは、ここの `request` 1か所だけにする。
 *
 * - 承認アプリは daemon と同じオリジン（`http://localhost:<port>`）で配られるので、`/api/v1` を
 *   同じオリジンのクッキー（`aicoop_session`）で呼ぶ
 * - 失敗は `ApiFailure`。`message` は利用者に見せる日本語（daemon の `ApiError.message` をそのまま）
 * - 401 ならログインへ戻す（`onUnauthorized`）。届かなければ `offline`（`onReachable(false)`）
 */
import type {
  ApiError,
  ApiErrorCode,
  ApprovalAssertRequest,
  ApprovalAssertResponse,
  ApprovalIntentRequest,
  ApprovalIntentResponse,
  CancelTaskResponse,
  ClaudeLoginView,
  ConfigIssue,
  CreateConfigChangeRequest,
  CreateConfigChangeResponse,
  CreateSecretChangeRequest,
  CreateSecretChangeResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  GetConfigFileResponse,
  GetHoldResponse,
  GetImageBuildResponse,
  GetTaskResponse,
  GrantStatusView,
  HoldStatus,
  ImageBuildView,
  ListAuditResponse,
  ListConfigFilesResponse,
  ListDevicesResponse,
  ListGrantsResponse,
  ListHoldsResponse,
  ListSecretsResponse,
  ListTasksResponse,
  LoginOptionsResponse,
  LoginVerifyRequest,
  LoginVerifyResponse,
  LogoutResponse,
  MeResponse,
  PairingOptionsRequest,
  PairingOptionsResponse,
  PairingRegisterRequest,
  PairingRegisterResponse,
  RevokeDeviceResponse,
  SetupCompanyRequest,
  SetupRepositoriesRequest,
  SetupResponse,
  StatusResponse,
  UsageResponse,
} from "@aicoop/shared/api";
import type { TaskStatus } from "../lib/labels.ts";

/** daemon の ApiErrorCode に、届かない（offline）・読めない応答（bad_response）を足したもの */
export type FailureCode = ApiErrorCode | "offline" | "bad_response";

export class ApiFailure extends Error {
  /** HTTP のステータス。届かなければ 0 */
  readonly status: number;
  readonly code: FailureCode;
  /** config_invalid のとき、設定の誤り（6.10。設定の画面で見せる） */
  readonly issues: readonly ConfigIssue[] | undefined;

  constructor(status: number, code: FailureCode, message: string, issues?: readonly ConfigIssue[]) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

/** 設定の誤りの形（daemon の ConfigIssue）。知らない形のものは捨てずに、読める欄だけ残す */
function readIssues(value: unknown): ConfigIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    .map((v) => ({
      code: typeof v.code === "string" ? v.code : "?",
      message: typeof v.message === "string" ? v.message : "",
      ...(typeof v.source === "string" ? { source: v.source } : {}),
      ...(typeof v.path === "string" ? { path: v.path } : {}),
    })) as ConfigIssue[];
}

export const OFFLINE_MESSAGE =
  "制御サーバーに届いていません。PC で aicoop が動いているか（aicoop start）確かめてください";

export interface ApiClientOptions {
  readonly fetch?: typeof fetch;
  /** 既定 `/api/v1`（9.2） */
  readonly base?: string;
  readonly onUnauthorized?: () => void;
  readonly onReachable?: (reachable: boolean) => void;
}

/** ログインと端末の登録は、ログインの前に呼ぶ道なので、401 でもログインへ戻さない */
function isAuthFree(path: string): boolean {
  return path.startsWith("/auth/login/") || path.startsWith("/pairing/");
}

function isApiError(value: unknown): value is ApiError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.error === "string" && typeof v.message === "string" && v.message !== "";
}

function query(params: Record<string, string | number | readonly string[] | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const text = Array.isArray(value)
      ? value.map((v: string) => encodeURIComponent(v)).join(",")
      : encodeURIComponent(String(value));
    if (text === "") continue;
    parts.push(`${encodeURIComponent(key)}=${text}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

const seg = encodeURIComponent;

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(options: ApiClientOptions = {}) {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const base = options.base ?? "/api/v1";

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const init: RequestInit = {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
    };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }

    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, init);
    } catch {
      options.onReachable?.(false);
      throw new ApiFailure(0, "offline", OFFLINE_MESSAGE);
    }
    options.onReachable?.(true);

    let parsed: unknown;
    let readable = true;
    try {
      parsed = JSON.parse(await res.text());
    } catch {
      readable = false;
    }

    if (!res.ok) {
      if (res.status === 401 && !isAuthFree(path)) options.onUnauthorized?.();
      if (readable && isApiError(parsed)) {
        throw new ApiFailure(
          res.status,
          parsed.error,
          parsed.message,
          readIssues((parsed as { issues?: unknown }).issues),
        );
      }
      throw new ApiFailure(
        res.status,
        "bad_response",
        `制御サーバーから読めない応答が返りました（HTTP ${res.status}）`,
      );
    }
    if (!readable || typeof parsed !== "object" || parsed === null) {
      throw new ApiFailure(
        res.status,
        "bad_response",
        `制御サーバーから読めない応答が返りました（HTTP ${res.status}）`,
      );
    }
    return parsed as T;
  }

  const get = <T>(path: string) => request<T>("GET", path);
  const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body);

  return {
    // ---- ログイン・端末の登録（5.8 の2、9.2） ----
    me: () => get<MeResponse>("/auth/me"),
    logout: () => post<LogoutResponse>("/auth/logout"),
    loginOptions: () => post<LoginOptionsResponse>("/auth/login/options"),
    loginVerify: (req: LoginVerifyRequest) => post<LoginVerifyResponse>("/auth/login/verify", req),
    pairingOptions: (req: PairingOptionsRequest) =>
      post<PairingOptionsResponse>("/pairing/options", req),
    pairingRegister: (req: PairingRegisterRequest) =>
      post<PairingRegisterResponse>("/pairing/register", req),

    // ---- 稼働状況・タスク ----
    status: () => get<StatusResponse>("/status"),
    listTasks: (opts: { statuses?: readonly TaskStatus[]; limit?: number } = {}) =>
      get<ListTasksResponse>(`/tasks${query({ status: opts.statuses, limit: opts.limit })}`),
    getTask: (id: string) => get<GetTaskResponse>(`/tasks/${seg(id)}`),
    createTask: (req: CreateTaskRequest) => post<CreateTaskResponse>("/tasks", req),
    cancelTask: (id: string) => post<CancelTaskResponse>(`/tasks/${seg(id)}/cancel`),

    // ---- 保留・一時権限・承認（5.7、5.8 の3） ----
    listHolds: (statuses?: readonly HoldStatus[]) =>
      get<ListHoldsResponse>(`/holds${query({ status: statuses })}`),
    getHold: (id: string) => get<GetHoldResponse>(`/holds/${seg(id)}`),
    listGrants: (statuses?: readonly GrantStatusView[]) =>
      get<ListGrantsResponse>(`/grants${query({ status: statuses })}`),
    approvalIntent: (req: ApprovalIntentRequest) =>
      post<ApprovalIntentResponse>("/approvals/intent", req),
    approvalAssert: (req: ApprovalAssertRequest) =>
      post<ApprovalAssertResponse>("/approvals/assert", req),

    // ---- 利用枠・記録・端末 ----
    usage: () => get<UsageResponse>("/usage"),
    audit: (opts: { after: number; limit: number }) =>
      get<ListAuditResponse>(`/audit${query({ after: opts.after, limit: opts.limit })}`),
    devices: () => get<ListDevicesResponse>("/devices"),
    revokeDevice: (id: string) => post<RevokeDeviceResponse>(`/devices/${seg(id)}/revoke`),

    // ---- 設定の画面と資格の画面（5.14 の4・5。PC のブラウザだけ） ----
    listConfigFiles: () => get<ListConfigFilesResponse>("/config/files"),
    /** パスは `/` で区切ったまま、各段を符号にする（daemon は % を含むパスを受けない。形は画面で確かめてから渡す） */
    getConfigFile: (path: string) =>
      get<GetConfigFileResponse>(`/config/files/${path.split("/").map(seg).join("/")}`),
    createConfigChange: (req: CreateConfigChangeRequest) =>
      post<CreateConfigChangeResponse>("/config/changes", req),
    listSecrets: () => get<ListSecretsResponse>("/secrets"),
    createSecretChange: (req: CreateSecretChangeRequest) =>
      post<CreateSecretChangeResponse>("/secrets/changes", req),

    // ---- 準備の画面（5.14 の3。PC のブラウザだけ） ----
    setup: () => get<SetupResponse>("/setup"),
    setupCompany: (req: SetupCompanyRequest) =>
      post<CreateConfigChangeResponse>("/setup/company", req),
    setupRepositories: (req: SetupRepositoriesRequest) =>
      post<CreateConfigChangeResponse>("/setup/github/repositories", req),
    startClaudeLogin: () => post<ClaudeLoginView>("/setup/claude-login"),
    submitClaudeLoginCode: (id: string, code: string) =>
      post<ClaudeLoginView>(`/setup/claude-login/${seg(id)}/code`, { code }),
    cancelClaudeLogin: (id: string) =>
      post<ClaudeLoginView>(`/setup/claude-login/${seg(id)}/cancel`),
    startImageBuild: () => post<ImageBuildView>("/images/build"),
    imageBuild: () => get<GetImageBuildResponse>("/images/build"),
  };
}
