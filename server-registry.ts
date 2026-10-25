/**
 * Server registry wrapper.
 *
 * Every tool module calls `server.registerTool(...)`; `wrapServer` intercepts
 * that call once and applies the same guards everywhere:
 *
 *   1. strict input schemas — an undeclared argument is refused, not dropped;
 *   2. access profiles — a read-only/messaging/moderator server refuses tools
 *      outside its profile before any Telegram call;
 *   3. human approval — risky writes can require a one-shot approval granted
 *      out-of-band (terminal or local control center);
 *   4. audit context, timing, secret-argument scrubbing;
 *   5. error normalization for handlers that forget `guard`.
 *
 * Keeping these in one place is the difference between a policy and a promise.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { withToolContext } from "./util.js";
import { normalizeError, formatError } from "./errors.js";
import {
  checkToolAccess,
  classifyTool,
  readAccessProfile,
  type AccessProfile,
  type AnnotationsLike,
  type ToolKind,
} from "./access.js";
import {
  consumeApproval,
  createApprovalRequest,
  readApprovalMode,
  requiresApproval,
} from "./approvals.js";
import { audit } from "./audit.js";

type ToolHandler = (args: any, extra?: any) => Promise<CallToolResult> | CallToolResult;

export type ToolMeta = {
  name: string;
  title: string;
  description: string;
  annotations: AnnotationsLike;
  kind: ToolKind;
  minimumProfile: AccessProfile;
  classified: boolean;
};

const catalogs = new WeakMap<object, ToolMeta[]>();

/** Replace the values of the given argument keys before any logging.
 *  Supports dot-notation paths (e.g., "credentials.password") for nested secrets.
 *  Recursively scrubs objects and arrays. */
function scrubArgs(args: unknown, keys: string[]): unknown {
  if (!keys.length || !args || typeof args !== "object") return args ?? {};

  // Parse dot-notation keys into path arrays
  const keyPaths = keys.map((k) => k.split(".").filter(Boolean));

  function deepScrub(value: unknown, depth = 0): unknown {
    if (depth > 10) return "[deep]"; // Prevent infinite recursion
    if (value === null || typeof value !== "object") return value;

    if (Array.isArray(value)) {
      return value.map((v) => deepScrub(v, depth + 1));
    }

    const out: Record<string, unknown> = {};
    const obj = value as Record<string, unknown>;

    for (const [k, v] of Object.entries(obj)) {
      // Check if this key matches any secret path
      const matchesSecret = keyPaths.some((path) => path[0] === k);
      if (matchesSecret) {
        // If path has more parts, recurse into the value
        const subPath = keyPaths
          .filter((path) => path[0] === k && path.length > 1)
          .map((path) => path.slice(1).join("."));
        if (subPath.length > 0) {
          out[k] = deepScrub(v, depth + 1);
        } else {
          out[k] = "[redacted]";
        }
      } else {
        out[k] = deepScrub(v, depth + 1);
      }
    }
    return out;
  }

  return deepScrub(args);
}

type RegisterTool = (
  name: string,
  config: any,
  handler: ToolHandler,
) => any;

function permissionDenied(
  name: string,
  profile: AccessProfile,
  required: AccessProfile,
  hint: string,
): CallToolResult {
  const text = [
    `[PERMISSION_DENIED] ${name} is not allowed by the current access profile.`,
    `current_profile: ${profile}`,
    `required_profile: ${required}`,
    `hint: ${hint}`,
  ].join("\n");
  const result: CallToolResult = {
    content: [{ type: "text", text }],
    isError: true,
  };
  (result as unknown as { _meta: unknown })._meta = {
    code: "PERMISSION_DENIED",
    profile,
    requiredProfile: required,
  };
  return result;
}

function approvalRequired(
  id: string,
  tool: string,
  expiresAt: string,
  preview: unknown,
): CallToolResult {
  const text = [
    `[APPROVAL_REQUIRED] ${tool} is waiting for a human decision.`,
    `approval_id: ${id}`,
    `expires_at: ${expiresAt}`,
    `approve_with: telegram-mcp approve ${id}`,
    `deny_with:    telegram-mcp deny ${id}`,
    `dashboard:    telegram-mcp dashboard`,
    "",
    "The call was NOT sent to Telegram. After approval, retry the exact same arguments.",
    "preview:",
    JSON.stringify(preview, null, 2),
  ].join("\n");
  const result: CallToolResult = {
    content: [{ type: "text", text }],
    isError: true,
  };
  (result as unknown as { _meta: unknown })._meta = {
    code: "APPROVAL_REQUIRED",
    approvalId: id,
    tool,
    expiresAt,
  };
  return result;
}

