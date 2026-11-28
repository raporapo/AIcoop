import type { ApprovalPayload, HoldDetailView } from "@aicoop/shared/api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { canonicalJson, sha256Base64Url, sha256Hex } from "../lib/canonical.ts";
import { createFakeApi, type FakeApi, type FakeRequest, fail, ok } from "../testing/fake-api.ts";
import { COMPANY_ID, iso, MAIL_HOLD, MERGE_HOLD, MIN, NOW } from "../testing/fixtures.ts";
import { renderApp } from "../testing/render.tsx";
import { type FakeWebAuthn, installFakeWebAuthn } from "../testing/webauthn.ts";

const BASE = { "GET /holds": ok({ holds: [] }), "GET /grants": ok({ grants: [] }) };

/** daemon の /approvals/intent の偽物：payload を作り、チャレンジ = 正規化JSON の SHA-256 */
async function makeIntent(
  req: FakeRequest,
  hold: HoldDetailView,
  tamper: (p: ApprovalPayload) => ApprovalPayload = (p) => p,
  challengeOf?: (p: ApprovalPayload) => Promise<string>,
) {
  const body = req.body as { type: "hold"; id: string; decision: "approve" | "reject" };
  const payload: ApprovalPayload = tamper({
    type: body.type,
    id: body.id,
    decision: body.decision,
    company_id: COMPANY_ID,
    summary_sha256: await sha256Hex(canonicalJson(hold.summary)),
    issued_at: iso(NOW),
    expires_at: iso(NOW + 2 * MIN),
    nonce: `nonce-${Math.random().toString(36).slice(2)}`,
  });
  const challenge = await (challengeOf ?? ((p) => sha256Base64Url(canonicalJson(p))))(payload);
  return ok({
    payload,
    options: {
      challenge,
      rpId: "localhost",
      allowCredentials: [{ id: "Y3JlZC0x", type: "public-key" }],
      userVerification: "required",
      timeout: 120_000,
    },
  });
}

function approvalOk(decision: "approve" | "reject", status: string) {
  return ok({
    approval: {
      id: "a_01JQ0000000000000000000001",
      subject_type: "hold",
      subject_id: MAIL_HOLD.id,
      decision,
      device_id: "d_01JQ0000000000000000000001",
      verified_at: iso(NOW),
    },
    subject_status: status,
  });
}

function setup(hold: HoldDetailView = MAIL_HOLD): { api: FakeApi; webauthn: FakeWebAuthn } {
  const webauthn = installFakeWebAuthn();
  const api = createFakeApi({ ...BASE, [`GET /holds/${hold.id}`]: ok({ hold }) });
  api.on("POST /approvals/intent", (req) => makeIntent(req, hold));
  renderApp({ api, hash: `#/pending/hold/${hold.id}` });
  return { api, webauthn };
}

async function openRequest() {
  const summary = await screen.findByText(/元のリクエストを開く/);
  fireEvent.click(summary);
  const details = summary.closest("details") as HTMLDetailsElement;
  if (!details.open) {
    details.open = true;
    fireEvent(details, new Event("toggle"));
  }
}

async function approveButton(): Promise<HTMLButtonElement> {
  return (await screen.findByRole("button", { name: /承認する…/ })) as HTMLButtonElement;
}

async function confirm(name: RegExp) {
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name }));
}

