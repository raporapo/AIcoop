import { describe, expect, it } from "vitest";
import { parseMail } from "./mime.ts";

const enc = (text: string) => new TextEncoder().encode(text);
const crlf = (lines: string[]) => enc(lines.join("\r\n"));

describe("5.7.1 の2（gmail_message）：RFC 2822 のメールから、宛先・件名・本文のテキストを読む", () => {
  it("To・Cc・Bcc・From・件名（RFC 2047 の符号化）と、text/plain の本文", () => {
    const subject = `=?UTF-8?B?${Buffer.from("お見積りのご案内").toString("base64")}?=`;
    const mail = parseMail(
      crlf([
        "From: =?UTF-8?Q?=E5=96=B6=E6=A5=AD?= <sales@example.co.jp>",
        'To: "山田 太郎" <yamada@customer.example>, b@customer.example',
        "Cc: c@customer.example",
        "Bcc: boss@example.co.jp",
        `Subject: ${subject}`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: 8bit",
        "",
        "山田様",
        "",
        "お世話になっております。",
      ]),
    );
    expect(mail.from).toEqual(["営業 <sales@example.co.jp>"]);
    expect(mail.to).toEqual(['"山田 太郎" <yamada@customer.example>, b@customer.example']);
    expect(mail.cc).toEqual(["c@customer.example"]);
    expect(mail.bcc).toEqual(["boss@example.co.jp"]);
    expect(mail.subject).toEqual(["お見積りのご案内"]);
    expect(mail.text).toEqual({ kind: "text", body: "山田様\n\nお世話になっております。" });
    expect(mail.attachments).toEqual([]);
    expect(mail.warnings).toEqual([]);
  });

  it("折り返したヘッダーをつなぐ。LF だけの改行も読む", () => {
    const mail = parseMail(
      enc("To: a@example.com,\n b@example.com,\n\tc@example.com\nSubject: 長い\n 件名\n\n本文"),
    );
    expect(mail.to).toEqual(["a@example.com, b@example.com,\tc@example.com"]);
    expect(mail.subject).toEqual(["長い 件名"]);
    expect(mail.text?.body).toBe("本文");
  });

  it("multipart/alternative では text/plain を選ぶ（base64・quoted-printable を解く）", () => {
    const mail = parseMail(
      crlf([
        "To: a@example.com",
        'Content-Type: multipart/alternative; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("プレーンの本文").toString("base64"),
        "--b1",
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "<p>=E3=81=82</p>",
        "--b1--",
      ]),
    );
    expect(mail.text).toEqual({ kind: "text", body: "プレーンの本文" });
  });

  it("quoted-printable の本文（=改行の折り返しを含む）", () => {
    const mail = parseMail(
      crlf([
        "To: a@example.com",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "=E3=81=93=E3=82=93=E3=81=AB=",
        "=E3=81=A1=E3=81=AF a=3Db",
      ]),
    );
    expect(mail.text?.body).toBe("こんにちは a=b");
  });

  it("text/html しかなければ、html として返す", () => {
    const mail = parseMail(
      crlf(["To: a@example.com", "Content-Type: text/html; charset=utf-8", "", "<b>太字</b>"]),
    );
    expect(mail.text).toEqual({ kind: "html", body: "<b>太字</b>" });
  });

  it("multipart/mixed の添付ファイルの名前（RFC 2231・RFC 2047）を集め、本文には使わない", () => {
    const mail = parseMail(
      crlf([
        "To: a@example.com",
        "Content-Type: multipart/mixed; boundary=outer",
        "",
        "--outer",
        "Content-Type: multipart/alternative; boundary=inner",
        "",
        "--inner",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "本文です",
        "--inner--",
        "--outer",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Disposition: attachment; filename*=UTF-8''%E8%A6%8B%E7%A9%8D.txt",
        "",
        "添付の中身",
        "--outer",
        `Content-Type: application/pdf; name="=?UTF-8?B?${Buffer.from("契約書.pdf").toString("base64")}?="`,
        "Content-Disposition: attachment",
        "Content-Transfer-Encoding: base64",
        "",
        "JVBERi0=",
        "--outer--",
      ]),
    );
    expect(mail.text).toEqual({ kind: "text", body: "本文です" });
    expect(mail.attachments).toEqual(["見積.txt", "契約書.pdf"]);
  });

  it("ISO-2022-JP の件名と本文を読む", () => {
    const jis = Buffer.from([
      0x1b, 0x24, 0x42, 0x24, 0x33, 0x24, 0x73, 0x24, 0x4b, 0x24, 0x41, 0x24, 0x4f, 0x1b, 0x28,
      0x42,
    ]);
    const mail = parseMail(
      Buffer.concat([
        crlf([
          `Subject: =?ISO-2022-JP?B?${jis.toString("base64")}?=`,
          "To: a@example.com",
          "Content-Type: text/plain; charset=ISO-2022-JP",
          "Content-Transfer-Encoding: 7bit",
          "",
          "",
        ]),
        jis,
      ]),
    );
    expect(mail.subject).toEqual(["こんにちは"]);
    expect(mail.text?.body).toBe("こんにちは");
  });

  describe("拒否側：読み違えで宛先を隠されないように、迷うものは警告する", () => {
    it("To が2つあれば、両方を返して警告する", () => {
      const mail = parseMail(
        crlf(["To: a@example.com", "To: evil@example.net", "Subject: s", "", "x"]),
      );
      expect(mail.to).toEqual(["a@example.com", "evil@example.net"]);
      expect(mail.warnings.join("\n")).toMatch(/To.*2/);
    });

    it("宛先のヘッダーがひとつもなければ警告する", () => {
      expect(parseMail(crlf(["Subject: s", "", "x"])).warnings.join("\n")).toMatch(/宛先/);
    });

    it("Resent-To などの、ほかの宛先のヘッダーがあれば警告する", () => {
      const mail = parseMail(crlf(["To: a@example.com", "Resent-Bcc: evil@example.net", "", "x"]));
      expect(mail.warnings.join("\n")).toMatch(/Resent-Bcc/);
    });

    it("読めない文字コードは UTF-8 として読み、警告する", () => {
      const mail = parseMail(
        crlf(["To: a@example.com", "Content-Type: text/plain; charset=x-unknown", "", "abc"]),
      );
      expect(mail.text?.body).toBe("abc");
      expect(mail.warnings.join("\n")).toMatch(/x-unknown/);
    });

    it("ヘッダーとして読めない行があれば警告する", () => {
      const mail = parseMail(crlf(["To: a@example.com", "this is not a header", "", "x"]));
      expect(mail.warnings.join("\n")).toMatch(/ヘッダー/);
    });

    it("本文のテキストがなければ text は null", () => {
      const mail = parseMail(
        crlf([
          "To: a@example.com",
          "Content-Type: application/octet-stream",
          "Content-Transfer-Encoding: base64",
          "",
          "AAEC",
        ]),
      );
      expect(mail.text).toBeNull();
    });
  });
});
