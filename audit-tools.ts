/**
 * Audit: read back the local call log this server writes for every tool call.
 *
 * The log was previously write-only — `audit.log` recorded every invocation but
 * no tool could read it, so an agent could not answer "what has been done to
 * this account today?" without shell access. This exposes the same file the
 * registry appends to, read-only.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getConfig } from "./config.js";
import { ok, fail, guard } from "./util.js";
import { readAuditPage, summarizeAudit } from "./audit-read.js";

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
        return ok(readAuditPage(file, { limit, tool, outcome }));
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
        const summary = summarizeAudit(file);
        if (!summary) {
          return fail(`no audit log yet at ${file} — nothing has been called through this server`);
        }
        return ok(summary);
      }),
  );
}
