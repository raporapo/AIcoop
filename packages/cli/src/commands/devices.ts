/**
 * `aicoop devices` / `aicoop devices revoke <id>`（9.1、5.8、T-12）：承認アプリの端末の一覧・取り消し。
 *
 * 取り消した端末は、ログインも承認もできなくなり、ログイン中のセッションもすぐ無効になる（daemon が行う）。
 * 端末（TTY）から実行すると `[y/N]` で確かめる。スクリプトからは `--yes` を付ける。
 */
import type { DeviceView, ListDevicesResponse, RevokeDeviceResponse } from "@aicoop/daemon";
import { isId } from "@aicoop/shared";
import { apiFailure, DaemonClient } from "../api/client.ts";
import type { CommandInput } from "../command.ts";
import { CliError, UsageError } from "../errors.ts";
import { EXIT } from "../exit-codes.ts";
import { readTimezone, requireInitialized } from "../home.ts";
import { readLine } from "../stdin.ts";
import { renderTable } from "../ui/table.ts";
import { cleanLine } from "../ui/text.ts";
import { formatTime } from "../ui/time.ts";

const KIND_LABELS: Readonly<Record<string, string>> = { pc: "PC", phone: "スマホ" };

async function fetchDevices(input: CommandInput, client: DaemonClient): Promise<DeviceView[]> {
  try {
    return [...(await client.get<ListDevicesResponse>("/devices")).devices];
  } catch (e) {
    throw apiFailure(e, input.home);
  }
}

export async function runList(input: CommandInput): Promise<number> {
  const { home, values, out, ctx } = input;
  requireInitialized(home);
  const client = DaemonClient.connect(ctx, home);
  const devices = await fetchDevices(input, client);
  if (values.json === true) {
    out.line(JSON.stringify({ devices }, null, 2));
    return EXIT.ok;
  }
  if (devices.length === 0) {
    out.line("承認アプリの端末は、まだ登録されていません。");
    out.line("  この PC のブラウザを登録する：aicoop pair --local");
    return EXIT.ok;
  }
  const tz = await readTimezone(home);
  const style = out.style;
  out.lines(
    renderTable(
      [
        { header: "ID" },
        { header: "名前", flex: true },
        { header: "種類" },
        { header: `登録（${tz}）` },
        { header: "状態" },
      ],
      devices.map((d) => [
        cleanLine(d.id),
        cleanLine(d.name),
        KIND_LABELS[d.kind] ?? cleanLine(d.kind),
        formatTime(d.created_at, tz, { noYear: true }),
        d.revoked_at === null
          ? style.green("有効")
          : style.dim(`取り消し（${formatTime(d.revoked_at, tz, { noYear: true })}）`),
      ]),
      { style, width: out.columns },
    ),
  );
  if (devices.some((d) => d.revoked_at === null)) {
    out.line("");
    out.line(style.dim("取り消すとき：aicoop devices revoke <id>"));
  }
  return EXIT.ok;
}

function requireDeviceId(value: string | undefined): string {
  const v = (value ?? "").trim();
  const ok: boolean = isId(v, "device");
  if (!ok) {
    throw new UsageError(`端末の ID として読めません：${cleanLine(v.slice(0, 40))}`, [
      "d_ で始まる27文字の ID です（aicoop devices で確かめられます）",
    ]);
  }
  return v;
}

export async function runRevoke(input: CommandInput): Promise<number> {
  const { home, values, positionals, out, err, ctx } = input;
  const id = requireDeviceId(positionals[0]);
  requireInitialized(home);
  const client = DaemonClient.connect(ctx, home);
  const device = (await fetchDevices(input, client)).find((d) => d.id === id);
  if (device === undefined) {
    throw new CliError(EXIT.failure, `端末 ${id} はありません`, [
      "登録されている端末：aicoop devices",
    ]);
  }
  const name = cleanLine(device.name);
  if (device.revoked_at !== null) {
    throw new CliError(EXIT.failure, `端末「${name}」（${id}）は、すでに取り消されています`);
  }

  if (values.yes !== true) {
    if (!ctx.stdin.isTTY) {
      throw new UsageError("確かめられないので、取り消していません", [
        `取り消すなら --yes を付けてください：aicoop devices revoke ${id} --yes`,
      ]);
    }
    err.write(
      `端末「${name}」（${id}）を取り消します。この端末では、ログインも承認もできなくなります。よろしいですか？ [y/N] `,
    );
    const answer = (await readLine(ctx.stdin)).trim().toLowerCase();
    if (!["y", "yes", "はい"].includes(answer)) {
      err.line("取りやめました（取り消していません）");
      return EXIT.failure;
    }
  }

  let result: RevokeDeviceResponse;
  try {
    result = await client.post<RevokeDeviceResponse>(`/devices/${id}/revoke`, {});
  } catch (e) {
    throw apiFailure(e, home);
  }
  if (values.json === true) {
    out.line(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  out.line(
    `${out.style.green("✓")} 端末「${name}」を取り消しました。ログイン中のセッションも無効にしました`,
  );
  out.line(out.style.dim("    もう一度使うときは、aicoop pair --local で登録し直します"));
  return EXIT.ok;
}
