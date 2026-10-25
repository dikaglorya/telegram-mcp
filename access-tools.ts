/**
 * Visibility for the policy the server actually enforces.
 *
 * An agent that hits PERMISSION_DENIED or APPROVAL_REQUIRED needs to know why,
 * and the human needs to see the same answer without reading source code. This
 * tool reports the active profile, the approval mode, and exactly which tools
 * are allowed or denied. It never needs Telegram credentials and never returns
 * message content or secrets.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ACCESS_PROFILES,
  checkToolAccess,
  profileDescription,
  readAccessProfile,
} from "./access.js";
import { listApprovals, readApprovalMode } from "./approvals.js";
import { getToolCatalog } from "./server-registry.js";
import { ok, guard } from "./util.js";

export function registerAccessTools(server: McpServer): void {
  server.registerTool(
    "telegram_permissions",
    {
      title: "Show access profile and tool policy",
      description:
        "Report the access profile enforced by the server (readonly, messaging, moderator, full), " +
        "the human-approval mode, and which tools are allowed or denied right now. Purely local: " +
        "no Telegram connection, no secrets, no message content. Use this after a PERMISSION_DENIED " +
        "or APPROVAL_REQUIRED error instead of guessing.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const access = readAccessProfile();
        const approval = readApprovalMode();
        const catalog = getToolCatalog(server);

        const allowed: string[] = [];
        const denied: Array<{ tool: string; requiredProfile: string; kind: string }> = [];
        const unclassified: string[] = [];

        for (const tool of catalog) {
          if (!tool.classified) unclassified.push(tool.name);
          const decision = checkToolAccess(tool.name, tool.annotations, access.profile);
          if (decision.allowed) allowed.push(tool.name);
          else denied.push({ tool: tool.name, requiredProfile: decision.requiredProfile, kind: tool.kind });
        }

        const pending = listApprovals({ status: "pending", limit: 200 });
        const now = Date.now();
        const livePending = pending.filter((request) => Date.parse(request.expiresAt) > now);

        return ok({
          profile: access.profile,
          source: access.source,
          description: profileDescription(access.profile),
          error: access.error ?? null,
          approvalMode: approval.mode,
          approvalSource: approval.source,
          approvalError: approval.error ?? null,
          profiles: ACCESS_PROFILES.map((name) => ({ name, description: profileDescription(name) })),
          counts: {
            total: catalog.length,
            allowed: allowed.length,
            denied: denied.length,
            pendingApprovals: livePending.length,
            unclassified: unclassified.length,
          },
          allowedTools: allowed,
          deniedTools: denied,
          unclassifiedTools: unclassified,
          hint:
            "Profiles are enforced by the server before any Telegram request. " +
            "Change TELEGRAM_ACCESS_PROFILE in the MCP client environment and restart the server. " +
            "Approvals are granted out-of-band with `telegram-mcp approve <id>` or the local dashboard.",
        });
      }),
  );
}
