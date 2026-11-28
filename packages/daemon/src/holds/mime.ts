/**
 * メール（RFC 5322・MIME）の最小の読み取り：保留の要約 `gmail_message`（5.7.1 の2）に使う。
 *
 * 読むのは、要約に出すものだけ：From・To・Cc・Bcc・Subject（RFC 2047 の符号化を解く）、本文のテキスト
 * （text/plain を優先し、なければ text/html）、添付ファイルの名前。
 *
 * 中身は箱の中の AI が書いたもの（Z3）。読み違えでオーナーから宛先を隠されないように：
 * - ヘッダーは、同じ名前のものが複数あれば、すべてを返し、警告を付ける
 * - 宛先は、アドレスに分けず、ヘッダーの値をそのまま（符号化を解いて）返す
 * - Resent-To などのほかの宛先のヘッダー、読めない行・文字コードは警告に書く
 * オーナーは、承認アプリで元のリクエスト全体も見られる（5.7.1 の4、10.2）。
 */

export interface ParsedMail {
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: readonly string[];
  /** 本文のテキスト。なければ null */
  readonly text: { readonly kind: "text" | "html"; readonly body: string } | null;
  /** 添付ファイルの名前 */
  readonly attachments: readonly string[];
  /** 読み違えのおそれ（オーナーに見せる日本語） */
  readonly warnings: readonly string[];
}

const MAX_DEPTH = 10;
const MAX_PARTS = 200;

interface Header {
  readonly name: string;
  readonly value: string;
}

interface Part {
  readonly headers: readonly Header[];
  readonly body: Uint8Array;
}

export function parseMail(raw: Uint8Array): ParsedMail {
  const warnings: string[] = [];
  const top = splitPart(raw, warnings);
  const values = (name: string) =>
    top.headers.filter((h) => h.name === name).map((h) => decodeWords(h.value, warnings));

  const result = {
    from: values("from"),
    to: values("to"),
    cc: values("cc"),
    bcc: values("bcc"),
    subject: values("subject"),
  };
  for (const [name, label] of [
    ["from", "From"],
    ["to", "To"],
    ["cc", "Cc"],
    ["bcc", "Bcc"],
    ["subject", "Subject"],
  ] as const) {
    const n = result[name].length;
    if (n > 1) warnings.push(`${label} のヘッダーが ${n} つあります。どれも宛先になりえます`);
  }
  if (result.to.length + result.cc.length + result.bcc.length === 0) {
    warnings.push("宛先（To・Cc・Bcc）のヘッダーがありません");
  }
  const others = [
    ...new Set(
      top.headers
        .map((h) => h.name)
        .filter((n) => /^resent-(to|cc|bcc|from|sender)$/.test(n) || n === "apparently-to"),
    ),
  ];
  for (const name of others) {
    warnings.push(`宛先にかかわるヘッダー ${headerLabel(name)} があります`);
  }

  const texts: { kind: "text" | "html"; body: string }[] = [];
  const attachments: string[] = [];
  const counter = { parts: 0 };
  walk(top, 0, texts, attachments, warnings, counter);
  const text = texts.find((t) => t.kind === "text") ?? texts.find((t) => t.kind === "html") ?? null;

  return { ...result, text, attachments, warnings: [...new Set(warnings)] };
}

function headerLabel(name: string): string {
  return name.replace(/(^|-)([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase());
}

// ---- ヘッダーと本文に分ける ----

function splitPart(bytes: Uint8Array, warnings: string[]): Part {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let headerEnd = -1;
  let bodyStart = buffer.length;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 0x0a) continue;
    // LF の次が LF、または CRLF
    if (buffer[i + 1] === 0x0a) {
      headerEnd = i;
      bodyStart = i + 2;
      break;
    }
    if (buffer[i + 1] === 0x0d && buffer[i + 2] === 0x0a) {
      headerEnd = i;
      bodyStart = i + 3;
      break;
    }
  }
  // 本文の前に空行がない（ヘッダーだけ）
  if (headerEnd < 0) headerEnd = buffer.length;
  // 最初の行が空（ヘッダーなし）
  if (buffer[0] === 0x0a || (buffer[0] === 0x0d && buffer[1] === 0x0a)) {
    return { headers: [], body: new Uint8Array(buffer.subarray(buffer[0] === 0x0a ? 1 : 2)) };
  }
  const headerText = buffer.subarray(0, headerEnd).toString("utf8").replace(/\r$/, "");
  const headers = parseHeaders(headerText, warnings);
  return { headers, body: new Uint8Array(buffer.subarray(Math.min(bodyStart, buffer.length))) };
}

