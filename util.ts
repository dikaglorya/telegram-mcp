/**
 * Tool result helpers. Every tool returns a CallToolResult; errors are
 * normalized (gramJS RPC codes -> stable codes + hints) and redacted.
 *
 * Auditing is owned by `guard`, and the tool name/args are supplied
 * automatically by `wrapHandler` in server-registry.ts, so an
 * `outcome:"error"` line is always written — the previous implementation only
 * ever recorded successful calls.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { redact } from "./config.js";
import { audit } from "./audit.js";
import { normalizeError, formatError } from "./errors.js";

/** Context injected by the registry so `guard` can audit without boilerplate. */
export type ToolContext = { tool: string; args: unknown };
const contextStack: ToolContext[] = [];

/** Run a tool handler with its audit context pushed. Internal. */
export async function withToolContext<T>(ctx: ToolContext, fn: () => Promise<T>): Promise<T> {
  contextStack.push(ctx);
  try {
    return await fn();
  } finally {
    contextStack.pop();
  }
}

function currentContext(): ToolContext {
  return contextStack[contextStack.length - 1] ?? { tool: "unknown", args: {} };
}

/**
 * Extract the part of a t.me link that Telegram's API accepts as `link`.
 *
 * `messages.EditExportedChatInvite` (revoking) wants the bare invite slug or the
 * full URL — but it rejects an invite wrapped in other text, so callers paste
 * what they copied from the app. Pulling out the `t.me/...` (or `telegram.me`,
 * `telegram.dog`) fragment keeps that working, and returning null for anything
 * else means the caller reports a clear error instead of a cryptic
 * `INVITE_HASH_EXPIRED`.
 */
export function inviteSlug(raw: string): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const match = text.match(/(?:https?:\/\/)?(?:t|telegram)\.(?:me|dog)\/(?:\+|joinchat\/)?([A-Za-z0-9_-]{8,})/i);
  if (match) return match[1];
  // A bare slug pasted from an export call.
  if (/^[A-Za-z0-9_-]{8,}$/.test(text)) return text;
  return null;
}

/**
 * Pull the newly created message ids out of an `Updates` response.
 *
 * gramJS's `_getResponseMessage` helper builds a plain object with no `id` for
 * several calls (that is how `forwardMessages` reported `[{id: undefined}]`), so
 * anything that needs the new id has to read the updates itself. Covers
 * UpdateNewMessage / UpdateNewChannelMessage / UpdateNewScheduledMessage, and
 * UpdateMessageID for the case where Telegram attaches no Message at all.
 */
export function idsFromUpdates(result: any): number[] {
  const ids: number[] = [];
  for (const u of Array.isArray(result?.updates) ? result.updates : []) {
    const fromMessage = typeof u?.message?.id === "number" ? u.message.id : undefined;
    const fromUpdate = u?.className === "UpdateMessageID" && typeof u?.id === "number" ? u.id : undefined;
    const id = fromMessage ?? fromUpdate;
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function ok(value: unknown): CallToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: redact(text) }] };
}

export function fail(error: string, extra?: Record<string, unknown>): CallToolResult {
  const payload = extra ? `${error}\n${JSON.stringify(extra, null, 2)}` : error;
  return { content: [{ type: "text", text: redact(payload) }], isError: true };
}

function failNormalized(err: unknown): CallToolResult {
  const n = normalizeError(err);
  const result: CallToolResult = {
    content: [{ type: "text", text: redact(formatError(n)) }],
    isError: true,
  };
  (result as unknown as { _meta: unknown })._meta = {
    code: n.code,
    retryable: n.retryable,
    retryAfterSec: n.retryAfterSec ?? null,
  };
  return result;
}

/**
 * Run a tool body with error normalization + auditing.
 *
 * FLOOD_WAIT is NOT auto-retried by replaying the body: `fn` is the whole tool
 * (resolve chat -> send -> read back), so re-running it after a mid-flight
 * flood wait can send the same message twice. Instead the error is returned
 * with `retryAfterSec`, and the agent decides.
 */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  const { tool, args } = currentContext();

  try {
    const result = await fn();

    if (result.isError) {
      audit(tool, args, "error", { error: firstText(result) });
      return result;
    }

    audit(tool, args, "ok");
    return result;
  } catch (err) {
    const n = normalizeError(err);
    audit(tool, args, "error", { code: n.code, message: n.message });
    return failNormalized(err);
  }
}

function firstText(result: CallToolResult): string {
  const first = result.content?.[0];
  return first && first.type === "text" ? first.text : "";
}