export function wrapServer(server: McpServer): McpServer {
  const original = server.registerTool.bind(server) as RegisterTool;
  const catalog: ToolMeta[] = [];
  catalogs.set(server, catalog);

  const access = readAccessProfile();
  const approval = readApprovalMode();

  /**
   * Reject undeclared arguments instead of dropping them.
   *
   * The SDK turns a raw shape into `z.object(shape)`, and a plain Zod object
   * *strips* unknown keys. A caller that sent `user` to a tool whose schema was
   * `{}` therefore got a normal, successful answer about a different subject
   * than the one it asked for: `telegram_full_user` returned the authorized
   * account's own profile — including its phone number — while the caller
   * believed it was reading somebody else's. Silent argument loss is a
   * correctness bug in every tool, so the shape is made strict here, once,
   * rather than relying on 69 handlers to notice.
   */
  const strictSchema = (inputSchema: unknown): unknown => {
    if (!inputSchema || typeof inputSchema !== "object") return inputSchema;
    // Already a Zod schema (has _def / _zod) — leave it alone.
    if ("_def" in (inputSchema as object) || "_zod" in (inputSchema as object)) return inputSchema;
    const shape = inputSchema as Record<string, unknown>;
    const values = Object.values(shape);
    const allZod = values.every(
      (v) => v && typeof v === "object" && ("_def" in (v as object) || "_zod" in (v as object)),
    );
    if (!allZod) return inputSchema;
    return z.object(shape as any).strict();
  };

  const registerTool: RegisterTool = (name, config, handler) => {
    // Args marked secret are replaced *before* they enter the audit context, so
    // the credential never reaches audit.log regardless of what the handler
    // does internally. Declared via `annotations.secretArgs` on the tool.
    const declared = (config as { _meta?: { secretArgs?: unknown } })?._meta?.secretArgs;
    const secretArgs: string[] = Array.isArray(declared) ? declared.map(String) : [];
    const annotations = ((config as { annotations?: AnnotationsLike })?.annotations ?? {}) as AnnotationsLike;
    const classification = classifyTool(name, annotations);

    catalog.push({
      name,
      title: String((config as { title?: unknown })?.title ?? name),
      description: String((config as { description?: unknown })?.description ?? ""),
      annotations,
      ...classification,
    });

    const hardened = { ...(config as object), inputSchema: strictSchema((config as any)?.inputSchema) };

    const wrapped: ToolHandler = (args, extra) =>
      withToolContext({ tool: name, args: scrubArgs(args, secretArgs) }, async () => {
        const scrubbed = scrubArgs(args, secretArgs);
        try {
          const decision = checkToolAccess(name, annotations, access.profile);
          if (!decision.allowed) {
            audit(name, scrubbed, "error", {
              code: "PERMISSION_DENIED",
              profile: access.profile,
              requiredProfile: decision.requiredProfile,
            });
            return permissionDenied(name, access.profile, decision.requiredProfile, decision.hint);
          }

          if (requiresApproval(approval.mode, name, annotations)) {
            const consumed = consumeApproval(name, scrubbed);
            if (!consumed) {
              let created;
              try {
                created = createApprovalRequest(name, scrubbed);
              } catch (err) {
                const e = err as Error & { code?: string; denied?: boolean; approvalId?: string };
                if (e.code === "APPROVAL_DENIED" && e.denied) {
                  audit(name, scrubbed, "error", { code: "APPROVAL_DENIED", approvalId: e.approvalId });
                  const text = [
                    `[APPROVAL_DENIED] ${name} was denied by the human.`,
                    `original_approval_id: ${e.approvalId}`,
                    `The call was NOT sent to Telegram. This denial is final for these exact arguments.`,
                    `To request approval again, change the arguments or ask the human to approve a fresh call.`,
                  ].join("\n");
                  const result: CallToolResult = {
                    content: [{ type: "text", text }],
                    isError: true,
                  };
                  (result as unknown as { _meta: unknown })._meta = {
                    code: "APPROVAL_DENIED",
                    approvalId: e.approvalId,
                  };
                  return result;
                }
                throw err;
              }
              audit(name, scrubbed, "error", {
                code: "APPROVAL_REQUIRED",
                approvalId: created.request.id,
              });
              return approvalRequired(
                created.request.id,
                name,
                created.request.expiresAt,
                created.request.argsPreview,
              );
            }
          }

          return await handler(args, extra);
        } catch (err) {
          const n = normalizeError(err);
          const result: CallToolResult = {
            content: [{ type: "text", text: formatError(n) }],
            isError: true,
          };
          return result;
        }
      });

    return original(name, hardened, wrapped);
  };

  Object.defineProperty(server, "registerTool", {
    value: registerTool,
    writable: true,
    configurable: true,
  });

  return server;
}

/** Metadata for every tool registered on this server, in registration order. */
export function getToolCatalog(server: McpServer): ToolMeta[] {
  return [...(catalogs.get(server) ?? [])];
}