describe("5.8 の4 (2) 承認待ちの詳細：要約・部長のコメント・元のリクエスト全体", () => {
  test("メールの要約：宛先（To・Cc・Bcc）・件名・本文。件名・本文・部長のコメントは外から来た文章として囲む", async () => {
    setup();
    expect(await screen.findByRole("heading", { level: 1, name: /メールの送信/ })).toBeTruthy();
    expect(screen.getByText("client@example.com")).toBeTruthy();
    expect(screen.getByText("boss@example.org")).toBeTruthy();
    const subject = screen.getByRole("region", { name: "外から来た文章：件名" });
    expect(subject.textContent).toContain("お見積りの件");
    expect(subject.textContent).toContain("AI への指示が仕込まれているかもしれません");
    expect(screen.getByRole("region", { name: "外から来た文章：本文" }).textContent).toContain(
      "お見積りをお送りします",
    );
    expect(
      screen.getByRole("region", { name: "外から来た文章：部長のコメント" }).textContent,
    ).toContain("問題ありません");
    expect(screen.getByText("sales-writer")).toBeTruthy();
    expect(screen.getByRole("link", { name: MAIL_HOLD.task_id }).getAttribute("href")).toBe(
      `#/tasks/${MAIL_HOLD.task_id}`,
    );
  });

  test("向きを変える文字・見えない文字は、印にして、入っていることを言う", async () => {
    setup({
      ...MAIL_HOLD,
      summary: { ...(MAIL_HOLD.summary as object), subject: "請求書\u{202E}fdp.exe\u{200B}" },
    });
    const subject = await screen.findByRole("region", { name: "外から来た文章：件名" });
    expect(subject.textContent).toContain(
      "請求書[U+202E]（向きを変える文字）fdp.exe[U+200B]（見えない文字）",
    );
    expect(subject.textContent).not.toContain("\u{202E}");
    expect(subject.textContent).toContain("見えない文字・向きを変える文字が 2 個入っています");
    expect(subject.textContent).toContain("向きを変える文字は、表示の順番を入れ替えて");
  });

  test("10.2：送信系は、元のリクエスト全体を開くまで「承認する」を押せない。開くとヘッダー・本文・メールの中身が見える", async () => {
    setup();
    const approve = await approveButton();
    expect(approve.disabled).toBe(true);
    expect(screen.getAllByText(/開くまで「承認する」は押せません/).length).toBeGreaterThan(0);
    // 却下は、開かなくても押せる
    expect((screen.getByRole("button", { name: /却下する…/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    await openRequest();
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(
      screen.getByText("https://gmail.googleapis.com/gmail/v1/users/me/messages/send"),
    ).toBeTruthy();
    expect(screen.getByText("content-type")).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "外から来た文章：リクエストの本文" }).textContent,
    ).toContain('{"raw":"');
    const mail = screen.getByRole("region", { name: /外から来た文章：メールの中身/ });
    expect(mail.textContent).toContain("Bcc: boss@example.org");
    expect(mail.textContent).toContain("お見積りをお送りします");
  });

  test("PR のマージは、開くのを促すだけ（開かなくても承認できる）", async () => {
    setup(MERGE_HOLD);
    expect((await approveButton()).disabled).toBe(false);
    expect(screen.getByText(/開いて確かめることをすすめます/)).toBeTruthy();
    expect(screen.getByText("#12")).toBeTruthy();
    expect(screen.getByRole("region", { name: "外から来た文章：タイトル" }).textContent).toContain(
      "README の誤字を直す",
    );
  });

  test("部長のレビュー待ちの保留は、承認も却下もできない", async () => {
    setup({ ...MAIL_HOLD, status: "pending_manager", decided_by: null });
    expect(await screen.findByText(/部長のレビュー待ちです/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /承認する…/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /却下する…/ })).toBeNull();
  });

  test("期限の過ぎた保留は、承認も却下もできない", async () => {
    setup({ ...MAIL_HOLD, expires_at: iso(NOW - MIN) });
    expect((await approveButton()).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /却下する…/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText(/期限が過ぎています/)).toBeTruthy();
  });

  test("決まった保留は、結果（再送のステータスと応答）を見せる。応答は外から来た文章として囲む", async () => {
    setup({
      ...MAIL_HOLD,
      status: "replayed",
      decided_at: iso(NOW - 5 * MIN),
      decided_by: "owner:d_01JQ0000000000000000000001",
      response_status: 200,
      response_text: '{"id":"18c0","labelIds":["SENT"]}',
    });
    expect((await screen.findAllByText(/送信済み/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/HTTP 200（成功）/)).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "外から来た文章：再送の応答の本文" }).textContent,
    ).toContain("SENT");
    expect(screen.queryByRole("button", { name: /承認する…/ })).toBeNull();
  });
});

