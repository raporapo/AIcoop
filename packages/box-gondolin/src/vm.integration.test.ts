/**
 * Gondolin の VM を本当に起こして確かめる結合テスト。
 * 環境変数 `AICOOP_VM_IT=1` があるときだけ動く（KVM のある Linux か macOS が要る。CI の vm-integration ジョブ）。
 * イメージを組み立てるテスト（5.1.8・V-9）は、`AICOOP_VM_IT_IMAGE=1` があるときだけ動く（CI の vm-image ジョブ）。
 *
 * 確かめたことは `[V-x]` を付けて標準出力に書く（CI のログを 16章の記録の根拠にする）。
 */
import { randomBytes } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { Box, BoxSpec, ExecLine, ProxiedRequest, ProxyDecision } from "@aicoop/shared";
import { type HttpFetch, VM } from "@earendil-works/gondolin";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGondolinDriver } from "./driver.ts";
import { buildImage, IMAGE_METADATA_FILE } from "./image.ts";

const ENABLED = process.env.AICOOP_VM_IT === "1";
const IMAGE_ENABLED = process.env.AICOOP_VM_IT_IMAGE === "1";

const REAL = `ghs_IT_${randomBytes(16).toString("hex")}`;
const T = 180_000;

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly lines: readonly ExecLine[];
}

async function run(box: Box, cmd: readonly string[], cwd = "/"): Promise<RunResult> {
  const handle = box.exec(cmd, { cwd });
  const lines: ExecLine[] = [];
  for await (const line of handle) lines.push(line);
  const exitCode = await handle.exitCode;
  const pick = (s: "stdout" | "stderr") =>
    lines
      .filter((l) => l.stream === s)
      .map((l) => l.line)
      .join("\n");
  return { exitCode, stdout: pick("stdout"), stderr: pick("stderr"), lines };
}

const sh = (box: Box, script: string, cwd = "/") => run(box, ["sh", "-c", script], cwd);

function hostIPv4(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === "IPv4" && !info.internal) return info.address;
    }
  }
  return "127.0.0.1";
}

