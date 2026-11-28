import type { ApprovalPayload } from "@aicoop/shared/api";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { canonicalJson, sha256Base64Url } from "../lib/canonical.ts";
import { createFakeApi, ok } from "../testing/fake-api.ts";
import { COMPANY_ID, iso, MIN, NOW, PUSH_GRANT } from "../testing/fixtures.ts";
import { renderApp } from "../testing/render.tsx";
import { installFakeWebAuthn } from "../testing/webauthn.ts";

const BASE = { "GET /holds": ok({ holds: [] }) };

function setup(grants = [PUSH_GRANT]) {
  const webauthn = installFakeWebAuthn();
  const api = createFakeApi({ ...BASE, "GET /grants": ok({ grants }) });
  api.on("POST /approvals/intent", async (req) => {
    const body = req.body as { type: "grant"; id: string; decision: "approve" | "reject" };
    const payload: ApprovalPayload = {
      ...body,
      company_id: COMPANY_ID,
      summary_sha256: "f".repeat(64),
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

describe("5.8 の4 (2) 一時権限の申請の詳細（5.7.3：誰が・何の操作を・どのパラメーターで・何時間・理由）", () => {
  test("申請の中身を出す。理由は AI 社員が書いた文章として囲む", async () => {
    setup();
    expect(await screen.findByRole("heading", { level: 1, name: /一時権限の申請/ })).toBeTruthy();
    expect(await screen.findByText("dev-implementer")).toBeTruthy();
    expect(screen.getAllByText("github.git.push").length).toBeGreaterThan(0);
    expect(screen.getByText("repo")).toBeTruthy();
    expect(screen.getByText("myorg/new")).toBeTruthy();
    expect(screen.getByText("24時間")).toBeTruthy();
    expect(screen.getByText(/許可（承認なしで、そのまま通る）/)).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "外から来た文章：申請の理由" }).textContent,
    ).toContain("初めの版を push したい");
  });

  test("パラメーターの制限がない申請は、すべてに効くと目立たせる", async () => {
    setup([{ ...PUSH_GRANT, params: {} }]);
    expect(await screen.findByText(/制限がありません。この操作のすべてに効きます/)).toBeTruthy();
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

  test("部長のレビュー待ち・決まったものは、承認も却下もできない", async () => {
    setup([
      {
        ...PUSH_GRANT,
        status: "active",
        starts_at: iso(NOW - MIN),
        expires_at: iso(NOW + 23 * 60 * MIN),
      },
    ]);
    expect(await screen.findByText(/有効/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /承認する…/ })).toBeNull();
  });

  test("見つからない申請", async () => {
    setup([]);
    expect(await screen.findByText(/その一時権限の申請は見つかりません/)).toBeTruthy();
  });
});
