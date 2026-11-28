import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const COMPANY_ID = "c_01JD6V8X3S0Q5W7KQ9M2T4R6YB";

/** 検証の偽物：aicoop.yaml の上書きに `id: <x>` があれば、その会社 ID の設定として通す */
function fakeValidate(overrides: ReadonlyMap<string, string>) {
  const id = /id: (c_\w+)/.exec(overrides.get("aicoop.yaml") ?? "")?.[1] ?? COMPANY_ID;
  return { ok: true, warnings: [], config: { aicoop: { company: { id } } } } as never;
}

function make(reload: () => { ok: true } | { ok: false; issues: [] } = () => ({ ok: true })) {
  const mem = memoryDb();
  clock = mem.clock;
  logs = [];
  settings = createSettings({
    home: dir.path,
    secretsPath: join(dir.path, "secrets.json"),
    db: mem.db,
    logger: pino({ level: "debug", base: null }, { write: (l: string) => void logs.push(l) }),
    now: clock.now,
    companyId: () => COMPANY_ID,
    validate: fakeValidate,
    reload,
  });
}

beforeEach(() => {
  dir = tempDir();
  mkdirSync(join(dir.path, "prompts"), { recursive: true });
  writeFileSync(join(dir.path, "prompts", "company.md"), "# 方針\n");
  writeFileSync(join(dir.path, "aicoop.yaml"), `company:\n  id: ${COMPANY_ID}\n`);
  make();
});

afterEach(() => dir.cleanup());

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("5.14 の4：設定の変更", () => {
  it("6.1・ST-8：company.id を変える変更は、作るときに 422 で拒む（変更を作らない）", () => {
    const before = `company:\n  id: ${COMPANY_ID}\n`;
    const failure = failureOf(() =>
      settings.proposeConfigChange([
        {
          path: "aicoop.yaml",
          content: "company:\n  id: c_01JD6V8X3S0Q5W7KQ9M2T4R6YC\n",
          base_sha256: sha(before),
        },
      ]),
    );
    expect(failure.status).toBe(422);
    expect(failure.code).toBe("config_invalid");
    expect(failure.issues).toEqual([
      expect.objectContaining({ code: "E-013", source: "aicoop.yaml", path: "company.id" }),
    ]);
    expect(readFileSync(join(dir.path, "aicoop.yaml"), "utf8")).toBe(before);
  });

  it("5.14 の4の4：書いたあとの読み直しに失敗したら、書いたファイルを元に戻す（新しいファイルは消す）", () => {
    make(() => ({ ok: false, issues: [] }));
    const change = settings.proposeConfigChange([
      { path: "prompts/company.md", content: "# 新しい方針\n", base_sha256: sha("# 方針\n") },
      { path: "prompts/roles/new.md", content: "# 新しい役職\n", base_sha256: null },
    ]);
    const target = settings.targets().config_change;
    const failure = failureOf(() => target?.apply(change.id, "approve", "owner:d_x"));
    expect(failure.status).toBe(422);
    expect(readFileSync(join(dir.path, "prompts", "company.md"), "utf8")).toBe("# 方針\n");
    expect(existsSync(join(dir.path, "prompts", "roles", "new.md"))).toBe(false);
    // 失敗した変更は捨てる
    expect(target?.describe(change.id)).toBeUndefined();
  });
});

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
