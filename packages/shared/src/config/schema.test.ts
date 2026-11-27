import { describe, expect, it } from "vitest";
import type { ConfigIssue } from "../config-issue.ts";
import { type ConfigFileName, parseConfigFile } from "./schema.ts";

const COMPANY = { id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YB", name: "サンプル商会" };

function ok<K extends ConfigFileName>(name: K, input: unknown) {
  const result = parseConfigFile(name, input);
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.value;
}

function issues(name: ConfigFileName, input: unknown): ConfigIssue[] {
  const result = parseConfigFile(name, input);
  if (result.ok) throw new Error("エラーになるはずが、読めてしまった");
  return [...result.issues];
}

/** 1つだけ E-013 が出て、その path が期待どおり */
function expectE013(name: ConfigFileName, input: unknown, path: string) {
  const found = issues(name, input);
  expect(found.map((i) => i.code)).toEqual(found.map(() => "E-013"));
  expect(found.map((i) => i.path)).toContain(path);
  for (const i of found) expect(i.source).toBe(name);
  return found.find((i) => i.path === path) as ConfigIssue;
}

// 6.2 aicoop.yaml
describe("6.2 aicoop.yaml", () => {
  it("6.2：書いていないキーは、表の値を既定とする", () => {
    const c = ok("aicoop.yaml", { company: COMPANY });
    expect(c).toEqual({
      company: COMPANY,
      timezone: "Asia/Tokyo",
      daemon: { port: 7070, max_concurrent_boxes: 3 },
      task: { timeout_minutes: 45 },
      anthropic_passthrough_hosts: ["api.anthropic.com"],
      holds: { ttl_hours: 72 },
      grants: { max_hours: 168 },
      tickets: { max_depth: 2, daily_limit: 20 },
      sessions: { max_idle_days: 30 },
      audit: { retention_days: 365 },
      relay: { url: "" },
      humans: { daily_limit: 3 },
      runtimes: { local_llm: "" },
    });
  });

  it("6.2：設計書の例をそのまま読める", () => {
    const c = ok("aicoop.yaml", {
      company: COMPANY,
      timezone: "Asia/Tokyo",
      daemon: { home: "~/.aicoop", port: 7070, max_concurrent_boxes: 3 },
      task: { timeout_minutes: 45 },
      anthropic_passthrough_hosts: ["api.anthropic.com"],
      holds: { ttl_hours: 72 },
      grants: { max_hours: 168 },
      tickets: { max_depth: 2, daily_limit: 20 },
      sessions: { max_idle_days: 30 },
      audit: { retention_days: 365 },
      relay: { url: "" },
      humans: { daily_limit: 3, intake_member: "ceo" },
      runtimes: { local_llm: "" },
    });
    expect(c.daemon.home).toBe("~/.aicoop");
    expect(c.humans.intake_member).toBe("ceo");
  });

  it.each([
    ["daemon.max_concurrent_boxes", { daemon: { max_concurrent_boxes: 0 } }],
    ["daemon.max_concurrent_boxes", { daemon: { max_concurrent_boxes: 17 } }],
    ["daemon.port", { daemon: { port: 70000 } }],
    ["task.timeout_minutes", { task: { timeout_minutes: 0 } }],
    ["holds.ttl_hours", { holds: { ttl_hours: 169 } }],
    ["grants.max_hours", { grants: { max_hours: 721 } }],
    ["tickets.max_depth", { tickets: { max_depth: 6 } }],
    ["tickets.daily_limit", { tickets: { daily_limit: -1 } }],
    ["sessions.max_idle_days", { sessions: { max_idle_days: 366 } }],
    ["audit.retention_days", { audit: { retention_days: 29 } }],
    ["humans.daily_limit", { humans: { daily_limit: 21 } }],
    ["daemon.max_concurrent_boxes", { daemon: { max_concurrent_boxes: 2.5 } }],
    ["daemon.max_concurrent_boxes", { daemon: { max_concurrent_boxes: "3" } }],
  ])("6.10 E-013：範囲を外れた値（%s）", (path, over) => {
    expectE013("aicoop.yaml", { company: COMPANY, ...over }, path);
  });

  it("6.10 E-013：範囲のメッセージは日本語で、直し方（上限）といまの値を書く", () => {
    const issue = expectE013(
      "aicoop.yaml",
      { company: COMPANY, daemon: { max_concurrent_boxes: 17 } },
      "daemon.max_concurrent_boxes",
    );
    expect(issue.message).toBe(
      "aicoop.yaml の daemon.max_concurrent_boxes：16以下にしてください（いまの値：17）",
    );
  });

  it("6.10 E-013：company がなければエラー（id は aicoop init が作るので既定値を持たない）", () => {
    const found = issues("aicoop.yaml", {});
    expect(found.map((i) => i.path)).toEqual(["company"]);
    expect(found[0]?.message).toContain("必須です");
  });

  it.each([
    "01JD6V8X3S0Q5W7KQ9M2T4R6YB",
    "c_xxx",
    "t_01JD6V8X3S0Q5W7KQ9M2T4R6YB",
    "{{company_id}}",
  ])("6.10 E-013：company.id が c_ + ULID でない（%s）", (id) => {
    expectE013("aicoop.yaml", { company: { ...COMPANY, id } }, "company.id");
  });

  it("6.10 E-013：company.name が空", () => {
    expectE013("aicoop.yaml", { company: { ...COMPANY, name: "  " } }, "company.name");
  });

  it.each(["Asia/Tokyo", "America/New_York", "Europe/London", "UTC", "Etc/GMT-9"])(
    "6.2：timezone は IANA 形式（%s）を読める",
    (timezone) => {
      expect(ok("aicoop.yaml", { company: COMPANY, timezone }).timezone).toBe(timezone);
    },
  );

  it.each(["Foo/Bar", "JST", "asia/tokyo", "+09:00", "", "Japan"])(
    "6.10 E-013：timezone が IANA 形式でない（%s）",
    (timezone) => {
      expectE013("aicoop.yaml", { company: COMPANY, timezone }, "timezone");
    },
  );

  it.each([
    ["anthropic_passthrough_hosts.0", { anthropic_passthrough_hosts: ["*"] }],
    [
      "anthropic_passthrough_hosts.0",
      { anthropic_passthrough_hosts: ["https://api.anthropic.com"] },
    ],
    ["anthropic_passthrough_hosts", { anthropic_passthrough_hosts: [] }],
    ["relay.url", { relay: { url: "http://relay.example.com" } }],
    ["relay.url", { relay: { url: "relay.example.com" } }],
    ["runtimes.local_llm", { runtimes: { local_llm: "ftp://127.0.0.1" } }],
    ["daemon.home", { daemon: { home: "" } }],
  ])("6.10 E-013：形式の誤り（%s）", (path, over) => {
    expectE013("aicoop.yaml", { company: COMPANY, ...over }, path);
  });

  it("6.2：relay.url は https、runtimes.local_llm は http か https を読める", () => {
    const c = ok("aicoop.yaml", {
      company: COMPANY,
      relay: { url: "https://relay.example.com" },
      runtimes: { local_llm: "http://127.0.0.1:11434" },
    });
    expect(c.relay.url).toBe("https://relay.example.com");
    expect(c.runtimes.local_llm).toBe("http://127.0.0.1:11434");
  });

  it("6.10 E-013：知らないキーは黙って無視しない（打ち間違いには近いキーを示す）", () => {
    const issue = expectE013(
      "aicoop.yaml",
      { company: COMPANY, daemon: { max_concurrent_box: 3 } },
      "daemon",
    );
    expect(issue.message).toContain("max_concurrent_box");
    expect(issue.message).toContain("もしかして：max_concurrent_box → max_concurrent_boxes");
    expect(issue.message).toContain("ここに書けるキー：home、port、max_concurrent_boxes");
  });

  it("6.10 E-013：型が違えば、期待する型を日本語で書く", () => {
    const issue = expectE013("aicoop.yaml", { company: COMPANY, task: "45" }, "task");
    expect(issue.message).toBe(
      'aicoop.yaml の task：キーと値の組で書いてください（いまの値："45"）',
    );
  });
});

// 6.3 groups.yaml
describe("6.3 groups.yaml", () => {
  it("6.3：省略したキーに表の既定値を入れる", () => {
    const c = ok("groups.yaml", { groups: { dev: { name: "開発部", box: "vm" } } });
    expect(c.groups.dev).toEqual({
      name: "開発部",
      box: "vm",
      memory_mib: 2048,
      cpus: 2,
      packages: [],
      can_request: [],
      ceiling: [],
    });
  });

  it("6.3：許可項目の mode の既定は allow", () => {
    const c = ok("groups.yaml", {
      groups: {
        dev: {
          name: "開発部",
          box: "vm",
          ceiling: [
            { op: "github.repo.read", params: { repo: ["myorg/*"] } },
            { op: "github.pr.merge", mode: "hold" },
          ],
        },
      },
    });
    expect(c.groups.dev?.ceiling.map((p) => p.mode)).toEqual(["allow", "hold"]);
  });

  it.each([
    ["groups.dev.box", { name: "開発部", box: "docker" }],
    ["groups.dev.memory_mib", { name: "開発部", box: "vm", memory_mib: 256 }],
    ["groups.dev.memory_mib", { name: "開発部", box: "vm", memory_mib: 16385 }],
    ["groups.dev.cpus", { name: "開発部", box: "vm", cpus: 9 }],
    ["groups.dev.name", { box: "vm" }],
    ["groups.dev.intake_member", { name: "開発部", box: "vm", intake_member: "Dev_Implementer" }],
    ["groups.dev.can_request.0", { name: "開発部", box: "vm", can_request: ["Sales"] }],
    [
      "groups.dev.ceiling.0.mode",
      { name: "開発部", box: "vm", ceiling: [{ op: "web.read", mode: "deny" }] },
    ],
    ["groups.dev.ceiling.0.op", { name: "開発部", box: "vm", ceiling: [{ op: "web" }] }],
    [
      "groups.dev.ceiling.0",
      { name: "開発部", box: "vm", ceiling: [{ op: "web.read", repo: "x" }] },
    ],
    // パッケージ名は image build で apk に渡すので、オプションに見えるものや空白を許さない
    ["groups.dev.packages.0", { name: "開発部", box: "vm", packages: ["--allow-untrusted"] }],
    ["groups.dev.packages.0", { name: "開発部", box: "vm", packages: ["nodejs npm"] }],
  ])("6.10 E-013：%s", (path, group) => {
    expectE013("groups.yaml", { groups: { dev: group } }, path);
  });

  it("6.10 E-013：box の選択肢を日本語で示す", () => {
    const issue = expectE013(
      "groups.yaml",
      { groups: { dev: { name: "開発部", box: "docker" } } },
      "groups.dev.box",
    );
    expect(issue.message).toBe(
      'groups.yaml の groups.dev.box：次のどれかにしてください：vm、srt、none（いまの値："docker"）',
    );
  });

  it.each(["Dev", "dev_team", "-dev", "a".repeat(41), "開発"])(
    "6.5：部署ID は英小文字・数字・ハイフンで1〜40文字（%s はエラー）",
    (id) => {
      const issue = expectE013(
        "groups.yaml",
        { groups: { [id]: { name: "x", box: "vm" } } },
        `groups.${id}`,
      );
      expect(issue.message).toContain("部署ID");
    },
  );

  it("6.5：40文字の部署ID は読める", () => {
    const id = "a".repeat(40);
    expect(
      ok("groups.yaml", { groups: { [id]: { name: "x", box: "vm" } } }).groups[id],
    ).toBeDefined();
  });

  it("6.10 E-013：groups がなければエラー", () => {
    expectE013("groups.yaml", {}, "groups");
  });
});

// 6.4 roles.yaml
describe("6.4 roles.yaml", () => {
  it("6.4：省略したキーに表の既定値を入れる", () => {
    const c = ok("roles.yaml", { roles: { implementer: { name: "実装担当" } } });
    expect(c.roles.implementer).toEqual({
      name: "実装担当",
      model: "sonnet",
      max_turns: 100,
      allow: [],
      tools: [],
      skills: [],
      can_request_humans: false,
    });
  });

  it("6.4：設計書の例の書き方を読める", () => {
    const c = ok("roles.yaml", {
      roles: {
        implementer: {
          name: "実装担当",
          model: "sonnet",
          max_turns: 150,
          allow: [{ op: "github.git.push", params: { repo: ["myorg/app"] } }],
          tools: [],
          skills: ["git-workflow"],
        },
        image: { name: "画像担当", allow: [], tools: ["generate_image"] },
        researcher: {
          name: "調査担当",
          tools: ["notion.search", "notion.*"],
          prompt: "roles/r.md",
        },
        ceo: { name: "CEO", model: "opus", allow: [], can_request_humans: true },
      },
    });
    expect(c.roles.implementer?.max_turns).toBe(150);
    expect(c.roles.researcher?.tools).toEqual(["notion.search", "notion.*"]);
  });

  it.each([
    ["roles.r.max_turns", { name: "x", max_turns: 0 }],
    ["roles.r.max_turns", { name: "x", max_turns: 501 }],
    ["roles.r.can_request_humans", { name: "x", can_request_humans: "yes" }],
    // 組み込み道具は自動で付くので書けない。書けるのは generate_image と上流の道具だけ
    ["roles.r.tools.0", { name: "x", tools: ["assign_task"] }],
    ["roles.r.tools.0", { name: "x", tools: ["notion"] }],
    ["roles.r.tools.0", { name: "x", tools: ["Notion.search"] }],
    ["roles.r.skills.0", { name: "x", skills: ["../secrets"] }],
    // --model に渡すので、オプションに見える値は許さない
    ["roles.r.model", { name: "x", model: "--dangerously-skip-permissions" }],
    ["roles.r.model", { name: "x", model: "" }],
    // prompt は prompts/ からの相対パスの md だけ
    ["roles.r.prompt", { name: "x", prompt: "../secrets.json" }],
    ["roles.r.prompt", { name: "x", prompt: "roles/../../secrets.md" }],
    ["roles.r.prompt", { name: "x", prompt: "/etc/passwd.md" }],
    ["roles.r.prompt", { name: "x", prompt: "C:/x.md" }],
    ["roles.r.prompt", { name: "x", prompt: "roles\\x.md" }],
    ["roles.r.prompt", { name: "x", prompt: "roles/x.txt" }],
    ["roles.r.prompt", { name: "x", prompt: "~/x.md" }],
  ])("6.10 E-013：%s", (path, role) => {
    expectE013("roles.yaml", { roles: { r: role } }, path);
  });
});

// 6.5 members.yaml
describe("6.5 members.yaml", () => {
  it("6.5：kind を省略すると ai", () => {
    const c = ok("members.yaml", {
      members: { "dev-implementer": { name: "実装AI", group: "dev", role: "implementer" } },
    });
    expect(c.members["dev-implementer"]).toEqual({
      kind: "ai",
      name: "実装AI",
      group: "dev",
      role: "implementer",
    });
  });

  it("6.5：kind: human の社員を読める（P6）", () => {
    const c = ok("members.yaml", {
      members: {
        "a-san": {
          kind: "human",
          name: "Aさん",
          company_id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YC",
          public_key: "pk-xxx",
        },
      },
    });
    expect(c.members["a-san"]?.kind).toBe("human");
  });

  it.each([
    ["members.m.group", { name: "x", role: "r" }],
    ["members.m.role", { name: "x", group: "g" }],
    ["members.m", { name: "x", group: "g", role: "r", company_id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YC" }],
    [
      "members.m.public_key",
      { kind: "human", name: "x", company_id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YC" },
    ],
    ["members.m.company_id", { kind: "human", name: "x", company_id: "x", public_key: "k" }],
    [
      "members.m",
      {
        kind: "human",
        name: "x",
        group: "g",
        company_id: "c_01JD6V8X3S0Q5W7KQ9M2T4R6YC",
        public_key: "k",
      },
    ],
  ])("6.10 E-013：%s", (path, member) => {
    expectE013("members.yaml", { members: { m: member } }, path);
  });

  it("6.10 E-013：kind の選択肢を示す", () => {
    const issue = expectE013(
      "members.yaml",
      { members: { m: { kind: "robot", name: "x" } } },
      "members.m.kind",
    );
    expect(issue.message).toBe(
      'members.yaml の members.m.kind：kind は次のどれかにしてください：ai、human（いまの値："robot"）',
    );
  });

  it("6.10 E-013：知らないキーには、その種類の社員に書けるキーを示す", () => {
    const issue = expectE013(
      "members.yaml",
      { members: { m: { name: "x", group: "g", role: "r", mangaes: "dev" } } },
      "members.m",
    );
    expect(issue.message).toContain("もしかして：mangaes → manages");
  });
});

// 6.6 triggers.yaml
describe("6.6 triggers.yaml", () => {
  const task = { purpose: "目的", done_when: "完了の条件" };

  it("6.6：省略したキーに既定値を入れる", () => {
    const c = ok("triggers.yaml", {
      triggers: [{ id: "t", type: "cron", schedule: "0 8 * * 1-5", member: "m", task }],
    });
    expect(c.triggers[0]).toEqual({
      id: "t",
      type: "cron",
      schedule: "0 8 * * 1-5",
      member: "m",
      enabled: true,
      task: { ...task, context: "", reply_as: "file" },
    });
  });

  it("6.6：triggers.yaml が空なら、トリガーはない", () => {
    expect(ok("triggers.yaml", {}).triggers).toEqual([]);
  });

  it("6.6：設計書の例の3種類を読める", () => {
    const c = ok("triggers.yaml", {
      triggers: [
        {
          id: "sales-morning",
          type: "cron",
          schedule: "0 8 * * 1-5",
          member: "sales-researcher",
          thread: "morning-prospecting",
          task: { purpose: "p", context: "c", done_when: "d" },
        },
        {
          id: "dev-issue",
          type: "github",
          events: ["issues.labeled"],
          filter: { repository: "myorg/app", label: "aicoop" },
          member: "dev-implementer",
          thread: "issue-{{issue.number}}",
          task: { purpose: "p", context: "c", done_when: "d" },
        },
        { id: "mailer-hold-result", type: "on_hold_resolved", member: "sales-mailer" },
      ],
    });
    expect(c.triggers.map((t) => t.type)).toEqual(["cron", "github", "on_hold_resolved"]);
  });

  it.each([
    ["triggers.0.type", { id: "t", type: "manual", member: "m", task }],
    ["triggers.0.schedule", { id: "t", type: "cron", member: "m", task }],
    ["triggers.0.task", { id: "t", type: "cron", schedule: "* * * * *", member: "m" }],
    [
      "triggers.0.task.done_when",
      { id: "t", type: "cron", schedule: "* * * * *", member: "m", task: { purpose: "p" } },
    ],
    [
      "triggers.0.task.reply_as",
      {
        id: "t",
        type: "cron",
        schedule: "* * * * *",
        member: "m",
        task: { ...task, reply_as: "mail" },
      },
    ],
    ["triggers.0.events", { id: "t", type: "github", member: "m", task }],
    ["triggers.0.events", { id: "t", type: "github", events: [], member: "m", task }],
    [
      "triggers.0.events.0",
      { id: "t", type: "github", events: ["issues.closed"], member: "m", task },
    ],
    [
      "triggers.0.filter.repository",
      {
        id: "t",
        type: "github",
        events: ["push"],
        filter: { repository: "app" },
        member: "m",
        task,
      },
    ],
    [
      "triggers.0.filter",
      { id: "t", type: "github", events: ["push"], filter: { repo: "a/b" }, member: "m", task },
    ],
    [
      "triggers.0.enabled",
      { id: "t", type: "cron", schedule: "* * * * *", member: "m", task, enabled: "no" },
    ],
    [
      "triggers.0.timeout_minutes",
      { id: "t", type: "cron", schedule: "* * * * *", member: "m", task, timeout_minutes: 0 },
    ],
    ["triggers.0.member", { id: "t", type: "cron", schedule: "* * * * *", task }],
    [
      "triggers.0.id",
      { id: "Sales Morning", type: "cron", schedule: "* * * * *", member: "m", task },
    ],
    // on_hold_resolved の目的とスレッドは固定（6.6）なので、書いても効かないものは書かせない
    ["triggers.0", { id: "t", type: "on_hold_resolved", member: "m", task }],
    ["triggers.0", { id: "t", type: "on_hold_resolved", member: "m", thread: "x" }],
  ])("6.10 E-013：%s", (path, trigger) => {
    expectE013("triggers.yaml", { triggers: [trigger] }, path);
  });

  it("6.10 E-013：type の選択肢を示す（manual などは設定に書かない）", () => {
    const issue = expectE013(
      "triggers.yaml",
      { triggers: [{ id: "t", type: "manual", member: "m" }] },
      "triggers.0.type",
    );
    expect(issue.message).toContain("cron、github、on_hold_resolved");
  });
});

// 6.8 mcp_servers.yaml
describe("6.8 mcp_servers.yaml", () => {
  it("6.8：設計書の例を読み、secret の既定は null", () => {
    const c = ok("mcp_servers.yaml", {
      servers: {
        notion: { url: "https://mcp.notion.com/mcp", secret: "notion" },
        local: { url: "http://127.0.0.1:3000/mcp" },
      },
    });
    expect(c.servers.notion?.secret).toBe("notion");
    expect(c.servers.local?.secret).toBeNull();
  });

  it.each([
    ["servers.notion.url", { url: "http://mcp.notion.com/mcp" }],
    ["servers.notion.url", { url: "mcp.notion.com" }],
    ["servers.notion", { url: "https://mcp.notion.com/mcp", token: "x" }],
  ])("6.10 E-013：%s（資格を載せる通信なので、外へは https だけ）", (path, server) => {
    expectE013("mcp_servers.yaml", { servers: { notion: server } }, path);
  });
});

// 6.9 host_tools.yaml
describe("6.9 host_tools.yaml", () => {
  const comfyui = {
    start: ["~/ComfyUI/.venv/bin/python", "main.py", "--listen", "127.0.0.1", "--port", "8188"],
    cwd: "~/ComfyUI",
    health: "http://127.0.0.1:8188/system_stats",
    stop: "SIGTERM",
    start_timeout_seconds: 120,
    custom_nodes_dir: "~/ComfyUI/custom_nodes",
    allowed_custom_nodes: [],
    presets_dir: "~/.aicoop/host_tools/comfyui/presets",
  };

  it("6.9：設計書の例を読める", () => {
    expect(ok("host_tools.yaml", { tools: { comfyui } }).tools.comfyui?.start[0]).toBe(
      "~/ComfyUI/.venv/bin/python",
    );
  });

  it("6.9：host_tools.yaml が空なら、ホストの道具はない", () => {
    expect(ok("host_tools.yaml", {}).tools).toEqual({});
  });

  it.each([
    ["tools", { tools: { comfyui, a1111: comfyui } }],
    [
      "tools.comfyui.health",
      { tools: { comfyui: { ...comfyui, health: "http://192.168.0.5:8188/" } } },
    ],
    ["tools.comfyui.stop", { tools: { comfyui: { ...comfyui, stop: "SIGHUP" } } }],
    ["tools.comfyui.start", { tools: { comfyui: { ...comfyui, start: [] } } }],
    [
      "tools.comfyui.start_timeout_seconds",
      { tools: { comfyui: { ...comfyui, start_timeout_seconds: 0 } } },
    ],
  ])("6.10 E-013：%s", (path, input) => {
    expectE013("host_tools.yaml", input, path);
  });
});
