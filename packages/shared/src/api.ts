/**
 * ローカルHTTP API の形（9.2）。サーバー（daemon）とクライアント（CLI・承認アプリ）が共に使う。
 *
 * 承認アプリ（ブラウザ）からも読むので、このファイルは型だけにし、Node の部品に依存しない
 * （`@aicoop/shared/api` で読み込む）。
 *
 * - `http://127.0.0.1:<daemon.port>/api/v1/` で受ける。`127.0.0.1` 以外では待ち受けない（4.3 の2）
 * - CLI は `~/.aicoop/runtime/api_token`（0600。daemon の起動ごとに作り直す）を
 *   `Authorization: Bearer <token>` で送る
 * - JSON のキーは snake_case（state.db の列名と同じ）。時刻は UTC の ISO 8601
 * - 失敗したときは、HTTP のステータスと `ApiError` を返す。`message` は利用者に見せる日本語
 */
import type { BoxKind } from "./box.ts";
import type { ConfigIssue } from "./config-issue.ts";
import type { TriggerKind } from "./scheduler.ts";
import type { TaskStatus } from "./task-state.ts";

/** 実行の終わり方（7.2 の runs.end_reason） */
export type RunEndReason = "exited" | "timeout" | "killed" | "daemon_restart";

/** 利用枠の状態（7.2 の usage_state.status） */
export type UsageStatus = "allowed" | "allowed_warning" | "rejected";

export const API_PREFIX = "/api/v1";

/** CLI が daemon を見つけるために、daemon が `runtime/daemon.json` に書くもの */
export interface DaemonInfo {
  readonly pid: number;
  readonly port: number;
  readonly started_at: string;
  readonly home: string;
  readonly version: string;
}

export type ApiErrorCode =
  /** トークンがない・違う */
  | "unauthorized"
  /** Host ヘッダーが 127.0.0.1・localhost ではない（DNS リバインディング対策） */
  | "forbidden_host"
  /** クッキー・認証なしの POST で、`Origin` が `http://localhost:<port>` ではない（CSRF 対策。P2） */
  | "forbidden_origin"
  | "not_found"
  /** 入力が型・上限に合わない */
  | "invalid_input"
  /** 知らない社員・人間の社員など、タスクを作れない相手 */
  | "unknown_member"
  /** その状態ではできない（終わったタスクの取り消しなど） */
  | "invalid_state"
  /** 設定にエラーがある（reload） */
  | "config_invalid"
  | "internal"
  /** 承認・ペアリング（P2）のエラー */
  | ApprovalErrorCode;

export interface ApiError {
  readonly error: ApiErrorCode;
  readonly message: string;
  /** config_invalid のとき */
  readonly issues?: readonly ConfigIssue[];
}

export interface TaskView {
  readonly id: string;
  readonly member_id: string;
  readonly group_id: string;
  readonly trigger_kind: TriggerKind;
  readonly trigger_id: string | null;
  readonly priority: number;
  readonly thread: string;
  readonly status: TaskStatus;
  readonly purpose: string;
  readonly context: string;
  readonly context_untrusted: boolean;
  readonly done_when: string;
  readonly reply_as: "file" | "task";
  readonly ticket_id: string | null;
  readonly review_subject: string | null;
  readonly hold_id: string | null;
  readonly timeout_minutes: number;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly retry_at: string | null;
  readonly result_summary: string | null;
  readonly result_files: readonly string[] | null;
  readonly error: string | null;
}

export interface RunView {
  readonly id: string;
  readonly task_id: string;
  readonly group_id: string;
  readonly member_id: string;
  readonly box_kind: BoxKind;
  readonly session_id: string | null;
  readonly gateway_port: number;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly exit_code: number | null;
  readonly end_reason: RunEndReason | null;
  readonly log_path: string;
}

export interface UsageView {
  readonly status: UsageStatus;
  readonly resets_at: string | null;
  readonly rate_limit_type: string | null;
  readonly utilization: number | null;
  readonly updated_at: string;
}

export interface RunningBoxView {
  readonly group_id: string;
  readonly member_id: string;
  readonly task_id: string;
  readonly run_id: string | null;
  readonly box_kind: BoxKind;
  readonly started_at: string;
}

export interface TriggerView {
  readonly id: string;
  readonly type: string;
  readonly member: string;
  readonly enabled: boolean;
  /** cron だけ。次に起きる時刻 */
  readonly next_run_at: string | null;
}