function vmRssKiB(vm: VM | null): number | null {
  const pid = vm?.getHostPid();
  if (pid === null || pid === undefined) return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

const deny = (reason: string): ProxyDecision => ({
  action: "respond",
  status: 403,
  headers: { "content-type": "application/json", "x-aicoop-decision": "deny" },
  body: JSON.stringify({ aicoop: "deny", operation: null, reason }),
});

describe.skipIf(!ENABLED)("Gondolin の VM（実機）", () => {
  let root = "";
  let work = "";
  let home = "";
  let skills = "";
  let etc = "";

  let gateway: Server | null = null;
  let gatewayPort = 0;
  const gatewayHits: string[] = [];

  let tcpServer: TcpServer | null = null;
  let tcpPort = 0;
  let tcpHits = 0;

  let udp: Socket | null = null;
  let udpPort = 0;
  let udpHits = 0;

  /** 資格プロキシ（onRequest）に渡ったリクエスト */
  const proxied: ProxiedRequest[] = [];
  /** 箱の外へ出た HTTP（upstreamFetch で受ける api.github.com 宛てのもの） */
  const upstream: { url: string; headers: Record<string, string>; body: string }[] = [];

  let vm: VM | null = null;
  let box: Box | null = null;
  const boxOf = (): Box => {
    if (!box) throw new Error("箱がない");
    return box;
  };

  const allowedHosts = new Set([
    "api.github.com",
    "example.com",
    // 内部アドレスは、判定が forward でも Gondolin と isBlockedAddress で止まることを確かめる
    "192.168.127.1",
    "10.0.0.1",
    "169.254.169.254",
    "127.0.0.1",
  ]);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "aicoop-vm-it-"));
    work = join(root, "work");
    home = join(root, "home");
    skills = join(root, "skills");
    etc = join(root, "etc");
    for (const d of [work, join(home, ".claude"), join(skills, "demo"), etc]) {
      mkdirSync(d, { recursive: true });
    }
    writeFileSync(join(work, "from-host.txt"), "host\n");
    writeFileSync(join(skills, "demo", "SKILL.md"), "# demo skill\n");
    writeFileSync(join(etc, "mcp.json"), "{}\n");

    gateway = createServer((req, res) => {
      gatewayHits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("gateway-ok");
    });
    await new Promise<void>((resolve) => gateway?.listen(0, "127.0.0.1", resolve));
    const address = gateway.address();
    gatewayPort = typeof address === "object" && address ? address.port : 0;

    tcpServer = createTcpServer((socket) => {
      tcpHits += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => tcpServer?.listen(0, "0.0.0.0", resolve));
    const tcpAddress = tcpServer.address();
    tcpPort = typeof tcpAddress === "object" && tcpAddress ? tcpAddress.port : 0;

    udp = createSocket("udp4");
    udp.on("message", () => {
      udpHits += 1;
    });
    await new Promise<void>((resolve) => udp?.bind(0, "0.0.0.0", resolve));
    udpPort = udp.address().port;

    const driver = createGondolinDriver({
      createVm: async (options) => {
        const created = await VM.create(options);
        vm = created;
        return created;
      },
      // api.github.com 宛てだけは外へ出さずに受け取り、置き換えのあとのヘッダーを確かめる
      upstreamFetch: (async (input: string, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname !== "api.github.com") return fetch(input, init);
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => {
          headers[k] = v;
        });
        const body = init?.body ? await new Response(init.body).text() : "";
        upstream.push({ url: url.toString(), headers, body });
        return Response.json({ ok: true });
      }) as unknown as HttpFetch,
      onProxyError: (error) => console.error("[proxy error]", error),
    });

    const spec: BoxSpec = {
      groupId: "it",
      memberId: "tester",
      runId: `run_it_${Date.now()}`,
      kind: "vm",
      memoryMiB: 1536,
      cpus: 1,
      mounts: [
        { hostPath: work, guestPath: "/work", readOnly: false },
        { hostPath: home, guestPath: "/home/agent", readOnly: false },
        { hostPath: skills, guestPath: "/home/agent/.claude/skills", readOnly: true },
        { hostPath: etc, guestPath: "/etc/aicoop", readOnly: true },
      ],
      env: { HOME: "/home/agent" },
      secrets: [{ env: "GITHUB_TOKEN", hosts: ["api.github.com", "github.com"], value: REAL }],
      network: {
        passthroughHosts: ["api.anthropic.com"],
        gatewayPort,
        onRequest: async (req) => {
          proxied.push(req);
          return allowedHosts.has(req.host) ? { action: "forward" } : deny("not_allowed");
        },
      },
    };
    const started = Date.now();
    box = await driver.create(spec);
    console.log(`[11.2] VM の起動にかかった時間: ${Date.now() - started} ms`);
  }, 900_000);

  afterAll(async () => {
    await box?.destroy();
    await box?.destroy();
    await new Promise<void>((resolve) => (gateway ? gateway.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) =>
      tcpServer ? tcpServer.close(() => resolve()) : resolve(),
    );
    udp?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it(
    "P1 完了条件1：箱の中で env を表示しても、本物の資格は出てこない",
    async () => {
      const env = await run(boxOf(), ["env"]);
      expect(env.exitCode).toBe(0);
      expect(env.stdout).toMatch(/^GITHUB_TOKEN=GONDOLIN_SECRET_[0-9a-f]{48}$/m);
      expect(env.stdout).not.toContain(REAL);
      const all = await sh(boxOf(), "cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n'");
      expect(all.stdout).not.toContain(REAL);
      console.log("[P1-1] env に本物の資格は出ない。GITHUB_TOKEN は仮の札");
    },
    T,
  );

  it(
    "5.2.1：forward のとき、hosts 宛てのヘッダー（Basic 認証の中も）だけが本物に置き換わる。本文・クエリは置き換わらない",
    async () => {
      const r = await sh(
        boxOf(),
        [
          'curl -sS -o /dev/null -w "%{http_code}\\n"',
          '-H "Authorization: Bearer $GITHUB_TOKEN"',
          '--data "body=$GITHUB_TOKEN"',
          '"https://api.github.com/user?q=$GITHUB_TOKEN"',
          '&& curl -sS -o /dev/null -w "%{http_code}\\n" -u "x-access-token:$GITHUB_TOKEN" https://api.github.com/basic',
        ].join(" "),
      );
      expect(r.stdout.split("\n")).toEqual(["200", "200"]);
      const [bearer, basic] = upstream.slice(-2);
      expect(bearer?.headers.authorization).toBe(`Bearer ${REAL}`);
      expect(bearer?.url).toContain("GONDOLIN_SECRET_");
      expect(bearer?.url).not.toContain(REAL);
      expect(bearer?.body).toContain("GONDOLIN_SECRET_");
      expect(bearer?.body).not.toContain(REAL);
      const decoded = Buffer.from(
        (basic?.headers.authorization ?? "").replace(/^Basic /, ""),
        "base64",
      ).toString();
      expect(decoded).toBe(`x-access-token:${REAL}`);
      console.log(
        "[5.2.1] 置き換わるのは forward のときのヘッダーだけ（Bearer・Basic）。本文・クエリはそのまま",
      );
    },
    T,
  );

  it(
    "5.2.1 の受け入れ条件：仮の札を hosts 以外のホストに送っても置き換わらない（通信が止まる）",
    async () => {
      const before = upstream.length;
      const r = await sh(
        boxOf(),
        'curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GITHUB_TOKEN" https://example.com/',
      );
      expect(r.stdout).toBe("403");
      expect(upstream.length).toBe(before);
      console.log("[5.2.1] 仮の札を example.com に送ると 403 で止まる");
    },
    T,
  );

  it(
    "P1 完了条件3・5.1.4：許可していないホストに接続できない（403、X-Aicoop-Decision: deny）",
    async () => {
      const r = await sh(boxOf(), "curl -sS -D - -o /dev/null https://www.example.org/");
      expect(r.stdout).toMatch(/^HTTP\/[\d.]+ 403/m);
      expect(r.stdout.toLowerCase()).toContain("x-aicoop-decision: deny");
      const f = await sh(boxOf(), "curl -sSf -o /dev/null https://www.example.org/");
      expect(f.exitCode).not.toBe(0);
      expect(proxied.some((p) => p.host === "www.example.org")).toBe(true);
      console.log("[P1-3] 許可していないホストは資格プロキシで 403（curl -f は失敗）");
    },
    T,
  );

  it(
    "許可したホストには、本当に外へ出て届く（箱の中が Gondolin の MITM の CA を信頼している）",
    async () => {
      const r = await sh(boxOf(), 'curl -sS -o /dev/null -w "%{http_code}" https://example.com/');
      expect(r.stdout).toBe("200");
    },
    T,
  );

  it(
    "5.1.4・未決 #2：内部アドレス（ループバック・プライベート・リンクローカル・メタデータ）は、判定が forward でも届かない",
    async () => {
      const hitsBefore = gatewayHits.length;
      const targets = [
        `http://192.168.127.1:${gatewayPort}/`,
        `http://127.0.0.1:${gatewayPort}/`,
        "http://10.0.0.1/",
        "http://169.254.169.254/latest/meta-data/",
      ];
      const results: string[] = [];
      for (const url of targets) {
        const r = await sh(
          boxOf(),
          `curl -sS -m 10 -o /dev/null -w "%{http_code}" "${url}" 2>/dev/null; echo " exit=$?"`,
        );
        results.push(`${url} -> ${r.stdout}`);
        expect(r.stdout.startsWith("200")).toBe(false);
      }
      expect(gatewayHits.length).toBe(hitsBefore);
      console.log(`[未決 #2] 内部アドレスへの HTTP: ${results.join(" / ")}`);
    },
    T,
  );

  it(
    "V-2：aicoop.internal から、ホストのテスト用 HTTP サーバー（127.0.0.1:<port>）に届く",
    async () => {
      const r = await sh(boxOf(), "curl -sS http://aicoop.internal/mcp");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("gateway-ok");
      expect(gatewayHits.at(-1)).toBe("GET /mcp");
      expect(proxied.some((p) => p.host === "aicoop.internal")).toBe(false);
      console.log(
        `[V-2] tcp.hosts の aicoop.internal:80 -> 127.0.0.1:${gatewayPort} で届いた（資格プロキシは通らない）`,
      );
    },
    T,
  );

  it(
    "V-1：passthroughHosts（api.anthropic.com）は、暗号を解かずに素通しする",
    async () => {
      const code = await sh(
        boxOf(),
        'curl -sS -m 20 -o /dev/null -w "%{http_code}" https://api.anthropic.com/',
      );
      expect(code.stdout).toMatch(/^[1-5]\d\d$/);
      const issuer = await sh(
        boxOf(),
        [
          "python3 -c",
          `"import socket, ssl; c = ssl.create_default_context(); s = c.wrap_socket(socket.create_connection(('api.anthropic.com', 443), timeout=20), server_hostname='api.anthropic.com'); print(dict(x[0] for x in s.getpeercert()['issuer']))"`,
        ].join(" "),
      );
      expect(issuer.exitCode).toBe(0);
      expect(issuer.stdout.toLowerCase()).not.toContain("gondolin");
      expect(proxied.some((p) => p.host === "api.anthropic.com")).toBe(false);
      console.log(
        `[V-1] api.anthropic.com は資格プロキシを通らず、HTTP ${code.stdout}。証明書の発行者: ${issuer.stdout}`,
      );
    },
    T,
  );

  it(
    "5.1.4 の受け入れ条件：UDP の送信は箱の外に届かない",
    async () => {
      const ip = hostIPv4();
      const r = await sh(
        boxOf(),
        [
          "python3 -c",
          `"import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for target in [('${ip}', ${udpPort}), ('192.168.127.1', ${udpPort}), ('8.8.8.8', ${udpPort})]:
    try:
        s.sendto(b'aicoop-udp', target)
        print('sent', target)
    except OSError as e:
        print('error', target, e)
"`,
        ].join(" "),
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(udpHits).toBe(0);
      const dns = await sh(boxOf(), "nslookup example.com 8.8.8.8 2>&1 || true");
      console.log(
        `[5.1.4] UDP はホストに届かない（受信 ${udpHits} 件）。箱の中: ${r.stdout.replace(/\n/g, " / ")}`,
      );
      console.log(`[5.1.4] 8.8.8.8 への DNS は合成の答え: ${dns.stdout.replace(/\n/g, " / ")}`);
    },
    T,
  );

  it(
    "5.1.4：任意の TCP は箱の外に届かない",
    async () => {
      const ip = hostIPv4();
      const r = await sh(
        boxOf(),
        [
          "python3 -c",
          `"import socket
for target in [('${ip}', ${tcpPort}), ('192.168.127.1', ${tcpPort})]:
    try:
        c = socket.create_connection(target, timeout=5)
        c.sendall(b'hello raw tcp\\n')
        print('recv', target, c.recv(16))
    except OSError as e:
        print('error', target, e)
"`,
        ].join(" "),
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(tcpHits).toBe(0);
      console.log(
        `[5.1.4] 生の TCP はホストに届かない（受信 ${tcpHits} 件）。箱の中: ${r.stdout.replace(/\n/g, " / ")}`,
      );
    },
    T,
  );

  it(
    "V-4：メモリ・CPU 数の指定が効く（1536 MiB・1 CPU）",
    async () => {
      const nproc = await sh(boxOf(), "grep -c ^processor /proc/cpuinfo");
      expect(nproc.stdout.trim()).toBe("1");
      const mem = await sh(boxOf(), "grep MemTotal /proc/meminfo");
      const kib = Number(/MemTotal:\s+(\d+)/.exec(mem.stdout)?.[1] ?? "0");
      expect(kib).toBeGreaterThan(1536 * 1024 * 0.8);
      expect(kib).toBeLessThanOrEqual(1536 * 1024);
      const free = await sh(boxOf(), "free -m");
      console.log(`[V-4] nproc=${nproc.stdout.trim()} MemTotal=${kib} kB`);
      console.log(`[V-4] 箱の中の free -m: ${free.stdout.replace(/\n/g, " / ")}`);
      console.log(
        `[V-4] ホストから見た VM（QEMU）の VmRSS: ${vmRssKiB(vm) ?? "不明"} kB（起動して数コマンドのあと）`,
      );
    },
    T,
  );

  it(
    "V-6：書き込める /home/agent の中に、読み取り専用の /home/agent/.claude/skills を重ねられる",
    async () => {
      const b = boxOf();
      expect((await run(b, ["cat", "/home/agent/.claude/skills/demo/SKILL.md"])).stdout).toBe(
        "# demo skill",
      );
      expect((await sh(b, "echo x > /home/agent/.claude/skills/new.md")).exitCode).not.toBe(0);
      expect((await run(b, ["rm", "/home/agent/.claude/skills/demo/SKILL.md"])).exitCode).not.toBe(
        0,
      );
      expect((await run(b, ["mkdir", "/home/agent/.claude/skills/d"])).exitCode).not.toBe(0);
      expect(
        (await run(b, ["mv", "/home/agent/.claude/skills", "/home/agent/.claude/moved"])).exitCode,
      ).not.toBe(0);
      expect((await sh(b, "echo '{}' > /home/agent/.claude/settings.json")).exitCode).toBe(0);
      expect((await sh(b, "echo x > /etc/aicoop/new")).exitCode).not.toBe(0);
      const ls = await run(b, ["ls", "-a", "/home/agent/.claude"]);
      expect(ls.stdout.split("\n")).toContain("skills");
      expect(readFileSync(join(home, ".claude", "settings.json"), "utf8")).toBe("{}\n");
      expect(readFileSync(join(skills, "demo", "SKILL.md"), "utf8")).toBe("# demo skill\n");
      console.log(
        "[V-6] 重ね合わせできる。skills は読めて、書き込み・削除・作成・移動は失敗。ホームには書ける",
      );
    },
    T,
  );

  it(
    "5.1.7：マウントしたフォルダが見え、箱の中で書いたものがホストに残る",
    async () => {
      const b = boxOf();
      expect((await run(b, ["cat", "/work/from-host.txt"])).stdout).toBe("host");
      expect((await sh(b, "echo from-box > out.txt", "/work")).exitCode).toBe(0);
      expect(readFileSync(join(work, "out.txt"), "utf8")).toBe("from-box\n");
    },
    T,
  );

  it(
    "4.4：exec は $PATH を探し、引数はシェルに注入されない。stdout と stderr を分ける",
    async () => {
      const b = boxOf();
      const echo = await run(b, ["echo", "a; touch /tmp/pwned", "$(id)", "`id`"]);
      expect(echo.stdout).toBe("a; touch /tmp/pwned $(id) `id`");
      expect((await run(b, ["test", "-e", "/tmp/pwned"])).exitCode).toBe(1);
      const both = await sh(b, "echo out; echo err >&2; exit 3");
      expect(both.exitCode).toBe(3);
      expect(both.lines).toEqual(
        expect.arrayContaining([
          { stream: "stdout", line: "out" },
          { stream: "stderr", line: "err" },
        ]),
      );
    },
    T,
  );

  it(
    "5.5.5：kill で、動いているコマンドとその子孫が止まる",
    async () => {
      const b = boxOf();
      const handle = b.exec(["sh", "-c", "sleep 600 & sleep 600 & wait"], { cwd: "/" });
      const drained = (async () => {
        for await (const _ of handle) {
          // 読み捨てる
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const started = Date.now();
      await b.kill();
      const code = await handle.exitCode;
      await drained;
      expect([137, 143]).toContain(code);
      const ps = await sh(b, "ps -o comm | grep -c '^sleep' || true");
      expect(ps.stdout.trim()).toBe("0");
      console.log(`[5.5.5] kill で止まった（終了コード ${code}、${Date.now() - started} ms）`);
    },
    T,
  );

  it("資格プロキシに渡したリクエストのヘッダーに、本物の資格は1度も入らなかった", () => {
    expect(proxied.length).toBeGreaterThan(0);
    expect(JSON.stringify(proxied.map((p) => p.headers))).not.toContain(REAL);
  });
});

describe.skipIf(!IMAGE_ENABLED)("5.1.8・V-9：aicoop のベースイメージ（実機）", () => {
  let root = "";
  let imageDir = "";
  let vm: VM | null = null;
  let box: Box | null = null;
  const boxOf = (): Box => {
    if (!box) throw new Error("箱がない");
    return box;
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "aicoop-image-it-"));
    imageDir = join(root, "images", "groups", "it");
    const started = Date.now();
    const result = await buildImage({ outputDir: imageDir, packages: ["jq"], verbose: true });
    console.log(
      `[5.1.8] イメージを組み立てた（${Math.round((Date.now() - started) / 1000)} 秒、Claude Code ${result.claudeCodeVersion}）`,
    );
    console.log(`[5.1.8] ${readFileSync(join(imageDir, IMAGE_METADATA_FILE), "utf8")}`);
    const work = join(root, "work");
    mkdirSync(work, { recursive: true });
    const driver = createGondolinDriver({
      createVm: async (options) => {
        const created = await VM.create(options);
        vm = created;
        return created;
      },
    });
    box = await driver.create({
      groupId: "it",
      memberId: "tester",
      runId: `run_image_${Date.now()}`,
      kind: "vm",
      image: imageDir,
      mounts: [{ hostPath: work, guestPath: "/work", readOnly: false }],
      env: { HOME: "/root" },
      secrets: [{ env: "GITHUB_TOKEN", hosts: ["api.github.com", "github.com"], value: REAL }],
      network: {
        passthroughHosts: ["api.anthropic.com"],
        gatewayPort: 9,
        onRequest: async () => deny("not_allowed"),
      },
    });
  }, 3_600_000);

  afterAll(async () => {
    await box?.destroy();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it(
    "V-9：Claude Code（ネイティブ版、musl）が Alpine で claude --version まで動く",
    async () => {
      const before = vmRssKiB(vm);
      const r = await run(boxOf(), ["claude", "--version"]);
      console.log(
        `[V-9] claude --version: exit=${r.exitCode} stdout=${r.stdout} stderr=${r.stderr}`,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/\d+\.\d+\.\d+/);
      const which = await sh(
        boxOf(),
        "command -v claude; ldd /usr/local/bin/claude 2>&1 | head -5",
      );
      console.log(`[V-9] ${which.stdout.replace(/\n/g, " / ")}`);
      console.log(
        `[V-4] VM の VmRSS: claude --version の前 ${before ?? "不明"} kB、あと ${vmRssKiB(vm) ?? "不明"} kB`,
      );
    },
    T,
  );

  it(
    "5.1.8 の1・2：git・ripgrep・部署ごとのパッケージ（jq）が入っている",
    async () => {
      for (const cmd of [
        ["git", "--version"],
        ["rg", "--version"],
        ["jq", "--version"],
      ]) {
        const r = await run(boxOf(), cmd);
        expect(r.exitCode).toBe(0);
        console.log(`[5.1.8] ${cmd.join(" ")}: ${r.stdout.split("\n")[0]}`);
      }
      const env = await run(boxOf(), ["env"]);
      expect(env.stdout).toMatch(/^USE_BUILTIN_RIPGREP=0$/m);
      expect(env.stdout).toMatch(/^DISABLE_AUTOUPDATER=1$/m);
    },
    T,
  );

  it(
    "5.1.8 の3：git の資格ヘルパーは、github.com にユーザー名 x-access-token・パスワード（仮の札）を返す",
    async () => {
      const r = await sh(
        boxOf(),
        "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill",
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("username=x-access-token");
      expect(r.stdout).toMatch(/^password=GONDOLIN_SECRET_[0-9a-f]{48}$/m);
      expect(r.stdout).not.toContain(REAL);
      const other = await sh(
        boxOf(),
        "printf 'protocol=https\\nhost=gitlab.com\\n\\n' | git credential fill 2>&1",
      );
      expect(other.stdout).not.toContain("GONDOLIN_SECRET_");
      console.log("[5.1.8] git の資格ヘルパーは github.com にだけ仮の札を返す");
    },
    T,
  );
});
