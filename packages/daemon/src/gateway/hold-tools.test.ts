import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ACCESS_REQUESTS_PER_RUN } from "../holds/limits.ts";
import { createHoldTestEnv, type HoldTestEnv } from "../testing/holds.ts";
import { holdTools } from "./hold-tools.ts";

let t: HoldTestEnv;
beforeEach(() => {
  t = createHoldTestEnv();
});
afterEach(() => t.cleanup());

/** 1つの実行の道具（道具ゲートは実行ごとに holdTools を作る） */
function requestAccessOfRun() {
  const tool = holdTools({
    deps: t.deps,
    memberId: "dev-implementer",
    roleId: "implementer",
    active: () => true,
  }).find((x) => x.name === "request_access");
  if (tool === undefined) throw new Error("request_access がありません");
  return (repo: string) =>
    tool.call({
      service: "github",
      operation: "git.push",
      params: { repo: [repo] },
      reason: `${repo} に push するため`,
      duration_hours: 24,
    });
}

describe("9.3 の daily_limit：request_access は、1つの実行で MAX_ACCESS_REQUESTS_PER_RUN 件まで", () => {
  it("同じ実行の4件目は daily_limit。受け付けなかった申請は数えない。次の実行では、また申請できる", async () => {
    const call = requestAccessOfRun();
    // 誤った入力（作らない）は数えない
    expect(await call("other/x")).toMatchObject({ ok: false, code: "outside_ceiling" });
    for (let i = 0; i < MAX_ACCESS_REQUESTS_PER_RUN; i++) {
      expect(await call(`myorg/r${i}`)).toMatchObject({ ok: true });
    }
    const denied = await call("myorg/more");
    expect(denied).toMatchObject({ ok: false, code: "daily_limit" });
    expect(JSON.stringify(denied)).toContain(`${MAX_ACCESS_REQUESTS_PER_RUN} 件まで`);

    expect(await requestAccessOfRun()("myorg/next-run")).toMatchObject({ ok: true });
  });
});
