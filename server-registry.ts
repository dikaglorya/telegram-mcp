/**
 * Server registry wrapper.
 *
 * All five tool modules previously called `server.registerTool(...)` directly,
 * which meant audit context, input validation and policy hooks had to be
 * repeated (and were repeatedly forgotten) in every handler.
 *
 * `wrapServer` returns a thin proxy that intercepts `registerTool` and:
 *   1. wraps the handler in `withToolContext`, so `guard()` can audit the tool
 *      name and the validated args without boilerplate;
 *   2. times the call and records `durationMs` in the audit line;
 *   3. normalizes anything thrown *outside* `guard` into a structured error,
 *      so a handler that forgets `guard` still returns isError instead of
 *      crashing the stdio server.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { withToolContext } from "./util.js";
import { normalizeError, formatError } from "./errors.js";

type ToolHandler = (args: any, extra?: any) => Promise<CallToolResult> | CallToolResult;

/** Replace the values of the given argument keys before any logging. */
function scrubArgs(args: unknown, keys: string[]): unknown {
  if (!keys.length || !args || typeof args !== "object") return args ?? {};
  const copy: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const key of keys) {
    if (key in copy) copy[key] = "[redacted]";
  }
  return copy;
}

type RegisterTool = (
  name: string,
  config: any,
  handler: ToolHandler,
) => any;

export function wrapServer(server: McpServer): McpServer {
  const original = server.registerTool.bind(server) as RegisterTool;

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

    const hardened = { ...(config as object), inputSchema: strictSchema((config as any)?.inputSchema) };

    const wrapped: ToolHandler = (args, extra) =>
      withToolContext({ tool: name, args: scrubArgs(args, secretArgs) }, async () => {
        try {
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
