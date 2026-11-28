import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalFailure } from "../approvals/errors.ts";
import { type FakeClock, memoryDb, type TempDir, tempDir } from "../testing/state-db.ts";
import { createSettings, MAX_PENDING_CHANGES, type Settings } from "./service.ts";

const TOKEN = "ghp_SERVICE_TEST_TOKEN_0123456789abcdef";

let dir: TempDir;
let settings: Settings;
let clock: FakeClock;
let logs: string[];

function failureOf(fn: () => unknown): ApprovalFailure {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApprovalFailure) return e;
    throw e;
  }
  throw new Error("失敗しませんでした");
}

beforeEach(() => {
  dir = tempDir();
  mkdirSync(join(dir.path, "prompts"), { recursive: true });
  writeFileSync(join(dir.path, "prompts", "company.md"), "# 方針\n");
  const mem = memoryDb();
  clock = mem.clock;
  logs = [];
  settings = createSettings({
    home: dir.path,
    secretsPath: join(dir.path, "secrets.json"),
    db: mem.db,
    logger: pino({ level: "debug", base: null }, { write: (l: string) => void logs.push(l) }),
    now: clock.now,
    validate: () => ({ ok: true, warnings: [] }) as never,
    reload: () => ({ ok: true }),
  });
});

afterEach(() => dir.cleanup());

describe("5.14 の4・5：署名を待つ変更", () => {
  it(`同時に置けるのは ${MAX_PENDING_CHANGES} 件まで（期限を過ぎたものは数えない）`, () => {
    for (let i = 0; i < MAX_PENDING_CHANGES; i++) {
      settings.proposeSecretChange({ id: `s${i}`, kind: "static_token", value: TOKEN });
    }
    const full = failureOf(() =>
      settings.proposeSecretChange({ id: "over", kind: "static_token", value: TOKEN }),
    );
    expect(full.status).toBe(409);
    clock.advance(10 * 60 * 1000 + 1);
    expect(
      settings.proposeSecretChange({ id: "later", kind: "static_token", value: TOKEN }).id,
    ).toMatch(/^x_/);
  });

  it("10分で失効し、承認を待たなくなる", () => {
    const change = settings.proposeSecretChange({
      id: "github",
      kind: "static_token",
      value: TOKEN,
    });
    const target = settings.targets().secret_change;
    expect(target?.describe(change.id)?.awaitingOwner).toBe(true);
    clock.advance(10 * 60 * 1000 + 1);
    expect(target?.describe(change.id)?.awaitingOwner).toBe(false);
    expect(() => target?.apply(change.id, "approve", "owner:d_x")).toThrow();
  });

  it("ほかの種類の対象としては見えない（config_change の ID で secret_change を引けない）", () => {
    const change = settings.proposeSecretChange({
      id: "github",
      kind: "static_token",
      value: TOKEN,
    });
    expect(settings.targets().config_change?.describe(change.id)).toBeUndefined();
  });

  it("5.14 の受け入れ条件：資格の値は、応答・要約・ログに出さない", () => {
    const change = settings.proposeSecretChange({
      id: "github",
      kind: "static_token",
      value: TOKEN,
    });
    expect(JSON.stringify(change)).not.toContain(TOKEN);
    expect(JSON.stringify(settings.targets().secret_change?.describe(change.id))).not.toContain(
      TOKEN,
    );
    expect(logs.join("\n")).not.toContain(TOKEN);
    const bad = failureOf(() =>
      settings.createSecretChange({ id: "github", kind: "github_app", value: TOKEN }),
    );
    expect(bad.message).not.toContain(TOKEN);
    const unknownKey = failureOf(() =>
      settings.createSecretChange({ id: "github", kind: "static_token", value: {}, [TOKEN]: 1 }),
    );
    expect(unknownKey.message).not.toContain(TOKEN);
  });
});