/** `GET /status` */
export interface StatusResponse {
  readonly company: { readonly id: string; readonly name: string };
  readonly daemon: DaemonInfo & { readonly config_loaded_at: string };
  readonly boxes: {
    readonly max_concurrent: number;
    readonly running: readonly RunningBoxView[];
  };
  /** 状態ごとのタスクの数（0 の状態も入れる） */
  readonly tasks: Readonly<Record<TaskStatus, number>>;
  readonly usage: UsageView | null;
  readonly holds: { readonly pending: number };
  readonly triggers: readonly TriggerView[];
  /** 設定の警告（6.10 の W-xxx） */
  readonly warnings: readonly ConfigIssue[];
}

/** `GET /tasks?status=<状態,状態>&limit=<1〜500、既定100>`。新しい順 */
export interface ListTasksResponse {
  readonly tasks: readonly TaskView[];
}

/** `POST /tasks`（手動のタスク。トリガー manual、9.1 の aicoop run） */
export interface CreateTaskRequest {
  readonly member: string;
  readonly purpose: string;
  readonly done_when: string;
  readonly context?: string;
  readonly thread?: string;
  /** 1〜55。なければ aicoop.yaml の task.timeout_minutes */
  readonly timeout_minutes?: number;
}

/** `POST /tasks` は 201 */
export interface CreateTaskResponse {
  readonly task: TaskView;
}

/** `GET /tasks/{id}` */
export interface GetTaskResponse {
  readonly task: TaskView;
  /** 古い順 */
  readonly runs: readonly RunView[];
}

/** `POST /tasks/{id}/cancel` */
export interface CancelTaskResponse {
  readonly task: TaskView;
  /** 動いていた（箱を止めた）なら true */
  readonly was_active: boolean;
}

/** `POST /reload`（設定を読み直す。エラーなら 422 と config_invalid で、前の設定のまま） */
export interface ReloadResponse {
  readonly ok: true;
  readonly warnings: readonly ConfigIssue[];
  /** 読み直した設定ファイルごとの SHA-256 */
  readonly files: Readonly<Record<string, string>>;
}

export interface AuditEntryView {
  readonly seq: number;
  readonly ts: string;
  readonly actor: string;
  readonly kind: string;
  readonly subject: string;
  readonly data: unknown;
}

/** `GET /audit?after=<seq>&limit=<1〜1000、既定200>`。古い順 */
export interface ListAuditResponse {
  readonly entries: readonly AuditEntryView[];
}

export interface HoldView {
  readonly id: string;
  readonly task_id: string;
  readonly member_id: string;
  readonly group_id: string;
  readonly operation: string;
  readonly status: string;
  readonly summary: unknown;
  readonly created_at: string;
  readonly expires_at: string;
}

/** `GET /holds` */
export interface ListHoldsResponse {
  readonly holds: readonly HoldView[];
}

/** `GET /usage` */
export interface UsageResponse {
  readonly usage: UsageView | null;
}

/** `POST /shutdown`（aicoop stop。動いている実行を止めてから終わる） */
export interface ShutdownResponse {
  readonly ok: true;
}

// =============================================================================
// P2：端末の登録・パスキーでのログイン・承認の署名（5.8）、保留と一時権限（5.2.6・5.7）
// =============================================================================
//
// 承認アプリは daemon が `http://localhost:<daemon.port>/app/` で配る（5.8 の1）。
// パスキーの RP ID は `localhost`、オリジンは `http://localhost:<daemon.port>`（IP アドレスは RP ID にできない）。
//
// 認証の種類：
// - Bearer（CLI）：これまでの API すべてと、`/pairing/local*`・`/devices*`
// - セッションクッキー `aicoop_session`（承認アプリ）：パスキーでログインしたあと。HttpOnly・SameSite=Strict。
//   クッキーで来た状態を変えるリクエスト（POST）は、`Origin` が `http://localhost:<port>` でなければ 403
// - なし：`/pairing/options`・`/pairing/register`（1回限りのペアリングコードが鍵）、`/auth/login/*`、`/app/*`（静的ファイル）

/** WebAuthn の JSON（@simplewebauthn の `*JSON` 型）。形はライブラリの型で扱う */
export type WebAuthnJson = Readonly<Record<string, unknown>>;

export interface DeviceView {
  readonly id: string;
  readonly name: string;
  readonly kind: "phone" | "pc";
  readonly created_at: string;
  readonly revoked_at: string | null;
}

/** `GET /devices`（Bearer・クッキー） */
export interface ListDevicesResponse {
  readonly devices: readonly DeviceView[];
}

