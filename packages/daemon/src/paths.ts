/**
 * `~/.aicoop/` の中の置き場所（6.1、5.1.7）。
 *
 * パスはすべてここで作る。ID からパスを作るときは、ID の形を確かめてから作る
 * （`../` を含む値でホームの外に出ないように）。
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome, ID_PATTERN, isId } from "@aicoop/shared";

/** `AICOOP_HOME` があればそれ、なければ `~/.aicoop` */
export function resolveAicoopHome(
  env: Readonly<Record<string, string | undefined>> = process.env,
  userHome: string = homedir(),
): string {
  const fromEnv = env.AICOOP_HOME?.trim();
  if (fromEnv) return resolve(expandHome(fromEnv, userHome));
  return join(userHome, ".aicoop");
}

export interface AicoopPaths {
  readonly home: string;
  readonly stateDb: string;
  readonly secrets: string;
  readonly servicesDir: string;
  readonly promptsDir: string;
  readonly skillsDir: string;
  readonly dataDir: string;
  readonly runtimeDir: string;
  readonly logsDir: string;
  readonly runLogsDir: string;
  readonly holdsDir: string;
  /** `aicoop image build` で作るイメージ（box-gondolin の imageDir と同じ場所） */
  readonly imagesDir: string;
  /** CLI が使うローカルAPIのトークン（9.2。daemon の起動ごとに作り直す。0600） */
  readonly apiToken: string;
  /** 動いている daemon の pid・ポート・起動時刻 */
  readonly daemonInfo: string;
  /** daemon のログ（11.5。日ごとのファイルはこのフォルダに置く） */
  readonly daemonLogDir: string;
  groupWork(groupId: string): string;
  memberHome(memberId: string): string;
  runDir(runId: string): string;
  runEtc(runId: string): string;
  runSkills(runId: string): string;
  runManaged(runId: string): string;
  runLog(runId: string): string;
  holdFile(holdId: string): string;
  /** 再送の結果の本文（先頭 1 MiB。5.2.6 の3） */
  holdResponseFile(holdId: string): string;
}

function requireName(value: string, what: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new TypeError(`${what}として使えない値です（英小文字・数字・ハイフンで1〜40文字）`);
  }
  return value;
}

function requireId(value: string, kind: "run" | "hold"): string {
  if (!isId(value, kind)) {
    throw new TypeError(`${kind === "run" ? "実行" : "保留"}の ID として使えない値です`);
  }
  return value;
}

export function aicoopPaths(home: string): AicoopPaths {
  const runtimeDir = join(home, "runtime");
  const logsDir = join(home, "logs");
  const runLogsDir = join(logsDir, "runs");
  const holdsDir = join(home, "state", "holds");
  const runDir = (runId: string) => join(runtimeDir, requireId(runId, "run"));

  return {
    home,
    stateDb: join(home, "state.db"),
    secrets: join(home, "secrets.json"),
    servicesDir: join(home, "services"),
    promptsDir: join(home, "prompts"),
    skillsDir: join(home, "skills"),
    dataDir: join(home, "data"),
    runtimeDir,
    logsDir,
    runLogsDir,
    holdsDir,
    imagesDir: join(home, "images"),
    apiToken: join(runtimeDir, "api_token"),
    daemonInfo: join(runtimeDir, "daemon.json"),
    daemonLogDir: logsDir,
    groupWork: (g) => join(home, "data", "groups", requireName(g, "部署ID"), "work"),
    memberHome: (m) => join(home, "data", "members", requireName(m, "社員ID"), "home"),
    runDir,
    runEtc: (r) => join(runDir(r), "etc"),
    runSkills: (r) => join(runDir(r), "skills"),
    runManaged: (r) => join(runDir(r), "managed"),
    runLog: (r) => join(runLogsDir, `${requireId(r, "run")}.jsonl`),
    holdFile: (h) => join(holdsDir, `${requireId(h, "hold")}.bin`),
    holdResponseFile: (h) => join(holdsDir, `${requireId(h, "hold")}.response.bin`),
  };
}
