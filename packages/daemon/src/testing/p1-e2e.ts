/**
 * テスト用：P1 の完了条件（14章）を端から端まで確かめる結合テスト（`p1.e2e.test.ts`・`p1.vm.e2e.test.ts`）で
 * 共に使う部品。
 *
 * - `aicoop init` の雛形から作った会社。部署の `your-org` をテスト用の名前に書き換え、cron のトリガーを1つ足す
 * - 資格の登録（`anthropic` は anthropic_oauth、`github` は static_token。どちらも偽の値）
 * - ローカルAPI でタスクの終わりを待つ、`logs/` の下のファイルを集める、監査ログを読む
 *
 * 偽の資格の値は、トークンの形（`sk-ant-…`・`ghp_…`）にしない。ログの形による伏せ字に頼らず、
 * 値そのものがどこにも出ていないことを確かめるため。
 */
import { randomBytes } from "node:crypto";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isTerminalTaskStatus, type TaskStatus } from "@aicoop/shared";
import type { DaemonInfo, GetTaskResponse, TaskView } from "../api/contract.ts";
import { listAuditLog } from "../db/audit.ts";
import type { StateDb } from "../db/open.ts";
import type { AicoopPaths } from "../paths.ts";
import { setSecret } from "../secrets/store.ts";
import { createTestCompany, type TestCompany } from "./company.ts";
import { apiRequest, type TestRequest, type TestResponse } from "./http.ts";

/** 部署 dev の ceiling の `your-org` を書き換える先（push を許すリポジトリの owner） */
export const E2E_ORG = "aicoop-e2e-org";
/** 許していない owner（ここへの push は拒否される） */
export const E2E_OTHER_OWNER = "someone-else";
/** 雛形に足す cron のトリガー */
export const E2E_CRON_TRIGGER = "dev-nightly-check";
/** 足す cron の時刻（Asia/Tokyo の毎日 2:30） */
export const E2E_CRON_SCHEDULE = "30 2 * * *";

/** 足す cron のトリガー（triggers.yaml の `triggers:` の直後に入れる） */
const CRON_TRIGGER_YAML = `  # P1 の結合テストで足した cron（毎日 2:30 に、開発部の実装AIが確かめて報告する）
  - id: "${E2E_CRON_TRIGGER}"
    type: cron
    schedule: "${E2E_CRON_SCHEDULE}"
    member: "dev-implementer"
    timeout_minutes: 20
    task:
      purpose: "夜のうちに、リポジトリの状態を確かめて報告する"
      done_when: "report_result で、確かめたことを報告した"
`;

/** 雛形を、P1 の結合テストの会社に書き換える */
export function e2eTransform(target: string, text: string): string {
  if (target === "groups.yaml") return text.replaceAll("your-org", E2E_ORG);
  if (target === "triggers.yaml") {
    if (!/^triggers:\n/m.test(text)) throw new Error("雛形の triggers.yaml の形が変わりました");
    return text.replace(/^triggers:\n/m, `triggers:\n${CRON_TRIGGER_YAML}`);
  }
  return text;
}

/** 雛形から、P1 の結合テストの会社を `home` に作る */
export function createE2eCompany(home: string): TestCompany {
  return createTestCompany(home, { transform: e2eTransform });
}

export interface E2eSecrets {
  /** 資格 `anthropic`（anthropic_oauth）の偽の値 */
  readonly anthropic: string;
  /** 資格 `github`（static_token）の偽の値 */
  readonly github: string;
}

/** 偽の資格を、本物の資格保管庫（secrets.json）に登録する */
export function registerE2eSecrets(paths: AicoopPaths): E2eSecrets {
  const secrets: E2eSecrets = {
    anthropic: `e2e-anthropic-${randomBytes(20).toString("hex")}`,
    github: `e2e-github-${randomBytes(20).toString("hex")}`,
  };
  setSecret(paths.secrets, "anthropic", "anthropic_oauth", { token: secrets.anthropic });
  setSecret(paths.secrets, "github", "static_token", { token: secrets.github });
  return secrets;
}

export type Api = (req: TestRequest) => Promise<TestResponse>;