/** `POST /devices/{id}/revoke`（Bearer・クッキー。aicoop devices revoke） */
export interface RevokeDeviceResponse {
  readonly device: DeviceView;
}

// ---- 端末の登録：aicoop pair --local（5.8 の2。P2 は localhost だけ） ----
//
// 1. CLI が `POST /pairing/local` で1回限りのコード（10分で失効）をもらい、URL とともに表示する
// 2. ブラウザ（承認アプリの「端末の登録」）でコードと端末の名前を入れる → `POST /pairing/options`
// 3. ブラウザがパスキーを作る（`userVerification: "required"`）→ `POST /pairing/register`
// 4. daemon が登録を確かめ、パスキーの公開鍵から6桁の確認コードを作る。ブラウザと CLI の両方に表示する
// 5. オーナーが一致を確かめて CLI で `y` → `POST /pairing/local/{code}/activate` で端末が有効になる

/** `POST /pairing/local`（Bearer） */
export interface StartLocalPairingResponse {
  /** 1回限りのペアリングコード（人が打てる長さ） */
  readonly code: string;
  readonly expires_at: string;
  /** 承認アプリの登録の画面（例：`http://localhost:7070/app/#/pair`） */
  readonly url: string;
}

export type PairingStatus = "waiting" | "registered" | "activated" | "expired" | "cancelled";

/** `GET /pairing/local/{code}`（Bearer。CLI が待つあいだ見る） */
export interface LocalPairingStatusResponse {
  readonly status: PairingStatus;
  readonly expires_at: string;
  /** registered からあと */
  readonly device_name: string | null;
  /** registered からあと。6桁の数字 */
  readonly confirm_code: string | null;
  /**
   * cancelled のときの理由（ほかは null）：`cancelled`（CLI が取り消した）、`superseded`（新しい
   * aicoop pair --local が始まった）、`too_many_attempts`（違うコードが何度も送られた）
   */
  readonly cancel_reason: PairingCancelReason | null;
}

export type PairingCancelReason = "cancelled" | "superseded" | "too_many_attempts";

/** `POST /pairing/local/{code}/activate`（Bearer）。registered のときだけ */
export interface ActivatePairingResponse {
  readonly device: DeviceView;
}

/** `POST /pairing/local/{code}/cancel`（Bearer） */
export interface CancelPairingResponse {
  readonly ok: true;
}

/** `POST /pairing/options`（認証なし。コードが違う・失効したら 404。何度も間違えたらそのコードは無効） */
export interface PairingOptionsRequest {
  readonly code: string;
  /** 1〜40文字 */
  readonly device_name: string;
}

export interface PairingOptionsResponse {
  /** PublicKeyCredentialCreationOptionsJSON */
  readonly options: WebAuthnJson;
}

/** `POST /pairing/register`（認証なし） */
export interface PairingRegisterRequest {
  readonly code: string;
  /** RegistrationResponseJSON */
  readonly response: WebAuthnJson;
}

export interface PairingRegisterResponse {
  /** 6桁の確認コード。CLI に出るものと同じか、オーナーが確かめる */
  readonly confirm_code: string;
}

// ---- パスキーでのログイン（承認アプリ。9.2） ----

/** `POST /auth/login/options`（認証なし） */
export interface LoginOptionsResponse {
  /** PublicKeyCredentialRequestOptionsJSON（有効な端末のパスキーだけ。チャレンジは2分で失効） */
  readonly options: WebAuthnJson;
}

/** `POST /auth/login/verify`（認証なし）。通れば `Set-Cookie: aicoop_session=...` */
export interface LoginVerifyRequest {
  /** AuthenticationResponseJSON */
  readonly response: WebAuthnJson;
}

export interface LoginVerifyResponse {
  readonly device: DeviceView;
  /** セッションの期限 */
  readonly expires_at: string;
}

/** `GET /auth/me`（クッキー）。ログインしていなければ 401 */
export interface MeResponse {
  readonly device: DeviceView;
  readonly expires_at: string;
}

/** `POST /auth/logout`（クッキー） */
export interface LogoutResponse {
  readonly ok: true;
}

// ---- 承認の署名（5.8 の3） ----

export type ApprovalSubjectType =
  | "hold"
  | "grant"
  | "tool_pin"
  | "human_send"
  | "human_accept"
  | "human_result";

export type ApprovalDecision = "approve" | "reject";

/**
 * 署名する payload（5.8 の3の3）。チャレンジは「この payload の正規化JSON の SHA-256」（base64url）。
 * `summary_sha256` は、承認アプリに表示した要約（`HoldDetailView.summary`、一時権限なら `GrantView` から
 * 作った要約）の正規化JSON の SHA-256（16進の小文字）。
 */
