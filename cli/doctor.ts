#!/usr/bin/env node
/**
 * Doctor: validate config, session presence, permissions, live connectivity.
 * Prints pass/fail. Never prints secrets.
 */
import "../env.js";
import fs from "node:fs";
import path from "node:path";
import { ensureDirs, getConfig, hasSession, readSessionString, redact } from "../config.js";
import { lockFile } from "../perms.js";
import { getClient, disconnect } from "../telegram.js";

function line(okFlag: boolean, label: string, detail = ""): void {
  process.stdout.write(`[${okFlag ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}\n`);
}

async function main(): Promise<void> {
  let failures = 0;
  let config;
  try {
    config = getConfig();
  } catch (err) {
    line(false, "config", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  ensureDirs(config);
  line(true, "config", `api_id=${config.apiId}, allowAll=${config.allowAllChats}, allowlist=${config.allowlist.length}`);
  line(fs.existsSync(path.dirname(config.sessionPath)), "state dir", path.dirname(config.sessionPath));

  const has = hasSession(config);
  line(has, "session present", config.sessionPath);
  if (!has) failures++;

  if (has) {
    if (process.platform === "win32") {
      line(true, "session permissions", "skipped on Windows (inherits user profile ACLs)");
    } else {
      try {
        const mode = fs.statSync(config.sessionPath).mode & 0o777;
        const good = (mode & 0o077) === 0;
        line(good, "session permissions", `mode=${mode.toString(8)}`);
        if (!good) {
          lockFile(config.sessionPath);
          line(true, "session permissions", "repaired to 600");
        }
      } catch (err) {
        line(false, "session permissions", err instanceof Error ? err.message : String(err));
        failures++;
      }
    }

    try {
      line(readSessionString(config).length > 0, "session readable");
    } catch (err) {
      line(false, "session readable", err instanceof Error ? err.message : String(err));
      failures++;
    }

    try {
      const client = await getClient();
      const authorized = await client.isUserAuthorized();
      line(authorized, "telegram authorized");
      if (authorized) {
        const me = (await client.getMe()) as unknown as Record<string, unknown>;
        line(true, "account", `id=${String(me.id ?? "")} username=${me.username ?? "none"}`);
      } else {
        failures++;
      }
      await disconnect();
    } catch (err) {
      line(false, "telegram connectivity", redact(err instanceof Error ? err.message : String(err)));
      failures++;
    }
  }

  process.stdout.write(failures === 0 ? "\nall checks passed.\n" : `\n${failures} check(s) failed.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[doctor] fatal: ${redact(err instanceof Error ? err.message : String(err))}\n`);
  process.exit(1);
});