/**
 * CLI と同じく、`runtime/daemon.json` と `runtime/api_token` から daemon を見つけて、ローカルAPI を呼ぶ。
 * 応答が来なかったときは、どのリクエストかを書いて投げる（PC が重いときに、どこで止まったかを見るため）。
 */
export function e2eApi(paths: AicoopPaths): { api: Api; token: string; port: number } {
  const info = JSON.parse(readFileSync(paths.daemonInfo, "utf8")) as DaemonInfo;
  const token = readFileSync(paths.apiToken, "utf8").trim();
  const api: Api = async (req) => {
    const started = Date.now();
    try {
      return await apiRequest(info.port, { token, timeoutMs: 10_000, ...req });
    } catch (error) {
      throw new Error(
        `${req.method ?? "GET"} ${req.path} に ${Date.now() - started} ms 応答がありません（${String(error)}）`,
        { cause: error },
      );
    }
  };
  return { api, token, port: info.port };
}

/** 条件を満たすまで、本当の時間で待つ */
export async function waitUntil<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs: number,
  intervalMs = 50,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`待ちきれませんでした：${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** タスクが終わりの状態（または waiting_limit など、止まった状態）になるまで、API で待つ */
export async function waitForTaskEnd(
  api: Api,
  taskId: string,
  timeoutMs: number,
): Promise<GetTaskResponse> {
  const stopped: ReadonlySet<TaskStatus> = new Set(["waiting_limit", "blocked_host_tool"]);
  return waitUntil(
    `タスク ${taskId} の終わり`,
    async () => {
      const res = await api({ path: `/tasks/${taskId}` });
      if (res.status !== 200) throw new Error(`GET /tasks/${taskId} が ${res.status}`);
      const view = res.json as GetTaskResponse;
      return isTerminalTaskStatus(view.task.status) || stopped.has(view.task.status)
        ? view
        : undefined;
    },
    timeoutMs,
  );
}

/** 条件に合うタスクができるまで、API で待つ */
export async function waitForTask(
  api: Api,
  match: (task: TaskView) => boolean,
  timeoutMs: number,
): Promise<TaskView> {
  return waitUntil(
    "タスクができること",
    async () => {
      const res = await api({ path: "/tasks" });
      return (res.json as { tasks: TaskView[] }).tasks.find(match);
    },
    timeoutMs,
  );
}

/** フォルダの下のファイルを、すべて（サブフォルダも）集める */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  walk(dir);
  return out.sort();
}

/** ファイルの中に、どの値が出ているか（出ていたファイルと値の名前） */
export function findLeaks(
  files: readonly string[],
  values: Readonly<Record<string, string>>,
): string[] {
  const leaks: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [name, value] of Object.entries(values)) {
      if (text.includes(value)) leaks.push(`${file}: ${name}`);
    }
  }
  return leaks;
}

export interface AuditRow {
  readonly seq: number;
  readonly actor: string;
  readonly kind: string;
  readonly subject: string;
  readonly data: Record<string, unknown>;
}

export function auditRows(db: StateDb): AuditRow[] {
  return listAuditLog(db).map((r) => ({
    seq: r.seq,
    actor: r.actor,
    kind: r.kind,
    subject: r.subject,
    data: JSON.parse(r.data) as Record<string, unknown>,
  }));
}

/** その実行（run_id）とそのタスク（task_id）の監査ログの、種類と中身の要点を順に並べる */
export function auditTrail(rows: readonly AuditRow[], taskId: string, runId: string): string[] {
  return rows
    .filter((r) => r.subject === taskId || r.subject === runId)
    .map((r) => {
      switch (r.kind) {
        case "task.state":
          return `task.state ${String(r.data.from)}→${String(r.data.to)}`;
        case "box.lifecycle":
          return `box.lifecycle ${String(r.data.event)}`;
        case "proxy.decision":
          return `proxy.decision ${String(r.data.decision)} ${String(r.data.operation)}`;
        case "gateway.call":
          return `gateway.call ${String(r.data.tool)} ${r.data.ok === true ? "ok" : "ng"}`;
        default:
          return r.kind;
      }
    });
}
