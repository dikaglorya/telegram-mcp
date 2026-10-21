#!/usr/bin/env node
/**
 * Doctor: validate config, session presence, permissions, live connectivity.
 * Never prints secrets.
 *
 * Output is a framed report on stdout when run as a CLI — this is a human
 * command, not an MCP server, so stdout is free. Under `--quiet` (or when
 * piped) it prints one line per check with no colour, which is what CI wants.
 */
import "../env.js";
import fs from "node:fs";
import path from "node:path";
import { ensureDirs, getConfig, hasSession, readSessionString, redact } from "../config.js";
import { lockFile } from "../perms.js";
import { getClient, disconnect } from "../telegram.js";
import { banner, colorEnabled, gap, paint, sym, theme } from "../ui.js";

const out = (text: string): void => void process.stdout.write(text);

type Row = { pass: boolean; label: string; detail: string };

const rows: Row[] = [];

function record(pass: boolean, label: string, detail = ""): void {
  rows.push({ pass, label, detail });
}

function icon(pass: boolean): string {
  return pass ? theme.success(sym.ok) : theme.fail(sym.fail);
}

async function main(): Promise<void> {
  let failures = 0;
  let config;
  try {
    config = getConfig();
  } catch (err) {
    record(false, "config", err instanceof Error ? err.message : String(err));
    report();
    process.exit(1);
  }
  ensureDirs(config);
  record(
    true,
    "config",
    `api_id=${config.apiId}, allowAll=${config.allowAllChats}, allowlist=${config.allowlist.length}`,
  );
  record(fs.existsSync(path.dirname(config.sessionPath)), "state dir", path.dirname(config.sessionPath));

  const has = hasSession(config);
  record(has, "session present", config.sessionPath);
  if (!has) failures++;

  if (has) {
    if (process.platform === "win32") {
      record(true, "session permissions", "skipped on Windows (inherits user profile ACLs)");
    } else {
      try {
        const mode = fs.statSync(config.sessionPath).mode & 0o777;
        const good = (mode & 0o077) === 0;
        if (good) {
          record(true, "session permissions", `mode=${mode.toString(8)}`);
        } else {
          lockFile(config.sessionPath);
          const fixed = (fs.statSync(config.sessionPath).mode & 0o777 & 0o077) === 0;
          record(fixed, "session permissions", fixed ? "repaired to 600" : `mode=${mode.toString(8)}`);
          if (!fixed) failures++;
        }
      } catch (err) {
        record(false, "session permissions", err instanceof Error ? err.message : String(err));
        failures++;
      }
    }

    try {
      record(readSessionString(config).length > 0, "session readable");
    } catch (err) {
      record(false, "session readable", err instanceof Error ? err.message : String(err));
      failures++;
    }

    try {
      const client = await getClient();
      const authorized = await client.isUserAuthorized();
      record(authorized, "telegram authorized");
      if (authorized) {
        const me = (await client.getMe()) as unknown as Record<string, unknown>;
        record(true, "account", `id=${String(me.id ?? "")} username=${me.username ?? "none"}`);
      } else {
        failures++;
      }
      await disconnect();
    } catch (err) {
      record(false, "telegram connectivity", redact(err instanceof Error ? err.message : String(err)));
      failures++;
    }
  }

  report(failures);
  process.exit(failures === 0 ? 0 : 1);
}

function report(failures?: number): void {
  const plain = !colorEnabled() || process.argv.includes("--quiet");
  if (!plain) {
    banner({ subtitle: "health check", compact: true });
    gap();
  }
  const width = Math.max(...rows.map((r) => r.label.length));
  for (const row of rows) {
    if (plain) {
      out(`[${row.pass ? "PASS" : "FAIL"}] ${row.label}${row.detail ? ` - ${row.detail}` : ""}\n`);
    } else {
      const detail = row.detail ? `  ${theme.muted(row.detail)}` : "";
      // padEnd measures code units; the icon is one glyph, so this aligns.
      out(`  ${icon(row.pass)} ${theme.label(row.label.padEnd(width))}${detail}\n`);
    }
  }
  if (failures === undefined) return;
  if (plain) {
    out(failures === 0 ? "\nall checks passed.\n" : `\n${failures} check(s) failed.\n`);
    return;
  }
  gap();
  out(
    failures === 0
      ? `  ${theme.success(`${sym.ok} ${paint.bold("all checks passed")}`)}\n`
      : `  ${theme.fail(`${sym.fail} ${failures} check(s) failed`)}\n`,
  );
  if (failures !== 0 && hasHint()) {
    out(`  ${theme.muted(`${sym.bullet} run ${paint.bold("telegram-mcp login")} to issue a fresh session`)}\n`);
  }
}

function hasHint(): boolean {
  return rows.some((r) => !r.pass && /session|authorized/i.test(r.label));
}

main().catch((err) => {
  process.stderr.write(
    `${theme.fail(`[doctor] fatal: ${redact(err instanceof Error ? err.message : String(err))}`)}\n`,
  );
  process.exit(1);
});
