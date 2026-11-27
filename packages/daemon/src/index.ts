// ローカルHTTP API の形（9.2）
export * from "./api/contract.ts";
export { isProcessAlive, readDaemonInfo } from "./daemon/runtime-files.ts";
// 制御サーバー本体（aicoop daemon）
export {
  type DaemonHandle,
  DaemonStartError,
  type DaemonStartErrorCode,
  type StartDaemonOptions,
  startDaemon,
} from "./daemon/start.ts";
// state.db（7章）
export {
  AuditChainBrokenError,
  type AuditInput,
  appendAudit,
  listAuditLog,
  pruneAuditLog,
  verifyAuditLog,
} from "./db/audit.ts";
// 一時権限（判定に使う部分）と保留の記録（5.2.4 の2、5.2.6 の1）
export { activeGrantsFor } from "./db/grants.ts";
export { createHold, getHold, type Hold, type NewHoldInput } from "./db/holds.ts";
export {
  type OpenStateDbOptions,
  openStateDb,
  STATE_DB_VERSION,
  type StateDb,
  writeTransaction,
} from "./db/open.ts";
export { type RestartRecovery, recoverAfterRestart } from "./db/restart.ts";
export {
  createRun,
  finishRun,
  getRun,
  listOpenRuns,
  listRunsForTask,
  type NewRunInput,
  type Run,
  RunNotFoundError,
  RunStateError,
  setRunSessionId,
} from "./db/runs.ts";
export type { RunEndReason, UsageStatus } from "./db/schema.ts";
export * as schema from "./db/schema.ts";
export { getSession, type Session, saveSession, touchSession } from "./db/sessions.ts";
export {
  cancelTask,
  createTask,
  getTask,
  InvalidTaskTransitionError,
  listTasks,
  type NewTaskInput,
  recordTaskResult,
  type Task,
  TaskNotFoundError,
  TaskStateError,
  type TransitionOptions,
  taskResultFiles,
  transitionTask,
} from "./db/tasks.ts";
export { getUsageState, setUsageState, type UsageState, usageGate } from "./db/usage.ts";
// 道具ゲート（5.3.1〜5.3.3、9.3）
export {
  type Gateway,
  type GatewayErrorCode,
  type GatewayOptions,
  openGateway,
  ReportRejectedError,
  type ReportResult,
} from "./gateway/server.ts";
export type { LineStream } from "./log.ts";
// ~/.aicoop の中の置き場所（6.1）
export { type AicoopPaths, aicoopPaths, resolveAicoopHome } from "./paths.ts";
// 資格プロキシの判定（5.2.4〜5.2.6 の1）
export {
  createProxyHandler,
  HOLD_FILE_FORMAT,
  MAX_HOLD_BODY_BYTES,
  type ProxyContext,
  readHoldFile,
  type SavedHoldRequest,
} from "./proxy/decide.ts";
// 1つのタスクを1回実行する（8.1）
export {
  type CleanupResult,
  cleanMemberHome,
  cleanupBeforeRun,
  QUARANTINE_DIR,
  quarantineWorkFiles,
} from "./run/cleanup.ts";
export { createStartRun, type StartRunOptions, startRun } from "./run/execute.ts";
export { GATEWAY_MCP_URL, managedSettings, mcpConfig } from "./run/managed-settings.ts";
export { GUEST_PATHS, vmMounts } from "./run/mounts.ts";
export { createRedactor, type Redactor } from "./run/redact.ts";
export { removeRuntimeDir } from "./run/runtime-files.ts";
export { parseStreamLine, type StreamEvent } from "./run/stream-json.ts";
// 実行と制御サーバーの境界
export type {
  BoxDrivers,
  CancelReason,
  RunEnvironment,
  RunHandle,
  RunOutcome,
  RunRequest,
  StartRun,
} from "./run/types.ts";
// 資格の用意（5.2.8 の4、5.4.1）
export {
  type AnthropicTokenResult,
  CredentialError,
  githubAppJwt,
  githubPermissionsFor,
  githubRepositoriesFor,
  type PreparedSecrets,
  type PrepareSecretsInput,
  prepareBoxSecrets,
  readAnthropicToken,
} from "./secrets/issue.ts";
// 資格保管庫（5.2.8）
export {
  listSecrets,
  readSecret,
  removeSecret,
  type SecretListEntry,
  SecretStoreError,
  type SecretValue,
  type StoredSecret,
  setSecret,
  validateSecretValue,
} from "./secrets/store.ts";
