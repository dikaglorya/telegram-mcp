/**
 * Higher-level Telegram workflows.
 *
 * The other tools expose Telegram verbs. These two expose *tasks* an agent is
 * usually asked to do: turn a busy chat into a briefing, and turn search hits
 * into an answer grouped by person and chat. They compose the same policy
 * checks, message shaping and read-back rules as the low-level tools.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "telegram";
import { getClient } from "./telegram.js";
import { getConfig } from "./config.js";
import { requireChat, shapeMessage, markedId } from "./helpers.js";
import { isAllowed } from "./policy.js";
import { normalizeError } from "./errors.js";
import { ok, fail, guard } from "./util.js";
import { buildBriefing, buildSearchReport, type WorkflowMessage } from "./workflow-core.js";

function isAuthError(err: unknown): boolean {
  const code = normalizeError(err).code;
  return code === "NO_SESSION" || code === "NOT_AUTHORIZED" || code === "AUTH_KEY_DUPLICATED";
}

function messageLink(resolved: { id: string; username?: string; type: string }, messageId: number): string {
  if (resolved.type === "user") {
    return `tg://openmessage?user_id=${resolved.id}&message_id=${messageId}`;
  }
  if (resolved.username) return `https://t.me/${resolved.username}/${messageId}`;
  return `https://t.me/c/${resolved.id}/${messageId}`;
}

function sinceMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function registerWorkflowTools(server: McpServer): void {
  server.registerTool(
    "telegram_briefing",
    {
      title: "Build a chat briefing",
      description:
        "Read one or more chats and return a structured briefing: activity per sender and per day, media " +
        "counts, question candidates with whether they got a direct reply, recent highlights, links, and " +
        "the most-viewed posts. This does the gathering and counting; the agent writes the prose. " +
        "Read-only, policy-checked, and limited to 10 chats x 100 messages per call.",
      inputSchema: {
        chats: z.array(z.string().min(1)).min(1).max(10).describe("Chats by @username, id, or exact title."),
        limit: z.number().int().min(1).max(100).default(50).describe("Messages to read per chat."),
        since: z
          .string()
          .min(1)
          .optional()
          .describe("Only include messages at or after this ISO date/time, e.g. 2026-10-01T00:00:00Z."),
        includeMessages: z
          .boolean()
          .default(false)
          .describe("Include the shaped messages themselves. Off by default to keep the answer small."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chats, limit, since, includeMessages }) =>
      guard(async () => {
        const cutoff = sinceMs(since);
        if (since && cutoff === null) {
          return fail(`invalid since value ${JSON.stringify(since)}; use an ISO date/time`);
        }

        const client = await getClient();
        const results: Array<Record<string, unknown>> = [];
        const errors: Array<{ chat: string; code: string; message: string }> = [];

        for (const chat of chats) {
          try {
            const resolved = await requireChat(client, chat);
            const raw = await client.getMessages(resolved.entity as any, { limit });
            const shaped = raw
              .filter((message: any) => {
                if (cutoff === null) return true;
                const date = Number(message?.date ?? 0) * 1000;
                return date >= cutoff;
              })
              .map(shapeMessage) as WorkflowMessage[];

            const briefing = buildBriefing(shaped, {
              linkFor: (messageId) => messageLink(resolved, messageId),
            });

            results.push({
              chat: {
                id: resolved.peerId || resolved.id,
                title: resolved.title,
                type: resolved.type,
              },
              ...briefing,
              ...(includeMessages ? { messages: shaped } : {}),
            });
          } catch (err) {
            if (isAuthError(err)) throw err;
            const normalized = normalizeError(err);
            errors.push({ chat, code: normalized.code, message: normalized.message });
          }
        }

        if (results.length === 0 && errors.length > 0) {
          return fail("could not read any of the requested chats", { errors });
        }

        return ok({
          generatedAt: new Date().toISOString(),
          since: since ?? null,
          chats: results,
          errors,
          count: results.reduce((sum, item) => sum + Number(item.count ?? 0), 0),
        });
      }),
  );

  server.registerTool(
    "telegram_search_intelligence",
    {
      title: "Search and group results by person and chat",
      description:
        "Full-text search across selected chats, or across every chat when `chats` is omitted. " +
        "Returns the matching messages plus groups by sender and by chat, a date range and media counts. " +
        "Optional filters: from (name/username/id substring), mediaType, minDate/maxDate (unix seconds). " +
        "Read-only; the flat results stay available so every claim can cite a message.",
      inputSchema: {
        query: z.string().min(1),
        chats: z
          .array(z.string().min(1))
          .max(10)
          .optional()
          .describe("Limit the search to these chats. Omit to search every chat."),
        limit: z.number().int().min(1).max(100).default(20).describe("Results per chat, or overall for global."),
        from: z.string().min(1).optional().describe("Keep hits whose sender name or id contains this text."),
        mediaType: z
          .string()
          .min(1)
          .optional()
          .describe("Keep hits whose media type contains this text, e.g. photo, document, webpage."),
        minDate: z.number().int().min(0).optional().describe("Unix seconds, inclusive."),
        maxDate: z.number().int().min(0).optional().describe("Unix seconds, inclusive."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, chats, limit, from, mediaType, minDate, maxDate }) =>
      guard(async () => {
        const client = await getClient();
        const hits: WorkflowMessage[] = [];
        const errors: Array<{ chat: string; code: string; message: string }> = [];
        const fromNeedle = from?.trim().toLowerCase() ?? null;
        const mediaNeedle = mediaType?.trim().toLowerCase() ?? null;

        const keep = (hit: WorkflowMessage): boolean => {
          const date = hit.date ? Date.parse(hit.date) : NaN;
          if (minDate !== undefined && (!Number.isFinite(date) || date < minDate * 1000)) return false;
          if (maxDate !== undefined && (!Number.isFinite(date) || date > maxDate * 1000)) return false;
          if (fromNeedle) {
            const haystack = `${hit.senderName ?? ""} ${hit.senderId ?? ""}`.toLowerCase();
            if (!haystack.includes(fromNeedle)) return false;
          }
          if (mediaNeedle) {
            const type = String(hit.media?.type ?? "").toLowerCase();
            if (!type.includes(mediaNeedle)) return false;
          }
          return true;
        };

        if (chats && chats.length > 0) {
          for (const chat of chats) {
            try {
              const resolved = await requireChat(client, chat);
              const raw = await client.getMessages(resolved.entity as any, { search: query, limit });
              const shaped = raw.map(shapeMessage) as WorkflowMessage[];
              for (const hit of shaped) {
                if (!keep(hit)) continue;
                hits.push({
                  ...hit,
                  chat: { id: resolved.peerId || resolved.id, title: resolved.title },
                });
              }
            } catch (err) {
              if (isAuthError(err)) throw err;
              const normalized = normalizeError(err);
              errors.push({ chat, code: normalized.code, message: normalized.message });
            }
          }
        } else {
          const result: any = await client.invoke(
            new Api.messages.SearchGlobal({
              q: query,
              filter: new Api.InputMessagesFilterEmpty(),
              minDate: minDate ?? 0,
              maxDate: maxDate ?? 0,
              offsetRate: 0,
              offsetPeer: new Api.InputPeerEmpty(),
              offsetId: 0,
              limit,
            } as any),
          );

          const chatObjects: any[] = Array.isArray(result?.chats) ? result.chats : [];
          const userObjects: any[] = Array.isArray(result?.users) ? result.users : [];
          const titles = new Map<string, string>();
          const ids = new Map<string, string>();
          for (const chat of chatObjects) {
            if (chat?.id === undefined) continue;
            titles.set(String(chat.id), chat.title ?? (chat.username ? `@${chat.username}` : ""));
            ids.set(String(chat.id), markedId(chat));
          }
          for (const user of userObjects) {
            if (user?.id === undefined) continue;
            titles.set(
              String(user.id),
              [user.firstName, user.lastName].filter(Boolean).join(" ") || `@${user.username ?? ""}`,
            );
            ids.set(String(user.id), markedId(user));
          }

          const rows: any[] = Array.isArray(result?.messages) ? result.messages : [];
          for (const row of rows) {
            if (typeof row?.id !== "number" || String(row?.className ?? "") === "MessageEmpty") continue;
            const peerKey = row?.peerId?.channelId ?? row?.peerId?.chatId ?? row?.peerId?.userId;
            const key = peerKey !== undefined ? String(peerKey) : null;
            const hit = shapeMessage(row) as WorkflowMessage;
            if (!keep(hit)) continue;
            // For global search, enforce allowlist on each hit.
            if (!chats || chats.length === 0) {
              const chatId = key !== null ? (ids.get(key) ?? key) : null;
              const chatTitle = key !== null ? (titles.get(key) ?? undefined) : undefined;
              if (chatId && !isAllowed(getConfig(), { id: chatId, title: chatTitle })) continue;
            }
            hits.push({
              ...hit,
              chat: {
                id: key !== null ? (ids.get(key) ?? key) : null,
                title: key !== null ? (titles.get(key) ?? null) : null,
              },
            });
          }
        }

        const report = buildSearchReport(query, hits.slice(0, 200));
        return ok({
          scope: chats && chats.length > 0 ? "chats" : "global",
          chats: chats ?? null,
          filters: { from: from ?? null, mediaType: mediaType ?? null, minDate: minDate ?? null, maxDate: maxDate ?? null },
          ...report,
          errors,
          truncated: hits.length > 200 ? hits.length - 200 : 0,
        });
      }),
  );
}
