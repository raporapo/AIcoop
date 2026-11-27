// ローカルHTTP API の形（9.2）
export * from "./api/contract.ts";
// state.db（7章）
export {
  AuditChainBrokenError,
  type AuditInput,
  appendAudit,
  listAuditLog,
  pruneAuditLog,
  verifyAuditLog,
} from "./db/audit.ts";
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
// ~/.aicoop の中の置き場所（6.1）
export { type AicoopPaths, aicoopPaths, resolveAicoopHome } from "./paths.ts";
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
