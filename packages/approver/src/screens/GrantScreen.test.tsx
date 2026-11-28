import type { ApprovalPayload, GrantView } from "@aicoop/shared/api";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { canonicalJson, sha256Base64Url, sha256Hex } from "../lib/canonical.ts";
import { createFakeApi, ok } from "../testing/fake-api.ts";
import { COMPANY_ID, grantView, iso, MIN, NOW, PUSH_GRANT } from "../testing/fixtures.ts";
import { renderApp } from "../testing/render.tsx";
import { installFakeWebAuthn } from "../testing/webauthn.ts";

const BASE = { "GET /holds": ok({ holds: [] }) };

function setup(grants: GrantView[] = [PUSH_GRANT], summarySha?: string) {
  const webauthn = installFakeWebAuthn();
  const api = createFakeApi({ ...BASE, "GET /grants": ok({ grants }) });
  api.on("POST /approvals/intent", async (req) => {
    const body = req.body as { type: "grant"; id: string; decision: "approve" | "reject" };
    const grant = grants.find((g) => g.id === body.id);
    const payload: ApprovalPayload = {
      ...body,
      company_id: COMPANY_ID,
      summary_sha256: summarySha ?? (await sha256Hex(canonicalJson(grant?.summary))),
      issued_at: iso(NOW),
      expires_at: iso(NOW + 2 * MIN),
      nonce: "bm9uY2U",
    };
    return ok({
      payload,
      options: {
        challenge: await sha256Base64Url(canonicalJson(payload)),
        allowCredentials: [{ id: "Y3JlZC0x", type: "public-key" }],
        userVerification: "required",
      },
    });
  });
  renderApp({ api, hash: `#/pending/grant/${PUSH_GRANT.id}` });
  return { api, webauthn };
}

describe("5.8 の4 (2) 一時権限の申請の詳細（5.7.3 の2：誰が・何の操作を・どのパラメーターで・何時間・理由）", () => {
  test("要約（署名の対象）を出す。理由と部長のコメントは外から来た文章として囲む", async () => {
    setup();
    expect(await screen.findByRole("heading", { level: 2, name: "要約：一時権限" })).toBeTruthy();
    expect(screen.getByText("dev-implementer")).toBeTruthy();
    expect(screen.getAllByText("github.git.push").length).toBeGreaterThan(0);
    expect(screen.getByText("repo=myorg/new")).toBeTruthy();
    expect(screen.getByText("24時間")).toBeTruthy();
    expect(screen.getByText("承認なしで、そのまま通る（allow）")).toBeTruthy();
    expect(screen.getByRole("region", { name: "外から来た文章：理由" }).textContent).toContain(
      "初めの版を push したい",
    );
    expect(
      screen.getByRole("region", { name: "外から来た文章：部長のコメント" }).textContent,
    ).toContain("必要な権限です");
  });

  test("パラメーターの制限がない申請は、すべてに効くと目立たせる", async () => {
    setup([grantView({ params: {} })]);
    expect(await screen.findByText(/制限がありません。この操作のすべてに効きます/)).toBeTruthy();
    expect(screen.getByText("⚠ 制限なし（この操作のすべてに効く）")).toBeTruthy();
  });

  test("承認：確かめの窓 → パスキーで署名（type は grant）→ 結果", async () => {
    const { api, webauthn } = setup();
    api.on(
      "POST /approvals/assert",
      ok({
        approval: {
          id: "a_01JQ0000000000000000000002",
          subject_type: "grant",
          subject_id: PUSH_GRANT.id,
          decision: "approve",
          device_id: "d_01JQ0000000000000000000001",
          verified_at: iso(NOW),
        },
        subject_status: "active",
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: /承認する…/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "この一時権限を承認しますか？" });
    expect(dialog.textContent).toContain("24時間");
    expect(dialog.textContent).toContain("repo=myorg/new");
    fireEvent.click(within(dialog).getByRole("button", { name: /パスキーで署名して承認する/ }));
    expect(await screen.findByText("承認しました。")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("有効");
    expect(api.calls.find((c) => c.path === "/approvals/intent")?.body).toEqual({
      type: "grant",
      id: PUSH_GRANT.id,
      decision: "approve",
    });
    expect(webauthn.getCalls).toHaveLength(1);
  });

  test("拒否側：payload の summary_sha256 が、表示している要約と違えば署名しない", async () => {
    const { api, webauthn } = setup([PUSH_GRANT], "0".repeat(64));
    fireEvent.click(await screen.findByRole("button", { name: /承認する…/ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: /パスキーで署名して承認する/,
      }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "いま画面に表示している要約と一致しません",
    );
    expect(webauthn.getCalls).toHaveLength(0);
    expect(api.count("POST /approvals/assert")).toBe(0);
  });

  test("拒否側：要約のない申請は、承認も却下もできない", async () => {
    setup([{ ...PUSH_GRANT, summary: null }]);
    expect(await screen.findByText(/承認アプリに見せる要約がありません/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /承認する…/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole("button", { name: /却下する…/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("決まったものは、承認も却下もできない", async () => {
    setup([
      grantView({
        status: "active",
        starts_at: iso(NOW - MIN),
        expires_at: iso(NOW + 23 * 60 * MIN),
      }),
    ]);
    expect(await screen.findByText(/有効/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /承認する…/ })).toBeNull();
  });

  test("見つからない申請", async () => {
    setup([]);
    expect(await screen.findByText(/その一時権限の申請は見つかりません/)).toBeTruthy();
  });
});
