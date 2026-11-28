/**
 * テスト用：偽の Gmail・GitHub・Google の資格の発行（`fetch` の差し替え）。
 *
 * - `POST https://oauth2.googleapis.com/token` → アクセストークン `ya29.REAL-<n>`
 * - `POST https://api.github.com/app/installations/<id>/access_tokens` → `ghs_REAL<n>`
 * - Gmail：下書きの取得（`format=raw`）と `messages/send`
 * - GitHub：PR の取得と `pulls/<n>/merge`
 *
 * 呼ばれたリクエストは `calls` に残る（認証ヘッダーも。本物の資格が付いたかを確かめる）。
 */

export interface FakeCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeDraft {
  /** RFC 2822 のメール（文字列のまま。返すときに base64url にする） */
  readonly mail: string;
  readonly threadId?: string;
}

export interface FakePull {
  readonly title: string;
  readonly changed_files: number;
  readonly head: { readonly sha: string; readonly ref: string };
  readonly base: { readonly ref: string };
}

export interface FakeServices {
  readonly fetch: typeof fetch;
  readonly calls: FakeCall[];
  /** 下書きの ID → 中身 */
  readonly drafts: Map<string, FakeDraft>;
  /** `owner/name#番号` → PR */
  readonly pulls: Map<string, FakePull>;
  /** messages/send・merge が返すステータス（既定 200） */
  sendStatus: number;
  /** 送信の本文（既定は Gmail の Message） */
  sendBody: string;
  /** true なら、資格の発行も含めて通信できない */
  offline: boolean;
  /** 送った（messages/send・merge）リクエスト */
  sent(): FakeCall[];
  /** 発行したアクセストークン */
  readonly issued: string[];
}

export function base64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

/** よく使うメール（RFC 2822、CRLF） */
export function rfc2822(mail: {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly cc?: string;
  readonly bcc?: string;
  readonly from?: string;
}): string {
  const lines = [
    `From: ${mail.from ?? "sales@example.co.jp"}`,
    `To: ${mail.to}`,
    ...(mail.cc === undefined ? [] : [`Cc: ${mail.cc}`]),
    ...(mail.bcc === undefined ? [] : [`Bcc: ${mail.bcc}`]),
    `Subject: =?UTF-8?B?${Buffer.from(mail.subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    mail.body,
  ];
  return lines.join("\r\n");
}

export function fakeServices(): FakeServices {
  const calls: FakeCall[] = [];
  const drafts = new Map<string, FakeDraft>();
  const pulls = new Map<string, FakePull>();
  const issued: string[] = [];
  let n = 0;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const services: FakeServices = {
    calls,
    drafts,
    pulls,
    issued,
    sendStatus: 200,
    sendBody: JSON.stringify({ id: "msg-sent-1", threadId: "thread-1", labelIds: ["SENT"] }),
    offline: false,
    sent: () =>
      calls.filter(
        (c) =>
          (c.method === "POST" && c.url.endsWith("/messages/send")) ||
          (c.method === "PUT" && c.url.endsWith("/merge")),
      ),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const raw = init?.body;
      const body =
        raw === undefined || raw === null
          ? ""
          : typeof raw === "string"
            ? raw
            : Buffer.from(raw as Uint8Array).toString("utf8");
      calls.push({ method, url, headers, body });
      if (services.offline) throw new TypeError("fetch failed");

      const u = new URL(url);
      if (u.host === "oauth2.googleapis.com" && u.pathname === "/token" && method === "POST") {
        const token = `ya29.REAL-${++n}-abcdefghijklmnop`;
        issued.push(token);
        return json(200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
      }
      if (
        u.host === "api.github.com" &&
        /^\/app\/installations\/\d+\/access_tokens$/.test(u.pathname) &&
        method === "POST"
      ) {
        const token = `ghs_REAL${++n}abcdefghijklmnopqrstuv`;
        issued.push(token);
        return json(201, { token, expires_at: "2026-11-28T01:00:00Z" });
      }
      if (u.host === "gmail.googleapis.com") {
        const draft = /^\/gmail\/v1\/users\/me\/drafts\/([^/]+)$/.exec(u.pathname);
        if (draft !== null && method === "GET") {
          const d = drafts.get(decodeURIComponent(draft[1] as string));
          if (d === undefined) return json(404, { error: { code: 404, message: "Not Found" } });
          return json(200, {
            id: draft[1],
            message: {
              id: "msg-draft",
              threadId: d.threadId ?? "thread-1",
              raw: base64url(d.mail),
            },
          });
        }
        if (u.pathname === "/gmail/v1/users/me/messages/send" && method === "POST") {
          return new Response(services.sendBody, {
            status: services.sendStatus,
            headers: { "content-type": "application/json" },
          });
        }
      }
      if (u.host === "api.github.com") {
        const pr = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/merge)?$/.exec(u.pathname);
        if (pr !== null) {
          const pull = pulls.get(`${pr[1]}#${pr[2]}`);
          if (pull === undefined) return json(404, { message: "Not Found" });
          if (pr[3] === undefined && method === "GET") return json(200, pull);
          if (pr[3] !== undefined && method === "PUT") {
            return new Response(JSON.stringify({ merged: true, sha: "merged0sha" }), {
              status: services.sendStatus,
              headers: { "content-type": "application/json" },
            });
          }
        }
      }
      return json(404, { message: "偽のサービスにない道です" });
    }) as typeof fetch,
  };
  return services;
}