export interface ApprovalPayload {
  readonly type: ApprovalSubjectType;
  readonly id: string;
  readonly decision: ApprovalDecision;
  readonly company_id: string;
  readonly summary_sha256: string;
  readonly issued_at: string;
  /** issued_at + 2分 */
  readonly expires_at: string;
  /** 128ビットの乱数、base64url */
  readonly nonce: string;
}

/** `POST /approvals/intent`（クッキー） */
export interface ApprovalIntentRequest {
  readonly type: ApprovalSubjectType;
  readonly id: string;
  readonly decision: ApprovalDecision;
}

export interface ApprovalIntentResponse {
  readonly payload: ApprovalPayload;
  /** PublicKeyCredentialRequestOptionsJSON（チャレンジは payload から作ったもの、ログイン中の端末のパスキーだけ） */
  readonly options: WebAuthnJson;
}

/** `POST /approvals/assert`（クッキー） */
export interface ApprovalAssertRequest {
  readonly payload: ApprovalPayload;
  /** AuthenticationResponseJSON */
  readonly response: WebAuthnJson;
}

export interface ApprovalView {
  readonly id: string;
  readonly subject_type: ApprovalSubjectType;
  readonly subject_id: string;
  readonly decision: ApprovalDecision;
  readonly device_id: string;
  readonly verified_at: string;
}

export interface ApprovalAssertResponse {
  readonly approval: ApprovalView;
  /** 決定のあとの、対象の状態（例：hold は approved・rejected、grant は active・rejected） */
  readonly subject_status: string;
}

/**
 * 承認で使うエラー（`ApiError.error` に入る。HTTP は 400〜409）。
 * どれも、決定は効力を持たない（5.8 の3の6「1つでも通らなければ捨てる」）。
 */
export type ApprovalErrorCode =
  /** 署名・チャレンジ・オリジン・RP ID・カウンターのどれかが合わない */
  | "signature_invalid"
  /** 期限（2分）を過ぎた */
  | "approval_expired"
  /** 一度使った nonce */
  | "nonce_used"
  /** daemon が出していない payload、または中身が書き換えられた */
  | "payload_mismatch"
  /** 対象がもうオーナーの承認を待っていない（決まった・期限切れ） */
  | "not_pending"
  /** ペアリングのコードが違う・失効した */
  | "pairing_invalid";

// ---- 保留（5.2.6・5.7.1）と一時権限（5.7.3） ----

export type HoldStatus =
  | "pending_manager"
  | "pending_owner"
  | "approved"
  | "rejected"
  | "expired"
  | "replayed"
  | "replay_failed";

/** `GET /holds/{id}`（Bearer・クッキー） */
export interface HoldDetailView extends HoldView {
  readonly thread: string;
  readonly service: string;
  /** パスから取り出したパラメーターの値（例：`{ repo: "myorg/app" }`） */
  readonly params: Readonly<Record<string, string>>;
  readonly manager_comment: string | null;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly response_status: number | null;
  /** 元のリクエスト全体（5.7.1 の4「展開して見られる」）。認証のヘッダーは保存していない */
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body_bytes: number;
    /** UTF-8 として読めるとき（先頭 256 KiB まで） */
    readonly body_text: string | null;
    /** 読めないとき（先頭 256 KiB まで） */
    readonly body_base64: string | null;
    readonly truncated: boolean;
  };
  /** 再送の結果の本文の先頭（UTF-8 として読めるとき、先頭 64 KiB まで） */
  readonly response_text: string | null;
}

export interface GetHoldResponse {
  readonly hold: HoldDetailView;
}

export type GrantStatusView =
  | "pending_manager"
  | "pending_owner"
  | "active"
  | "rejected"
  | "expired";

export interface GrantView {
  readonly id: string;
  readonly member_id: string;
  /** `<service>.<operation>` */
  readonly operation: string;
  readonly params: Readonly<Record<string, readonly string[]>>;
  readonly mode: "allow" | "hold";
  readonly reason: string;
  readonly duration_hours: number;
  readonly status: GrantStatusView;
  readonly created_at: string;
  readonly starts_at: string | null;
  readonly expires_at: string | null;
  readonly decided_by: string | null;
}

/** `GET /grants?status=<状態,状態>`（Bearer・クッキー）。新しい順 */
export interface ListGrantsResponse {
  readonly grants: readonly GrantView[];
}