describe("5.8 の3 承認の署名：/approvals/intent → navigator.credentials.get → /approvals/assert", () => {
  test("承認：確かめの窓（はじめのフォーカスは「やめる」）→ 署名 → 結果。チャレンジは payload の正規化JSON の SHA-256", async () => {
    const { api, webauthn } = setup();
    api.on("POST /approvals/assert", () => {
      api.on(`GET /holds/${MAIL_HOLD.id}`, ok({ hold: { ...MAIL_HOLD, status: "approved" } }));
      return approvalOk("approve", "approved");
    });
    await openRequest();
    fireEvent.click(await approveButton());
    const dialog = await screen.findByRole("alertdialog", {
      name: "このメールの送信を承認しますか？",
    });
    expect(document.activeElement?.textContent).toBe("やめる");
    expect(dialog.textContent).toContain("1回だけ送ります");
    expect(dialog.textContent).toContain("取り消せません");
    expect(dialog.textContent).toContain("宛先 client@example.com・件名「お見積りの件」");
    await confirm(/パスキーで署名して承認する/);

    expect(await screen.findByText("承認しました。")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("承認済み（送るところ）");

    const routes = api.routes().filter((r) => r.startsWith("POST"));
    expect(routes).toEqual(["POST /approvals/intent", "POST /approvals/assert"]);
    const intent = api.calls.find((c) => c.path === "/approvals/intent");
    expect(intent?.body).toEqual({ type: "hold", id: MAIL_HOLD.id, decision: "approve" });
    const assert = api.calls.find((c) => c.path === "/approvals/assert");
    const { payload, response } = (assert?.body ?? {}) as {
      payload: ApprovalPayload;
      response: { id: string };
    };
    expect(payload.id).toBe(MAIL_HOLD.id);
    expect(response.id).toBe("cred-1");
    expect(webauthn.getCalls).toHaveLength(1);
    expect(webauthn.getCalls[0]?.challenge).toBe(await sha256Base64Url(canonicalJson(payload)));
    expect(webauthn.getCalls[0]?.allowCredentials).toEqual(["Y3JlZC0x"]);
    expect(webauthn.getCalls[0]?.userVerification).toBe("required");
    // 決まったあと、状態を読み直す
    expect(api.count(`GET /holds/${MAIL_HOLD.id}`)).toBeGreaterThanOrEqual(2);
  });

  test("却下も、確かめの窓とパスキーの署名を挟む", async () => {
    const { api, webauthn } = setup();
    api.on("POST /approvals/assert", approvalOk("reject", "rejected"));
    fireEvent.click(await screen.findByRole("button", { name: /却下する…/ }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "このメールの送信を却下しますか？",
    });
    expect(dialog.textContent).toContain("送られません");
    await confirm(/パスキーで署名して却下する/);
    expect(await screen.findByText("却下しました。")).toBeTruthy();
    expect(api.calls.find((c) => c.path === "/approvals/intent")?.body).toEqual({
      type: "hold",
      id: MAIL_HOLD.id,
      decision: "reject",
    });
    expect(webauthn.getCalls).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("却下");
  });

  test("「やめる」・Esc では何も送らない", async () => {
    const { api } = setup(MERGE_HOLD);
    fireEvent.click(await approveButton());
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "やめる" }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(await approveButton());
    fireEvent.keyDown(await screen.findByRole("alertdialog"), { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.count("POST /approvals/intent")).toBe(0);
  });

  test("署名の期限（2分）が切れた：理由を言い、もう一度やり直せる", async () => {
    const { api, webauthn } = setup(MERGE_HOLD);
    let n = 0;
    api.on("POST /approvals/assert", () => {
      n++;
      return n === 1
        ? fail(409, "approval_expired", "署名の期限が切れています")
        : approvalOk("approve", "approved");
    });
    fireEvent.click(await approveButton());
    await confirm(/パスキーで署名して承認する/);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("署名の期限が切れています");
    expect(alert.textContent).toContain("署名の期限（2分）が切れました。決定は効いていません");

    fireEvent.click(within(alert).getByRole("button", { name: "もう一度やり直す…" }));
    await confirm(/パスキーで署名して承認する/);
    expect(await screen.findByText("承認しました。")).toBeTruthy();
    expect(api.count("POST /approvals/intent")).toBe(2);
    expect(webauthn.getCalls).toHaveLength(2);
    // 2回目は別の payload（nonce）に署名している
    expect(webauthn.getCalls[0]?.challenge).not.toBe(webauthn.getCalls[1]?.challenge);
  });

  test("使い回し（一度使った nonce）：二度は使えないと言う", async () => {
    const { api } = setup(MERGE_HOLD);
    api.on("POST /approvals/assert", fail(409, "nonce_used", "この署名は使われています"));
    fireEvent.click(await approveButton());
    await confirm(/パスキーで署名して承認する/);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("この署名は使われています");
    expect(alert.textContent).toContain("二度は使えません");
    expect(within(alert).getByRole("button", { name: "もう一度やり直す…" })).toBeTruthy();
  });

  test("もう待っていない（ほかで決まった・期限切れ）：やり直しは出さず、状態を読み直す", async () => {
    const { api } = setup(MERGE_HOLD);
    api.on("POST /approvals/intent", () => {
      api.on(`GET /holds/${MERGE_HOLD.id}`, ok({ hold: { ...MERGE_HOLD, status: "expired" } }));
      return fail(409, "not_pending", "この保留は、もう承認を待っていません");
    });
    fireEvent.click(await approveButton());
    await confirm(/パスキーで署名して承認する/);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("この保留は、もう承認を待っていません");
    expect(alert.textContent).toContain("もうあなたの承認を待っていません");
    expect(within(alert).queryByRole("button", { name: "もう一度やり直す…" })).toBeNull();
    expect((await screen.findAllByText(/期限切れ（却下と同じ）/)).length).toBeGreaterThan(0);
  });

  test("拒否側：payload の対象が選んだものと違えば、署名しない（パスキーを呼ばない）", async () => {
    const { api, webauthn } = setup(MERGE_HOLD);
    api.on("POST /approvals/intent", (req) =>
      makeIntent(req, MERGE_HOLD, (p) => ({ ...p, id: "h_01JQ0000000000000000000099" })),
    );
    fireEvent.click(await approveButton());
    await confirm(/パスキーで署名して承認する/);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "選んだもの（対象・決定）と違います",
    );
    expect(webauthn.getCalls).toHaveLength(0);
    expect(api.count("POST /approvals/assert")).toBe(0);
  });

  test("拒否側：決定が書き換えられた payload（却下を選んだのに承認）にも署名しない", async () => {
    const { api, webauthn } = setup(MERGE_HOLD);
    api.on("POST /approvals/intent", (req) =>
      makeIntent(req, MERGE_HOLD, (p) => ({ ...p, decision: "approve" })),
    );
    fireEvent.click(await screen.findByRole("button", { name: /却下する…/ }));
    await confirm(/パスキーで署名して却下する/);
    expect((await screen.findByRole("alert")).textContent).toContain("違います");
    expect(webauthn.getCalls).toHaveLength(0);
  });

  test("拒否側：チャレンジが payload から作ったものでなければ、署名しない", async () => {
    const { api, webauthn } = setup(MERGE_HOLD);
    api.on("POST /approvals/intent", (req) =>
      makeIntent(
        req,
        MERGE_HOLD,
        undefined,
        async () => "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ),
    );
    fireEvent.click(await approveButton());
    await confirm(/パスキーで署名して承認する/);
    expect((await screen.findByRole("alert")).textContent).toContain("チャレンジが");
    expect(webauthn.getCalls).toHaveLength(0);
    expect(api.count("POST /approvals/assert")).toBe(0);
  });

  test("拒否側：payload の summary_sha256 が、表示している要約と違えば、署名しない", async () => {
    const { api, webauthn } = setup(MERGE_HOLD);
    api.on("POST /approvals/intent", (req) =>
      makeIntent(req, MERGE_HOLD, (p) => ({ ...p, summary_sha256: "0".repeat(64) })),
    );
    fireEvent.click(await approveButton());
    await confirm(/パスキーで署名して承認する/);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "いま画面に表示している要約と一致しません",
    );
    expect(webauthn.getCalls).toHaveLength(0);
  });

  test("パスキーの操作を取り消したら、送らない（決定は効いていない）", async () => {
    const { api, webauthn } = setup(MERGE_HOLD);
    webauthn.failNextGet("NotAllowedError");
    fireEvent.click(await approveButton());
    await confirm(/パスキーで署名して承認する/);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("パスキーの操作が取り消されました");
    expect(alert.textContent).toContain("決定は効いていません");
    expect(api.count("POST /approvals/assert")).toBe(0);
  });

  test("5.8 の6：届かないときは、承認できない（押せなくなる）", async () => {
    const { api } = setup(MERGE_HOLD);
    fireEvent.click(await approveButton());
    api.offline = true;
    await confirm(/パスキーで署名して承認する/);
    expect(await screen.findByText(/決定は効いていません。届くようになったら/)).toBeTruthy();
    expect(await screen.findByText("制御サーバーに届いていません。")).toBeTruthy();
    expect((await approveButton()).disabled).toBe(true);
    expect(screen.getByText(/届いていないので、承認・却下はできません/)).toBeTruthy();
  });

  test("署名を送ったあとに制御サーバーでエラー：決定が効いたか分からないと言い、読み直す", async () => {
    const { api } = setup(MERGE_HOLD);
    api.on("POST /approvals/assert", fail(500, "internal", "制御サーバーの中でエラーが起きました"));
    fireEvent.click(await approveButton());
    await confirm(/パスキーで署名して承認する/);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("決定が効いたかどうか分かりません");
    await waitFor(() => expect(api.count(`GET /holds/${MERGE_HOLD.id}`)).toBe(2));
  });

  test("署名している途中は、もう一度押せない（二重に送らない）", async () => {
    const { api, webauthn } = setup(MERGE_HOLD);
    const held = webauthn.holdNextGet();
    api.on("POST /approvals/assert", approvalOk("approve", "approved"));
    fireEvent.click(await approveButton());
    await confirm(/パスキーで署名して承認する/);
    expect(await screen.findByText(/2\/3：パスキーで署名してください/)).toBeTruthy();
    expect((await approveButton()).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /却下する…/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    held.release();
    expect(await screen.findByText("承認しました。")).toBeTruthy();
    expect(api.count("POST /approvals/intent")).toBe(1);
  });
});
