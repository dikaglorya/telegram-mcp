/**
 * Audit: read back the local call log this server writes for every tool call.
 *
 * The log was previously write-only — `audit.log` recorded every invocation but
 * no tool could read it, so an agent could not answer "what has been done to
 * this account today?" without shell access. This exposes the same file the
 * registry appends to, read-only.
 */
import fs from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "./config.js";
import { ok, fail, guard } from "./util.js";

type AuditLine = {
  ts?: string;
  tool?: string;
  outcome?: string;
  args?: unknown;
  detail?: unknown;
};

export function registerAuditTools(server: McpServer): void {
  server.registerTool(
    "telegram_audit_log",
    {
      title: "Read the local audit log",
      description:
        "Read this server's own call log, newest first. Every tool call is appended with timestamp, " +
        "tool name, sanitized args and outcome; secrets are redacted at write time. Optional filters: " +
        "tool name and outcome ('ok' | 'error'). Purely local — nothing is read from Telegram.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50),
        tool: z.string().min(1).optional(),
        outcome: z.enum(["ok", "error"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, tool, outcome }) =>
      guard(async () => {
        const file = getConfig().auditLogPath;
        let raw = "";
        try {
          raw = fs.readFileSync(file, "utf8");
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return ok({ path: file, exists: false, count: 0, entries: [] });
          }
          throw err;
        }

        const lines = raw.split("\n").filter((l) => l.trim());
        const wanted = String(tool ?? "").toLowerCase();
        const entries: AuditLine[] = [];
        // Walk backwards: the newest calls are the interesting ones.
        for (let i = lines.length - 1; i >= 0 && entries.length < limit; i -= 1) {
          let parsed: AuditLine;
          try {
            parsed = JSON.parse(lines[i]) as AuditLine;
          } catch {
            // A half-written line from a crash is reported, not hidden.
            entries.push({ ts: undefined, tool: "(unparsable line)", outcome: "unknown", args: lines[i].slice(0, 200) });
            continue;
          }
          if (wanted && String(parsed.tool ?? "").toLowerCase() !== wanted) continue;
          if (outcome && parsed.outcome !== outcome) continue;
          entries.push(parsed);
        }

        return ok({
          path: file,
          exists: true,
          totalLines: lines.length,
          count: entries.length,
          filters: { tool: tool ?? null, outcome: outcome ?? null },
          entries,
        });
      }),
  );

  server.registerTool(
    "telegram_audit_summary",
    {
      title: "Summarize the audit log",
      description:
        "Counts per tool and per outcome from the local audit log, plus the first and last recorded call. " +
        "Use it to see what an agent has actually done to the account, without paging through entries.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const file = getConfig().auditLogPath;
        let raw = "";
        try {
          raw = fs.readFileSync(file, "utf8");
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return fail(`no audit log yet at ${file} — nothing has been called through this server`);
          }
          throw err;
        }

        const perTool: Record<string, { ok: number; error: number }> = {};
        const errorsByCode: Record<string, number> = {};
        let okCount = 0;
        let errorCount = 0;
        let unparsable = 0;
        let first: string | undefined;
        let last: string | undefined;

        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          let parsed: AuditLine;
          try {
            parsed = JSON.parse(line) as AuditLine;
          } catch {
            unparsable += 1;
            continue;
          }
          const name = String(parsed.tool ?? "(unknown)");
          perTool[name] = perTool[name] ?? { ok: 0, error: 0 };
          if (parsed.outcome === "error") {
            perTool[name].error += 1;
            errorCount += 1;
            const code = (parsed.detail as { code?: unknown } | undefined)?.code;
            if (typeof code === "string") errorsByCode[code] = (errorsByCode[code] ?? 0) + 1;
          } else {
            perTool[name].ok += 1;
            okCount += 1;
          }
          if (parsed.ts) {
            if (!first) first = parsed.ts;
            last = parsed.ts;
          }
        }

        const busiest = Object.entries(perTool)
          .map(([name, counts]) => ({ tool: name, ...counts, total: counts.ok + counts.error }))
          .sort((a, b) => b.total - a.total);

        return ok({
          path: file,
          calls: okCount + errorCount,
          ok: okCount,
          error: errorCount,
          unparsableLines: unparsable,
          firstCallAt: first ?? null,
          lastCallAt: last ?? null,
          errorsByCode,
          perTool: busiest,
        });
      }),
  );
}