function parseHeaders(text: string, warnings: string[]): Header[] {
  const lines = text.split(/\r?\n/);
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.replace(/^[ \t]/, (c) => (c === "\t" ? "\t" : " "));
    } else {
      unfolded.push(line);
    }
  }
  const headers: Header[] = [];
  for (const line of unfolded) {
    if (line === "") continue;
    const m = /^([\x21-\x39\x3b-\x7e]+):[ \t]*(.*)$/s.exec(line);
    if (m === null) {
      warnings.push("ヘッダーとして読めない行があります");
      continue;
    }
    if (line.includes("\r")) warnings.push("ヘッダーの中に、改行の一部（CR）があります");
    headers.push({ name: (m[1] as string).toLowerCase(), value: (m[2] as string).trimEnd() });
  }
  return headers;
}

// ---- RFC 2047（ヘッダーの符号化） ----

const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

function decodeWords(value: string, warnings: string[]): string {
  // 符号化した語のあいだの空白だけは消す（RFC 2047 の6.2）
  const joined = value.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g, "$1");
  return joined.replace(ENCODED_WORD, (whole, charset: string, encoding: string, text: string) => {
    const label = charset.split("*", 1)[0] as string;
    let bytes: Buffer;
    if (encoding.toUpperCase() === "B") {
      bytes = Buffer.from(text, "base64");
    } else {
      bytes = decodeQuotedPrintable(text.replace(/_/g, " "), false);
    }
    const decoded = decodeCharset(bytes, label, warnings);
    return decoded ?? whole;
  });
}

// ---- Content-Type などの引数 ----

interface ContentType {
  readonly type: string;
  readonly params: Readonly<Record<string, string>>;
}

function parseParams(value: string, warnings: string[]): ContentType {
  const [first, ...rest] = splitParams(value);
  const params: Record<string, string> = {};
  const continued: Record<string, { index: number; value: string; encoded: boolean }[]> = {};
  for (const item of rest) {
    const eq = item.indexOf("=");
    if (eq < 0) continue;
    const rawName = item.slice(0, eq).trim().toLowerCase();
    let v = item.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
      v = v.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    // RFC 2231：name*=charset'lang'%xx、name*0*=…、name*1=…
    const m = /^([^*]+)\*(?:(\d+)\*?|)$/.exec(rawName);
    if (m !== null) {
      const name = m[1] as string;
      const index = m[2] === undefined ? 0 : Number(m[2]);
      const list = continued[name] ?? [];
      list.push({ index, value: v, encoded: rawName.endsWith("*") });
      continued[name] = list;
      continue;
    }
    params[rawName] = v;
  }
  for (const [name, pieces] of Object.entries(continued)) {
    pieces.sort((a, b) => a.index - b.index);
    let charset = "utf-8";
    const bytes: Buffer[] = [];
    for (const [i, piece] of pieces.entries()) {
      let v = piece.value;
      if (i === 0 && piece.encoded) {
        const parts = v.split("'");
        if (parts.length >= 3) {
          charset = parts[0] || "utf-8";
          v = parts.slice(2).join("'");
        }
      }
      bytes.push(piece.encoded ? percentDecode(v) : Buffer.from(v, "utf8"));
    }
    params[name] = decodeCharset(Buffer.concat(bytes), charset, warnings) ?? "";
  }
  return { type: (first ?? "").trim().toLowerCase(), params };
}

/** `;` で区切る（引用符の中の `;` では区切らない） */
function splitParams(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (c === "\\" && quoted && i + 1 < value.length) {
      current += c + (value[i + 1] as string);
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      out.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

function percentDecode(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "%" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(c, "utf8"));
    }
  }
  return Buffer.from(bytes);
}

