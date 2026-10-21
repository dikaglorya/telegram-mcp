/**
 * Read-only extras that the toolset was missing: who administers a chat, what is
 * scheduled, the folder list, and translation.
 *
 * All four are reads, so they cost nothing to run and leave nothing behind —
 * which is also why they are the easiest tools to verify honestly.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "telegram";
import { getClient } from "./telegram.js";
import { requireChat, shapeMessage, markedId, withFloodRetry } from "./helpers.js";
import { ok, fail, guard } from "./util.js";

export function registerExtraTools(server: McpServer): void {
  server.registerTool(
    "telegram_chat_admins",
    {
      title: "List chat administrators",
      description:
        "List the admins of a group or channel with the rights each one holds and their custom " +
        "rank. Uses the dedicated admin filter, so it does not page through every member.",
      inputSchema: {
        chat: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, limit }) =>
      guard(async () => {
        const client = await getClient();
        const target = await requireChat(client, chat);
        if (target.type === "user") return fail(`${target.title ?? chat} is a user, not a group or channel`);

        const result: any = await client.invoke(
          new Api.channels.GetParticipants({
            channel: target.inputEntity as any,
            filter: new Api.ChannelParticipantsAdmins(),
            offset: 0,
            limit,
            hash: BigInt(0),
          } as any),
        );

        // Participants arrive as ChannelParticipant* variants. Admin ones carry
        // `adminRights`; `channelParticipantBanned` carries `bannedRights`
        // instead. There is no `rights` field on any variant — the old
        // `p?.adminRights ?? p?.rights` fallback could never fire. The creator
        // *does* carry `adminRights` (the comment here claimed otherwise), so
        // reading it is meaningful for creators too.
        //
        // `channels.channelParticipantsNotModified` has no `participants` field
        // at all. Reporting a missing list as "0 admins" is the same
        // accepted-and-nothing-happened lie this project keeps meeting, so an
        // unrecognised reply is said out loud instead.
        if (!Array.isArray(result?.participants)) {
          return fail("Telegram did not return a participant list for this chat", {
            chat: { id: target.peerId || target.id, title: target.title },
            reply: String(result?.className ?? "unknown"),
            admins: null,
          });
        }
        const participants: any[] = result.participants;
        const users: any[] = Array.isArray(result?.users) ? result.users : [];
        const byId = new Map<string, any>();
        for (const u of users) byId.set(String(u?.id), u);

        const admins = participants.map((p: any) => {
          const uid = String(p?.userId ?? "");
          const u = byId.get(uid);
          const rights = p?.adminRights ?? p?.bannedRights ?? null;
          const granted = rights
            ? Object.entries(rights)
                .filter(([, v]) => v === true)
                .map(([k]) => k)
            : [];
          return {
            id: uid || null,
            name: u ? [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || null : null,
            username: u?.username ?? null,
            role: p?.className?.replace("ChannelParticipant", "").toLowerCase() ?? null,
            rank: p?.rank || null,
            creator: Boolean(p?.className === "ChannelParticipantCreator"),
            rights: granted,
            // A creator's rights are implicit; listing none is correct, not a bug.
            rightsCount: granted.length,
          };
        });

        return ok({
          count: admins.length,
          chat: { id: target.peerId || target.id, title: target.title },
          admins,
        });
      }),
  );

  server.registerTool(
    "telegram_scheduled_messages",
    {
      title: "List scheduled messages",
      description:
        "List the messages queued to be sent later in a chat, with their planned send time. " +
        "Scheduling is done by the client; this reads back what is already queued.",
      inputSchema: {
        chat: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, limit }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const result: any = await client.invoke(
          new Api.messages.GetScheduledHistory({
            peer: resolved.inputEntity as any,
            hash: BigInt(0),
          } as any),
        );

        const messages: any[] = Array.isArray(result?.messages) ? result.messages : [];
        const shaped = messages.slice(0, limit).map((m) => ({
          ...shapeMessage(m),
          // The scheduled time is what makes this list useful; `date` on a queued
          // message is the intended send time, not when it was written.
          scheduledFor: m?.date ? new Date(Number(m.date) * 1000).toISOString() : null,
        }));

        return ok({
          count: shaped.length,
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
          messages: shaped,
        });
      }),
  );

  server.registerTool(
    "telegram_folders",
    {
      title: "List chat folders",
      description:
        "List the account's chat folders, with the peers each one includes and excludes. " +
        "A folder with no explicit peers is rule-based (e.g. all non-contacts).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const client = await getClient();
        const result: any = await client.invoke(new Api.messages.GetDialogFilters());
        const filters: any[] = Array.isArray(result?.filters) ? result.filters : [];

        // A folder's peers are a `Vector<InputPeer>`, and InputPeerUser /
        // InputPeerChannel / InputPeerChat carry an id and an access hash and
        // nothing else — no title, no firstName, no username. Reading those
        // fields off the peer returned null for every single one, so the tool
        // listed every folder member as an anonymous id. One dialogs call is the
        // cheapest place the names actually exist.
        const byId = new Map<string, { title: string; marked: string }>();
        try {
          const dialogs = await withFloodRetry(() => client.getDialogs({ limit: 500 }));
          for (const d of dialogs) {
            const e: any = d.entity;
            if (!e?.id) continue;
            byId.set(String(e.id), {
              title: String(
                e.title ??
                  [e.firstName, e.lastName].filter(Boolean).join(" ") ??
                  (e.username ? `@${e.username}` : ""),
              ),
              marked: markedId(e),
            });
          }
        } catch {
          // Leave the map empty: the ids still resolve, and each peer says why
          // its name is missing instead of printing a bare `null`.
        }

        const peerKey = (p: any) => String(p?.userId ?? p?.channelId ?? p?.chatId ?? p?.id ?? "");
        const peersOf = (list: any) =>
          (Array.isArray(list) ? list : []).map((p: any) => {
            const key = peerKey(p);
            const hit = byId.get(key);
            return {
              // A marked id, so it can be pasted straight into another tool. A
              // bare channel id cannot be resolved by a later process at all.
              id: hit?.marked ?? key,
              chatId: key,
              title: hit?.title ?? null,
              ...(hit ? {} : { unresolved: "not in this account's dialog list, so only its id is known" }),
            };
          });

        const folders = filters
          // FilterChatlist is a container, not a folder; only Filter carries a title.
          .filter((f) => typeof f?.title === "string" || f?.title?.text)
          .map((f) => ({
            id: f?.id ?? null,
            title: typeof f.title === "string" ? f.title : (f.title?.text ?? null),
            emoticon: f?.emoticon ?? null,
            pinnedPeers: peersOf(f?.pinnedPeers),
            includePeers: peersOf(f?.includePeers),
            excludePeers: peersOf(f?.excludePeers),
            // These are the rule flags that make a folder dynamic.
            rules: {
              contacts: Boolean(f?.contacts),
              nonContacts: Boolean(f?.nonContacts),
              groups: Boolean(f?.groups),
              broadcasts: Boolean(f?.broadcasts),
              bots: Boolean(f?.bots),
              excludeMuted: Boolean(f?.excludeMuted),
              excludeRead: Boolean(f?.excludeRead),
              excludeArchived: Boolean(f?.excludeArchived),
            },
          }));

        return ok({
          count: folders.length,
          folders,
          note: "the default 'All chats' folder is implicit and is not listed by Telegram",
        });
      }),
  );

  server.registerTool(
    "telegram_translate",
    {
      title: "Translate a message or a string",
      description:
        "Translate text using Telegram's own translation service. Pass chat+messageId to " +
        "translate an existing message, or text to translate a literal string. targetLang is " +
        "an ISO code such as 'id' or 'en'.",
      inputSchema: {
        chat: z.string().min(1).optional(),
        messageId: z.number().int().positive().optional(),
        text: z.string().min(1).optional(),
        targetLang: z.string().min(2).max(8).default("en"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, messageId, text, targetLang }) =>
      guard(async () => {
        if (!text && !(chat && messageId)) {
          return fail("pass text=<string> or chat + messageId");
        }

        const client = await getClient();
        const args: any = { toLang: targetLang };

        if (text) {
          args.text = [new Api.TextWithEntities({ text, entities: [] } as any)];
        } else {
          const resolved = await requireChat(client, chat as string);
          args.peer = resolved.inputEntity;
          args.id = [messageId];
        }

        const result: any = await client.invoke(new Api.messages.TranslateText(args));
        // The reply is messages.TranslateResult { result: TextWithEntities[] } —
        // an array of entities, not the `resultText`/`detectedLanguage` pair that
        // an older layer used. Reading the wrong field reported a successful
        // translation as `translated: null`, which is worse than an error.
        //
        // `detectedLanguage` was still being read from this reply long after that
        // comment was written: TranslateResult has exactly one field, so the value
        // was always null — a key that looked like a measurement and was a
        // constant. A field that is always null is worse than an absent one.
        const parts: any[] = Array.isArray(result?.result) ? result.result : [];
        const translated = parts.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n").trim();

        if (!translated) {
          // Not an error: Telegram answers with an empty string for messages it
          // cannot translate (stickers, media without a caption, very short or
          // emoji-only text). Failing here made a successful RPC look like a
          // defect, so say plainly that there was nothing to translate.
          return ok({
            targetLang,
            source: text ? { text } : { chat, messageId },
            translated: null,
            reason: "Telegram returned no translation for this content (nothing translatable)",
          });
        }

        return ok({
          targetLang,
          source: text ? { text } : { chat, messageId },
          translated,
        });
      }),
  );
}
