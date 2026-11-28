import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { createFakeApi, fail, ok } from "../testing/fake-api.ts";
import { ME } from "../testing/fixtures.ts";
import { renderApp } from "../testing/render.tsx";
import { installFakeWebAuthn, removeWebAuthn } from "../testing/webauthn.ts";

const LOGIN_OPTIONS = {
  options: {
    challenge: "bG9naW4tY2hhbGxlbmdl",
    rpId: "localhost",
    allowCredentials: [{ id: "Y3JlZC0x", type: "public-key" }],
    userVerification: "required",
    timeout: 120_000,
  },
};

function setUrl(url: string) {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
}

afterEach(() => setUrl("http://localhost:7070/app/"));

describe("パスキーでのログイン（9.2：/auth/login/options → startAuthentication → /auth/login/verify）", () => {
  test("ログインすると、開いていた画面に入る", async () => {
    const webauthn = installFakeWebAuthn();
    const api = createFakeApi({
      "POST /auth/login/options": ok(LOGIN_OPTIONS),
      "GET /holds": ok({ holds: [] }),
      "GET /grants": ok({ grants: [] }),
    });
    api.on("POST /auth/login/verify", () => {
      api.on("GET /auth/me", ok(ME));
      return ok({ device: ME.device, expires_at: ME.expires_at });
    });
    renderApp({ api, me: null });
    fireEvent.click(await screen.findByRole("button", { name: "パスキーでログイン" }));
    expect(await screen.findByRole("heading", { level: 1, name: /承認待ち/ })).toBeTruthy();
    expect(webauthn.getCalls).toEqual([
      {
        challenge: "bG9naW4tY2hhbGxlbmdl",
        allowCredentials: ["Y3JlZC0x"],
        userVerification: "required",
        rpId: "localhost",
      },
    ]);
    expect(api.routes()).toEqual(
      expect.arrayContaining(["POST /auth/login/options", "POST /auth/login/verify"]),
    );
    const verify = api.calls.find((c) => c.path === "/auth/login/verify");
    expect(verify?.body).toMatchObject({ response: { id: "cred-1", type: "public-key" } });
  });

  test("パスキーが使えないブラウザでは、押せず、理由を言う", async () => {
    removeWebAuthn();
    renderApp({ me: null });
    const button = await screen.findByRole("button", { name: "パスキーでログイン" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/パスキー（WebAuthn）に対応していません/)).toBeTruthy();
  });

  test("取り消したら、登録していないときの案内も出す（ログインはしない）", async () => {
    const webauthn = installFakeWebAuthn();
    webauthn.failNextGet("NotAllowedError");
    const { api } = renderApp({
      me: null,
      routes: { "POST /auth/login/options": ok(LOGIN_OPTIONS) },
    });
    fireEvent.click(await screen.findByRole("button", { name: "パスキーでログイン" }));
    expect(await screen.findByText(/パスキーの操作が取り消されました/)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("aicoop pair --local");
    expect(api.count("POST /auth/login/verify")).toBe(0);
  });

  test("制御サーバーが署名を受け付けなければ、その日本語のメッセージを見せる", async () => {
    installFakeWebAuthn();
    renderApp({
      me: null,
      routes: {
        "POST /auth/login/options": ok(LOGIN_OPTIONS),
        "POST /auth/login/verify": fail(
          400,
          "signature_invalid",
          "パスキーの署名を確かめられませんでした",
        ),
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "パスキーでログイン" }));
    expect(await screen.findByText("パスキーの署名を確かめられませんでした")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "パスキーでログイン" })).toBeTruthy();
  });

  test("localhost でないアドレス（127.0.0.1）で開いたら、localhost で開き直すよう案内する", async () => {
    installFakeWebAuthn();
    setUrl("http://127.0.0.1:7070/app/#/pending");
    renderApp({ me: null });
    await screen.findByRole("heading", { name: "パスキーでログイン" });
    const link = screen.getByRole("link", { name: /localhost で開き直す/ });
    expect(link.getAttribute("href")).toBe("http://localhost:7070/app/#/pending");
    await waitFor(() =>
      expect(
        screen.getByText(/パスキーは http:\/\/localhost:7070\/app\/ でだけ使えます/),
      ).toBeTruthy(),
    );
  });
});