// ---- 本文 ----

function walk(
  part: Part,
  depth: number,
  texts: { kind: "text" | "html"; body: string }[],
  attachments: string[],
  warnings: string[],
  counter: { parts: number },
): void {
  counter.parts += 1;
  if (counter.parts > MAX_PARTS || depth > MAX_DEPTH) {
    warnings.push("メールの部分が多すぎる・深すぎるので、途中から読んでいません");
    return;
  }
  const header = (name: string) => part.headers.find((h) => h.name === name)?.value;
  const contentType = parseParams(header("content-type") ?? "text/plain", warnings);
  const disposition = parseParams(header("content-disposition") ?? "", warnings);
  const type = contentType.type === "" ? "text/plain" : contentType.type;

  if (type.startsWith("multipart/")) {
    const boundary = contentType.params.boundary;
    if (boundary === undefined || boundary === "") {
      warnings.push("multipart の区切り（boundary）がありません");
      return;
    }
    for (const child of splitMultipart(part.body, boundary)) {
      walk(splitPart(child, warnings), depth + 1, texts, attachments, warnings, counter);
    }
    return;
  }

  const filename = disposition.params.filename ?? contentType.params.name;
  const isAttachment = disposition.type === "attachment" || filename !== undefined;
  if (isAttachment) {
    attachments.push(decodeWords(filename ?? "（名前なし）", warnings));
    return;
  }
  if (type !== "text/plain" && type !== "text/html") return;

  const transfer = (header("content-transfer-encoding") ?? "7bit").trim().toLowerCase();
  let bytes: Buffer;
  if (transfer === "base64") {
    bytes = Buffer.from(Buffer.from(part.body).toString("latin1").replace(/\s+/g, ""), "base64");
  } else if (transfer === "quoted-printable") {
    bytes = decodeQuotedPrintable(Buffer.from(part.body).toString("latin1"), true);
  } else {
    bytes = Buffer.from(part.body);
  }
  const charset = contentType.params.charset ?? "utf-8";
  const text = decodeCharset(bytes, charset, warnings) ?? "";
  texts.push({
    kind: type === "text/plain" ? "text" : "html",
    body: text.replace(/\r\n?/g, "\n").replace(/\n+$/, ""),
  });
}

function splitMultipart(body: Uint8Array, boundary: string): Uint8Array[] {
  const text = Buffer.from(body).toString("latin1");
  const lines = text.split(/(?<=\n)/);
  const delimiter = `--${boundary}`;
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, "").trimEnd();
    if (bare === delimiter || bare === `${delimiter}--`) {
      if (current !== null) parts.push(current.join("").replace(/\r?\n$/, ""));
      current = bare === delimiter ? [] : null;
      if (bare !== delimiter) break;
      continue;
    }
    current?.push(line);
  }
  if (current !== null) parts.push(current.join(""));
  return parts.map((p) => new Uint8Array(Buffer.from(p, "latin1")));
}

function decodeQuotedPrintable(text: string, softBreaks: boolean): Buffer {
  const source = softBreaks ? text.replace(/=\r?\n/g, "") : text;
  const bytes: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 0x3d && /^[0-9A-Fa-f]{2}$/.test(source.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(source.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(c & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/**
 * 文字コードで読む。知らない文字コードは UTF-8 として読み、警告する。
 * us-ascii（と、書いていないもの）は UTF-8 として読む（ASCII の範囲では同じで、WHATWG の
 * us-ascii は windows-1252 になってしまうため）
 */
function decodeCharset(bytes: Uint8Array, charset: string, warnings: string[]): string | null {
  const label = charset.trim().toLowerCase();
  try {
    const name = label === "" || label === "us-ascii" || label === "ascii" ? "utf-8" : label;
    return new TextDecoder(name).decode(bytes);
  } catch {
    warnings.push(`知らない文字コード ${charset} を UTF-8 として読みました`);
    return new TextDecoder("utf-8").decode(bytes);
  }
}
