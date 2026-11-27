import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listSecrets,
  readSecret,
  removeSecret,
  SecretStoreError,
  setSecret,
  validateSecretValue,
} from "./store.ts";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aicoop-secrets-"));
  file = join(dir, "secrets.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date("2026-11-28T00:00:00.000Z");

describe("5.2.8：資格保管庫", () => {
  it("登録した資格を読める。一覧は ID と種類だけ", () => {
    setSecret(file, "github", "static_token", { token: "ghp_REALTOKEN" }, NOW);
    setSecret(file, "anthropic", "anthropic_oauth", { token: "sk-ant-oat-REAL" }, NOW);

    expect(readSecret(file, "github")).toEqual({
      id: "github",
      kind: "static_token",
      value: { token: "ghp_REALTOKEN" },
      updatedAt: NOW.toISOString(),
    });
    const list = listSecrets(file);
    expect(list).toEqual([
      { id: "anthropic", kind: "anthropic_oauth", updatedAt: NOW.toISOString() },
      { id: "github", kind: "static_token", updatedAt: NOW.toISOString() },
    ]);
    expect(JSON.stringify(list)).not.toContain("REAL");
  });

  it("同じ ID に登録し直すと、丸ごと置き換わる", () => {
    setSecret(file, "github", "static_token", { token: "old" }, NOW);
    setSecret(file, "github", "static_token", { token: "new" }, NOW);
    expect(readSecret(file, "github")?.value).toEqual({ token: "new" });
  });

  it("ファイルが無ければ、一覧は空で、読むと undefined", () => {
    expect(listSecrets(file)).toEqual([]);
    expect(readSecret(file, "github")).toBeUndefined();
  });

  it("消すと読めなくなる。無いものを消すと false", () => {
    setSecret(file, "github", "static_token", { token: "t" }, NOW);
    expect(removeSecret(file, "github")).toBe(true);
    expect(readSecret(file, "github")).toBeUndefined();
    expect(removeSecret(file, "github")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("E-008：ファイルの権限は 0600 で作る", () => {
    setSecret(file, "github", "static_token", { token: "t" }, NOW);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("書き込みの途中で失敗しても、前の中身が残る（一時ファイルから入れ替える）", () => {
    setSecret(file, "github", "static_token", { token: "keep" }, NOW);
    expect(() => setSecret(file, "Bad ID", "static_token", { token: "x" }, NOW)).toThrow(
      SecretStoreError,
    );
    expect(readSecret(file, "github")?.value).toEqual({ token: "keep" });
  });
});

describe("5.2.8 の4：種類ごとの中身の形", () => {
  it("種類ごとに要るキーがそろっていれば通る", () => {
    expect(validateSecretValue("static_token", { token: "x" })).toEqual({ token: "x" });
    expect(
      validateSecretValue("github_app", {
        app_id: 123,
        installation_id: "456",
        private_key: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n",
      }),
    ).toMatchObject({ app_id: 123, installation_id: "456" });
    expect(
      validateSecretValue("google_oauth", {
        client_id: "id",
        client_secret: "s",
        refresh_token: "r",
      }),
    ).toMatchObject({ client_id: "id" });
    expect(validateSecretValue("anthropic_oauth", { token: "sk-ant-oat01-x" })).toEqual({
      token: "sk-ant-oat01-x",
    });
  });

  it("キーが足りない・空・知らないキーがあると拒否する", () => {
    expect(() => validateSecretValue("static_token", {})).toThrow(SecretStoreError);
    expect(() => validateSecretValue("static_token", { token: "" })).toThrow(SecretStoreError);
    expect(() => validateSecretValue("static_token", { token: "x", extra: 1 })).toThrow(
      SecretStoreError,
    );
    expect(() => validateSecretValue("github_app", { app_id: 1, installation_id: 2 })).toThrow(
      SecretStoreError,
    );
    expect(() => validateSecretValue("google_oauth", "just-a-string")).toThrow(SecretStoreError);
  });

  it("github_app の private_key は PEM の形でなければ拒否する", () => {
    expect(() =>
      validateSecretValue("github_app", { app_id: 1, installation_id: 2, private_key: "abc" }),
    ).toThrow(SecretStoreError);
  });

  it("11.5：誤りのメッセージに資格の中身を出さない", () => {
    const secret = "ghp_THIS_MUST_NOT_LEAK";
    for (const value of [{ token: secret, extra: secret }, { tokn: secret }, secret, [secret]]) {
      try {
        validateSecretValue("static_token", value);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(SecretStoreError);
        expect(String((e as Error).message)).not.toContain("THIS_MUST_NOT_LEAK");
      }
    }
  });

  it("資格の ID は英小文字・数字・ハイフン（先頭はハイフン不可、1〜40文字）", () => {
    for (const id of ["", "-x", "Github", "a_b", "a/b", "../x", "x".repeat(41)]) {
      expect(() => setSecret(file, id, "static_token", { token: "t" }, NOW)).toThrow(
        SecretStoreError,
      );
    }
  });
});

describe("壊れた secrets.json", () => {
  it("JSON として読めなければ、中身を出さずにエラーにする", () => {
    writeFileSync(
      file,
      '{"version":1,"secrets":{"github":{"kind":"static_token","value":{"token":"LEAK',
    );
    try {
      listSecrets(file);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SecretStoreError);
      expect(String((e as Error).message)).not.toContain("LEAK");
    }
  });

  it("形が違えば、中身を出さずにエラーにする", () => {
    writeFileSync(
      file,
      JSON.stringify({ version: 1, secrets: { github: { kind: "nope", value: "LEAK" } } }),
    );
    expect(() => readSecret(file, "github")).toThrow(SecretStoreError);
    try {
      readSecret(file, "github");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("LEAK");
    }
  });

  it("登録しても、ほかの資格は残る", () => {
    setSecret(file, "a", "static_token", { token: "1" }, NOW);
    setSecret(file, "b", "static_token", { token: "2" }, NOW);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(raw.secrets).sort()).toEqual(["a", "b"]);
  });
});
