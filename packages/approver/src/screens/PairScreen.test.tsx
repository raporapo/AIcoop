import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { fail, ok } from "../testing/fake-api.ts";
import { renderApp } from "../testing/render.tsx";
import { installFakeWebAuthn, removeWebAuthn } from "../testing/webauthn.ts";
import { deviceNameProblem } from "./PairScreen.tsx";

const OPTIONS = {
  options: {
    challenge: "cGFpci1jaGFsbGVuZ2U",
    rp: { id: "localhost", name: "AIcoop" },
    user: { id: "b3duZXI", name: "owner", displayName: "オーナー" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    timeout: 120_000,
  },
};

function fill(code: string, name: string) {
  fireEvent.change(screen.getByLabelText("ペアリングのコード"), { target: { value: code } });
  fireEvent.change(screen.getByLabelText(/この端末の名前/), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "パスキーを作って登録する" }));
}

describe("5.8 の2 端末の登録（aicoop pair --local：/pairing/options → startRegistration → /pairing/register）", () => {
  test("コードと名前 → パスキーを作る → 6桁の確認コードを大きく出し、ターミナルで y を押すよう言う", async () => {
    const webauthn = installFakeWebAuthn();
    const { api } = renderApp({
      me: null,
      hash: "#/pair",
      routes: {
        "POST /pairing/options": ok(OPTIONS),
        "POST /pairing/register": ok({ confirm_code: "482913" }),
      },
    });
    await screen.findByRole("heading", { level: 1, name: "この端末を登録する" });
    fill(" K7P-2QX ", "自宅のPC（Edge）");
    const code = await screen.findByRole("region", { name: "確認コード" });
    expect(code.querySelector(".big-code [aria-hidden='true']")?.textContent).toBe("482 913");
    expect(code.querySelector(".big-code .sr-only")?.textContent).toBe("4 8 2 9 1 3");
    expect(screen.getByText(/に出ている数字と同じか確かめて/).textContent).toContain(
      "aicoop pair --local",
    );
    expect(screen.getByText(/数字が違うときは/)).toBeTruthy();
    expect(api.calls.find((c) => c.path === "/pairing/options")?.body).toEqual({
      code: "K7P-2QX",
      device_name: "自宅のPC（Edge）",
    });
    const register = api.calls.find((c) => c.path === "/pairing/register")?.body as {
      code: string;
      response: { id: string };
    };
    expect(register.code).toBe("K7P-2QX");
    expect(register.response.id).toBe("cred-new");
    expect(webauthn.createCalls).toEqual([
      { challenge: "cGFpci1jaGFsbGVuZ2U", userVerification: "required" },
    ]);
  });

  test("5.14 の2の3：URL のコード（#/pair?code=…）を入れておく。端末の名前は打てるまま", async () => {
    installFakeWebAuthn();
    renderApp({ me: null, hash: "#/pair?code=ABCDE-FGHJK" });
    expect(((await screen.findByLabelText("ペアリングのコード")) as HTMLInputElement).value).toBe(
      "ABCDE-FGHJK",
    );
    const name = screen.getByLabelText(/この端末の名前/) as HTMLInputElement;
    expect(name.value).toBe("");
    expect(name.disabled || name.readOnly).toBe(false);
  });

  test("5.14 の2の3：拒否：URL のコードの形が違えば、コード欄を埋めない", async () => {
    installFakeWebAuthn();
    renderApp({ me: null, hash: "#/pair?code=K7P-2QX" });
    expect(((await screen.findByLabelText("ペアリングのコード")) as HTMLInputElement).value).toBe(
      "",
    );
  });

  test("5.14 の2の4：確認コードの画面は、ランチャーの窓（はい）でも確かめられると言う", async () => {
    installFakeWebAuthn();
    renderApp({
      me: null,
      hash: "#/pair?code=ABCDE-FGHJK",
      routes: {
        "POST /pairing/options": ok(OPTIONS),
        "POST /pairing/register": ok({ confirm_code: "482913" }),
      },
    });
    await screen.findByRole("heading", { level: 1, name: "この端末を登録する" });
    fireEvent.change(screen.getByLabelText(/この端末の名前/), { target: { value: "自宅のPC" } });
    fireEvent.click(screen.getByRole("button", { name: "パスキーを作って登録する" }));
    await screen.findByRole("region", { name: "確認コード" });
    expect(screen.getByText(/に出ている数字と同じか確かめて/).textContent).toContain("はい");
  });

  test("コードが違う・失効した：制御サーバーの日本語のメッセージ", async () => {
    installFakeWebAuthn();
    const { api } = renderApp({
      me: null,
      hash: "#/pair",
      routes: {
        "POST /pairing/options": fail(
          404,
          "pairing_invalid",
          "ペアリングのコードが違うか、失効しています",
        ),
      },
    });
    await screen.findByRole("heading", { level: 1, name: "この端末を登録する" });
    fill("WRONG", "PC");
    expect(await screen.findByText("ペアリングのコードが違うか、失効しています")).toBeTruthy();
    expect(api.count("POST /pairing/register")).toBe(0);
  });

  test("取り消した・登録済みの認証器：分かるように言い、登録しない", async () => {
    const webauthn = installFakeWebAuthn();
    const { api } = renderApp({
      me: null,
      hash: "#/pair",
      routes: { "POST /pairing/options": ok(OPTIONS) },
    });
    await screen.findByRole("heading", { level: 1, name: "この端末を登録する" });
    webauthn.failNextCreate("NotAllowedError");
    fill("K7P-2QX", "PC");
    expect(await screen.findByText(/パスキーの操作が取り消されました/)).toBeTruthy();
    webauthn.failNextCreate("InvalidStateError");
    fireEvent.click(screen.getByRole("button", { name: "パスキーを作って登録する" }));
    expect(await screen.findByText(/もうこの会社のパスキーが登録されています/)).toBeTruthy();
    expect(api.count("POST /pairing/register")).toBe(0);
  });

  test("パスキーが使えないブラウザでは押せない", async () => {
    removeWebAuthn();
    renderApp({ me: null, hash: "#/pair" });
    const button = await screen.findByRole("button", { name: "パスキーを作って登録する" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/パスキー（WebAuthn）に対応していません/)).toBeTruthy();
  });

  test("拒否側：端末の名前は1〜40文字で、制御文字・向きを変える文字は使えない（送らない）", async () => {
    expect(deviceNameProblem("")).toBe("端末の名前を入れてください");
    expect(deviceNameProblem("あ".repeat(41))).toBe("端末の名前は40文字までにしてください");
    expect(deviceNameProblem("あ".repeat(40))).toBeNull();
    expect(deviceNameProblem("PC\u{202E}evil")).toContain("向きを変える文字");
    expect(deviceNameProblem("PC\u{0007}")).toContain("制御文字");

    installFakeWebAuthn();
    const { api } = renderApp({ me: null, hash: "#/pair" });
    await screen.findByRole("heading", { level: 1, name: "この端末を登録する" });
    fill("K7P-2QX", "PC\u{202E}");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(api.count("POST /pairing/options")).toBe(0);
  });
});
