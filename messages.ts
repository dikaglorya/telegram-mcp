/**
 * Messages: read history, search, single fetch, send, edit, delete, forward,
 * react, pin/unpin, mark read, reply. Full access — no staging gate.
 */
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "telegram";
import { getClient } from "./telegram.js";
import { getConfig } from "./config.js";
import { lockFile } from "./perms.js";
import { requireChat, shapeMessage, markedId } from "./helpers.js";
import { ok, guard, fail, idsFromUpdates } from "./util.js";

/** Message random ids are 64-bit signed; gramJS accepts a Long-like value. */
function randomId(): any {
  return String(randomBytes(6).readUIntBE(0, 6));
}

export function registerMessageTools(server: McpServer): void {
  server.registerTool(
    "telegram_get_history",
    {
      title: "Get chat history",
      description:
        "Read recent messages from a chat. `chat` = @username, numeric id, or 'me'. Newest-first, max 100. " +
        "The answer carries `hasMore` and `nextOffsetId`: pass that id back as offsetId to page further " +
        "back. A page shorter than `limit` with `hasMore:false` means the history is exhausted.",
      inputSchema: {
        chat: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(30),
        offsetId: z.number().int().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, limit, offsetId }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        // Ask for one more than the caller wants. Telegram never says "that was
        // the last page", so without the extra row a full page and an exhausted
        // history are indistinguishable — the caller cannot tell whether to keep
        // paging or stop. At the documented maximum there is no room for the
        // extra row, and the tool says so instead of guessing.
        const probe = limit < 100 ? limit + 1 : limit;
        const messages = await client.getMessages(resolved.entity as any, { limit: probe, offsetId });
        const hasMore = messages.length > limit;
        const page = hasMore ? messages.slice(0, limit) : messages;
        const shaped = page.map(shapeMessage);
        const oldest = shaped.length ? Number(shaped[shaped.length - 1].id) : null;

        return ok({
          chat: { id: resolved.peerId || resolved.id, title: resolved.title, type: resolved.type },
          count: shaped.length,
          // `null` at the 100-message ceiling: the tool could not look past the
          // page it was allowed to fetch, so it does not claim to know.
          hasMore: limit < 100 ? hasMore : null,
          nextOffsetId: shaped.length && (hasMore || limit >= 100) ? oldest : null,
          messages: shaped,
        });
      }),
  );

  server.registerTool(
    "telegram_search_messages",
    {
      title: "Search messages",
      description:
        "Full-text search within a chat. Returns matching messages newest-first (max 100 per page). " +
        "The answer carries `hasMore` and `nextOffsetId` for paging deeper into the matches.",
      inputSchema: {
        chat: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
        offsetId: z.number().int().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, query, limit, offsetId }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        // Same one-extra-row trick as get_history: a search that matched 400
        // times used to look identical to one that matched 20, and there was no
        // way to reach the older matches at all.
        const probe = limit < 100 ? limit + 1 : limit;
        const messages = await client.getMessages(resolved.entity as any, { search: query, limit: probe, offsetId });
        const hasMore = messages.length > limit;
        const page = hasMore ? messages.slice(0, limit) : messages;
        const shaped = page.map(shapeMessage);
        const oldest = shaped.length ? Number(shaped[shaped.length - 1].id) : null;

        return ok({
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
          query,
          count: shaped.length,
          hasMore: limit < 100 ? hasMore : null,
          nextOffsetId: shaped.length && (hasMore || limit >= 100) ? oldest : null,
          results: shaped,
        });
      }),
  );

  server.registerTool(
    "telegram_get_message",
    {
      title: "Get single message",
      description: "Fetch one message by id from a chat.",
      inputSchema: {
        chat: z.string().min(1),
        messageId: z.number().int().positive(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, messageId }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const msg = await client.getMessages(resolved.entity as any, { ids: messageId });
        const first = msg[0];
        if (!first) return ok({ found: false, messageId });

        return ok(shapeMessage(first));
      }),
  );

  server.registerTool(
    "telegram_send_message",
    {
      title: "Send message",
      description:
        "Send a text message to a chat. Supports replyTo and topicId. Returns the new message id and sent:true. " +
        "Full access: sends immediately.",
      inputSchema: {
        chat: z.string().min(1),
        text: z.string().min(1).max(4096),
        replyTo: z.number().int().positive().optional(),
        topicId: z.number().int().positive().optional(),
        silent: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, text, replyTo, topicId, silent }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const sent: any = await client.sendMessage(resolved.entity as any, {
          message: text,
          replyTo,
          silent,
          ...(topicId ? { topMsgId: topicId } : {}),
        } as any);

        return ok({ sent: true, chat: { id: resolved.peerId || resolved.id, title: resolved.title }, messageId: sent?.id ?? null, text });
      }),
  );

  server.registerTool(
    "telegram_edit_message",
    {
      title: "Edit message",
      description: "Edit one of your own messages in a chat by message id.",
      inputSchema: {
        chat: z.string().min(1),
        messageId: z.number().int().positive(),
        text: z.string().min(1).max(4096),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, messageId, text }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const edited: any = await client.editMessage(resolved.entity as any, { message: messageId, text });

        return ok({ edited: true, messageId: edited?.id ?? messageId });
      }),
  );

  server.registerTool(
    "telegram_delete_messages",
    {
      title: "Delete messages",
      description: "Delete one or more messages in a chat by id. revoke=true deletes for everyone (your messages).",
      inputSchema: {
        chat: z.string().min(1),
        messageIds: z.array(z.number().int().positive()).min(1),
        revoke: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async ({ chat, messageIds, revoke }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);

        // Telegram accepts `messages.deleteMessages` for ids that do not exist
        // and answers with an empty `pts`-only update, so the call succeeds and
        // the message stays. Reporting `deleted: true` for that is a false
        // success: it tells the caller work happened when nothing did.
        // Read the ids back first, delete only what is really there, and say
        // which ids were not found instead of pretending they were removed.
        const present: number[] = [];
        const missing: number[] = [];
        const before = await client.getMessages(resolved.entity as any, { ids: messageIds });
        for (let i = 0; i < messageIds.length; i++) {
          const m = before[i];
          if (m && (m as any).id) present.push(messageIds[i]);
          else missing.push(messageIds[i]);
        }

        if (!present.length) {
          return ok({
            deleted: false,
            chat: resolved.title,
            messageIds: [],
            notFound: missing,
            reason: "none of those message ids exist in this chat",
          });
        }

        await client.deleteMessages(resolved.entity as any, present, { revoke });

        // Verify: a delete that Telegram silently ignored must not be reported
        // as done. Only ids confirmed gone count as deleted.
        let after: any[] = [];
        try {
          after = await client.getMessages(resolved.entity as any, { ids: present });
        } catch {
          after = [];
        }
        const stillThere = present.filter((_, i) => after[i] && (after[i] as any).id);
        const deleted = present.filter((id) => !stillThere.includes(id));

        return ok({
          deleted: stillThere.length === 0,
          chat: resolved.title,
          messageIds: deleted,
          ...(missing.length ? { notFound: missing } : {}),
          ...(stillThere.length ? { stillPresent: stillThere } : {}),
        });
      }),
  );

  server.registerTool(
    "telegram_forward_messages",
    {
      title: "Forward messages",
      description: "Forward messages by id from one chat to another.",
      inputSchema: {
        fromChat: z.string().min(1),
        toChat: z.string().min(1),
        messageIds: z.array(z.number().int().positive()).min(1),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ fromChat, toChat, messageIds }) =>
      guard(async () => {
        const client = await getClient();
        const from = await requireChat(client, fromChat);
        const to = await requireChat(client, toChat);

        // Go through the raw API rather than `client.forwardMessages`: gramJS
        // maps the response with `_getResponseMessage`, which for a forward
        // yields a plain object with no `id` field at all. The helper therefore
        // returned `[{id: undefined}]` for every call, so the new ids were never
        // reported and `count` hid it by falling back to the input length.
        const result: any = await client.invoke(
          new Api.messages.ForwardMessages({
            fromPeer: from.inputEntity as any,
            id: messageIds,
            toPeer: to.inputEntity as any,
          }),
        );

        const forwardedIds: number[] = [];
        for (const u of Array.isArray(result?.updates) ? result.updates : []) {
          // UpdateNewMessage / UpdateNewChannelMessage / UpdateNewScheduledMessage
          // carry the message itself; UpdateMessageID carries the freshly
          // assigned id when Telegram attaches no Message.
          const fromMessage = typeof u?.message?.id === "number" ? u.message.id : undefined;
          const fromUpdate = u?.className === "UpdateMessageID" && typeof u?.id === "number" ? u.id : undefined;
          const id = fromMessage ?? fromUpdate;
          if (id !== undefined && !forwardedIds.includes(id)) forwardedIds.push(id);
        }

        return ok({
          forwarded: true,
          to: to.title,
          count: forwardedIds.length,
          messageIds: forwardedIds,
        });
      }),
  );

  server.registerTool(
    "telegram_react",
    {
      title: "React to a message",
      description: "Send a reaction (emoji) to a specific message. Pass emoji 'none' or '' to clear reactions.",
      inputSchema: {
        chat: z.string().min(1),
        messageId: z.number().int().positive(),
        emoji: z.string().default("👍"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, messageId, emoji }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const clearing = !emoji || emoji === "none";
        const reaction = clearing ? new Api.ReactionEmpty() : new Api.ReactionEmoji({ emoticon: emoji });
        const sent: any = await client.invoke(
          new Api.messages.SendReaction({
            peer: resolved.inputEntity,
            msgId: messageId,
            reaction: [reaction],
          } as any),
        );

        // SendReaction answers with Updates, and a reaction the server silently
        // dropped (the account is not Premium, the emoji is not in the allowed
        // set, the message is too old) looks the same as one it applied. The
        // message's own `reactions` block is the only evidence: fetch it and
        // check for this emoji.
        let applied: boolean | null = null;
        let seen: string[] = [];
        try {
          const got: any = await client.getMessages(resolved.entity as any, { ids: [messageId] });
          const msg: any = Array.isArray(got) ? got[0] : null;
          if (msg && msg.id) {
            const results: any[] = Array.isArray(msg.reactions?.results) ? msg.reactions.results : [];
            seen = results
              .map((r: any) => String(r?.reaction?.emoticon ?? ""))
              .filter((s: string) => s.length > 0);
            applied = clearing ? !seen.includes("") : seen.length > 0;
            // A cleared message has no results at all; a reacted one lists the
            // emoji. Compare against what was asked for when possible.
            if (!clearing) applied = seen.includes(emoji) || seen.length > 0;
          }
        } catch {
          applied = null;
        }

        if (applied === false && !clearing) {
          return fail("Telegram accepted the reaction but the message shows none", {
            reacted: false,
            messageId,
            emoji,
            verified: true,
          });
        }

        return ok({
          reacted: !clearing,
          messageId,
          emoji: clearing ? null : emoji,
          verified: applied !== null,
          // Surface what the message actually shows, so a silently-ignored
          // reaction is visible instead of being reported as applied.
          ...(seen.length ? { reactionsOnMessage: seen } : {}),
          ...(sent?.className ? { update: sent.className } : {}),
        });
      }),
  );

  server.registerTool(
    "telegram_pin_message",
    {
      title: "Pin / unpin message",
      description: "Pin or unpin a message in a chat.",
      inputSchema: {
        chat: z.string().min(1),
        messageId: z.number().int().positive(),
        unpin: z.boolean().default(false),
        notify: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, messageId, unpin, notify }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        if (unpin) {
          await client.unpinMessage(resolved.entity as any, messageId);
        } else {
          await client.pinMessage(resolved.entity as any, messageId, { notify });
        }

        // A message carries its own pinned flag, so the read-back is direct:
        // fetch the message and look. `messages.updatePinnedMessage` accepts the
        // call and does nothing when the pin limit is reached or the message is
        // not pinnable (a service message, someone else's message in a chat where
        // this account is not admin), and the tool used to call that a success.
        let pinnedNow: boolean | null = null;
        try {
          const got: any = await client.getMessages(resolved.entity as any, { ids: [messageId] });
          const msg = Array.isArray(got) ? got[0] : null;
          if (msg && (msg as any).id) pinnedNow = Boolean((msg as any).pinned);
        } catch {
          pinnedNow = null;
        }

        const wanted = !unpin;
        if (pinnedNow !== null && pinnedNow !== wanted) {
          return fail(
            `Telegram accepted the call but the message is ${pinnedNow ? "still pinned" : "not pinned"}`,
            { pinned: pinnedNow, requested: wanted, messageId, verified: true },
          );
        }

        return ok({ pinned: pinnedNow === null ? wanted : pinnedNow, messageId, verified: pinnedNow !== null });
      }),
  );

  server.registerTool(
    "telegram_mark_read",
    {
      title: "Mark chat read",
      description: "Mark all messages in a chat as read.",
      inputSchema: { chat: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        await client.markAsRead(resolved.entity as any);

        // Read the unread counter back. markAsRead is fire-and-forget: it returns
        // nothing, and a chat with slowmode, a pending join request or a peer the
        // server does not consider readable stays unread without complaint.
        let unread: number | null = null;
        try {
          const dialogs: any = await client.invoke(
            new Api.messages.GetDialogs({ offsetDate: 0, offsetId: 0, offsetPeer: new Api.InputPeerEmpty(), limit: 200 } as any),
          );
          const want = String(resolved.id ?? resolved.peerId);
          const hit = (dialogs?.dialogs ?? []).find((d: any) => {
            const p = d?.peer;
            return String(p?.channelId ?? p?.chatId ?? p?.userId ?? "") === want;
          });
          unread = hit ? Number(hit.unreadCount ?? 0) : null;
        } catch {
          unread = null;
        }

        if (unread !== null && unread > 0) {
          return fail(`Telegram accepted markAsRead but the chat still shows ${unread} unread`, {
            read: false,
            unread,
            verified: true,
            chat: resolved.title,
          });
        }

        return ok({ read: true, verified: unread !== null, unread, chat: resolved.title });
      }),
  );

  server.registerTool(
    "telegram_typing",
    {
      title: "Show or clear the typing indicator",
      description:
        "Show 'typing…' in a chat for a few seconds, or clear it. Telegram expires the indicator on its " +
        "own; pass action 'cancel' to remove it immediately. Nothing is sent to the chat history.",
      inputSchema: {
        chat: z.string().min(1),
        action: z.enum(["typing", "cancel"]).default("typing"),
        topicId: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, action, topicId }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        // Both must be real Api action instances — gramJS serialises by class, and a
        // `{className: "SendMessageTypingAction"}` literal is rejected.
        const sendAction =
          action === "cancel" ? new Api.SendMessageCancelAction() : new Api.SendMessageTypingAction();
        await client.invoke(
          new Api.messages.SetTyping({
            peer: resolved.inputEntity as any,
            action: sendAction,
            ...(topicId ? { topMsgId: topicId } : {}),
          } as any),
        );

        return ok({ typing: action === "typing", action, chat: resolved.title });
      }),
  );

  server.registerTool(
    "telegram_unpin_all",
    {
      title: "Unpin every message",
      description: "Remove all pinned messages from a chat in one call.",
      inputSchema: { chat: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const result: any = await client.invoke(
          new Api.messages.UnpinAllMessages({ peer: resolved.inputEntity as any } as any),
        );

        // UnpinAllMessages answers AffectedHistory ({pts, ptsCount, offset}); the
        // offset is how many messages Telegram reports as affected.
        return ok({
          unpinnedAll: true,
          affected: typeof result?.offset === "number" ? result.offset : null,
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
        });
      }),
  );

  server.registerTool(
    "telegram_export_history",
    {
      title: "Export chat history to a file",
      description:
        "Dump a chat's message history to a JSON file in the export directory and return the path. " +
        "Useful for archiving or handing a full conversation to another tool. Newest-first, max 1000.",
      inputSchema: {
        chat: z.string().min(1),
        limit: z.number().int().min(1).max(1000).default(200),
        format: z.enum(["json", "jsonl", "txt"]).default("json"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, limit, format }) =>
      guard(async () => {
        const client = await getClient();
        const config = getConfig();
        const resolved = await requireChat(client, chat);

        const messages = await client.getMessages(resolved.entity as any, { limit });
        const shaped = messages.map(shapeMessage);

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const slug = String(resolved.title ?? "chat").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "chat";
        const file = path.join(config.exportDir, `${slug}_${stamp}.${format}`);

        const body =
          format === "jsonl"
            ? shaped.map((m) => JSON.stringify(m)).join("\n") + "\n"
            : format === "txt"
              ? shaped
                  .map((m) => `[${String(m.date ?? "")}] ${String(m.senderId ?? "?")}: ${String(m.text || "[media]")}`)
                  .join("\n") + "\n"
              : JSON.stringify(
                  { chat: { id: resolved.peerId || resolved.id, title: resolved.title, type: resolved.type }, exportedAt: new Date().toISOString(), count: shaped.length, messages: shaped },
                  null,
                  2,
                );

        fs.mkdirSync(config.exportDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o600 });
        lockFile(file);

        return ok({ exported: true, path: file, bytes: Buffer.byteLength(body, "utf8"), count: shaped.length, format });
      }),
  );

  server.registerTool(
    "telegram_message_link",
    {
      title: "Get a message's link",
      description:
        "Build the t.me link for one message, or for a whole chat when messageId is omitted. " +
        "Works for public and private chats — a private chat yields the /c/ form, which needs no username.",
      inputSchema: {
        chat: z.string().min(1),
        messageId: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, messageId }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const entity: any = resolved.entity;
        const internalId = entity?.id !== undefined ? String(entity.id) : "";

        // A message id that does not exist must not produce a link. Telegram
        // happily renders `t.me/name/999999999` and the caller has no way to
        // tell it points at nothing, so the id is verified first.
        if (messageId) {
          const found = await client.getMessages(resolved.entity as any, { ids: messageId });
          if (!found[0] || !(found[0] as any).id) {
            return ok({
              link: null,
              public: false,
              chat: { id: resolved.peerId || resolved.id, title: resolved.title, type: resolved.type },
              messageId,
              reason: "that message does not exist in this chat",
            });
          }
        }

        // A private chat is /c/<internal id>/<id>; a public one is
        // /username/<id>. A one-to-one user chat has no public message link at
        // all: `t.me/<username>/<id>` is a *channel post* URL, so returning it
        // for a user was a link to nowhere. The valid deep link for a user chat
        // is the tg:// form, which opens the message in the app.
        let link: string | null;
        let isPublic = false;
        if (resolved.type === "user") {
          link = messageId
            ? `tg://openmessage?user_id=${internalId}&message_id=${messageId}`
            : `tg://user?id=${internalId}`;
        } else if (resolved.username) {
          isPublic = true;
          link = messageId ? `https://t.me/${resolved.username}/${messageId}` : `https://t.me/${resolved.username}`;
        } else {
          link = messageId ? `https://t.me/c/${internalId}/${messageId}` : `https://t.me/c/${internalId}`;
        }

        return ok({
          link,
          public: isPublic,
          ...(resolved.type === "user"
            ? { reason: "one-to-one chats have no public link; this tg:// link opens the message in the Telegram app" }
            : {}),
          chat: { id: resolved.peerId || resolved.id, title: resolved.title, type: resolved.type },
          messageId: messageId ?? null,
        });
      }),
  );

  server.registerTool(
    "telegram_send_poll",
    {
      title: "Send a poll",
      description:
        "Send a poll. 2-10 answers. multipleChoice lets voters pick several; quiz makes it a quiz " +
        "(a correct answer index is required, 0-based). anonymous=false shows who voted.",
      inputSchema: {
        chat: z.string().min(1),
        question: z.string().min(1).max(255),
        answers: z.array(z.string().min(1).max(100)).min(2).max(10),
        multipleChoice: z.boolean().default(false),
        quiz: z.boolean().default(false),
        correctAnswer: z.number().int().min(0).max(9).optional(),
        anonymous: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, question, answers, multipleChoice, quiz, correctAnswer, anonymous }) =>
      guard(async () => {
        if (quiz && correctAnswer === undefined) return fail("a quiz needs correctAnswer (0-based index)");
        if (quiz && correctAnswer !== undefined && correctAnswer >= answers.length) {
          return fail(`correctAnswer ${correctAnswer} is out of range for ${answers.length} answers`);
        }
        const client = await getClient();
        const resolved = await requireChat(client, chat);

        // PollAnswer.option is a raw bytes value that only has to be unique and
        // stable; the index is the conventional choice.
        const pollAnswers = answers.map(
          (text, i) =>
            new Api.PollAnswer({
              text: new Api.TextWithEntities({ text, entities: [] } as any),
              option: Buffer.from([i]),
            } as any),
        );
        const poll = new Api.Poll({
          id: BigInt(Date.now()),
          question: new Api.TextWithEntities({ text: question, entities: [] } as any),
          answers: pollAnswers as any,
          publicVoters: !anonymous,
          multipleChoice,
          quiz,
          ...(quiz && correctAnswer !== undefined ? { correctAnswers: [Buffer.from([correctAnswer])] } : {}),
        } as any);

        const sent: any = await client.invoke(
          new Api.messages.SendMedia({
            peer: resolved.inputEntity as any,
            media: new Api.InputMediaPoll({ poll } as any),
            message: "",
            randomId: randomId(),
          } as any),
        );

        return ok({
          sent: true,
          messageId: idsFromUpdates(sent)[0] ?? null,
          question,
          answers,
          multipleChoice,
          quiz,
          anonymous,
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
        });
      }),
  );

  server.registerTool(
    "telegram_send_contact",
    {
      title: "Send a contact card",
      description: "Send a phone contact (vCard) into a chat. Nothing is saved to your contacts list.",
      inputSchema: {
        chat: z.string().min(1),
        phone: z.string().min(3).max(32),
        firstName: z.string().min(1).max(64),
        lastName: z.string().max(64).default(""),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, phone, firstName, lastName }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const media = new Api.InputMediaContact({
          phoneNumber: phone,
          firstName,
          lastName,
          vcard: "",
        } as any);
        const sent: any = await client.invoke(
          new Api.messages.SendMedia({
            peer: resolved.inputEntity as any,
            media,
            message: "",
            randomId: randomId(),
          } as any),
        );

        return ok({
          sent: true,
          messageId: idsFromUpdates(sent)[0] ?? null,
          contact: { phone, name: [firstName, lastName].filter(Boolean).join(" ") },
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
        });
      }),
  );

  server.registerTool(
    "telegram_pinned_messages",
    {
      title: "List pinned messages",
      description: "Read the messages currently pinned in a chat, with sender and text.",
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
        const pinned: any = await client.getMessages(resolved.entity as any, {
          filter: new Api.InputMessagesFilterPinned(),
          limit,
        } as any);
        const shaped = (Array.isArray(pinned) ? pinned : []).map(shapeMessage);

        return ok({
          count: shaped.length,
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
          messages: shaped,
        });
      }),
  );

  server.registerTool(
    "telegram_search_global",
    {
      title: "Search across every chat",
      description:
        "Full-text search over all chats at once (not one chat). Returns matches with the chat they " +
        "belong to, newest first. Optional minDate/maxDate (unix seconds) narrow the window. " +
        "Note: Telegram's own cursor can repeat rows between pages; that overlap is removed for you and " +
        "reported as `skippedRepeat`.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
        // Telegram pages this search with a server cursor (`offsetRate`), not by
        // an id: passing offsetId alone returns page one again, unchanged. The
        // cursor comes from the previous answer as `nextOffsetRate`.
        offsetRate: z.number().int().min(0).optional(),
        // The id the previous page ended on (`nextOffsetId`). Rows up to and
        // including it are dropped, which is what removes the overlap.
        offsetId: z.number().int().min(0).optional(),
        minDate: z.number().int().min(0).optional(),
        maxDate: z.number().int().min(0).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit, offsetRate, offsetId, minDate, maxDate }) =>
      guard(async () => {
        const client = await getClient();
        const result: any = await client.invoke(
          new Api.messages.SearchGlobal({
            q: query,
            filter: new Api.InputMessagesFilterEmpty(),
            minDate: minDate ?? 0,
            maxDate: maxDate ?? 0,
            offsetRate: offsetRate ?? 0,
            offsetPeer: new Api.InputPeerEmpty(),
            offsetId: offsetId ?? 0,
            limit,
          } as any),
        );

        // SearchGlobal returns Messages/MessagesSlice with a parallel `chats` and
        // `users` array; a message only carries the peer, not its title.
        const chats: any[] = Array.isArray(result?.chats) ? result.chats : [];
        const users: any[] = Array.isArray(result?.users) ? result.users : [];
        const titles = new Map<string, string>();
        for (const c of chats) titles.set(String(c?.id), c?.title ?? (c?.username ? `@${c.username}` : ""));
        for (const u of users) {
          titles.set(String(u?.id), [u?.firstName, u?.lastName].filter(Boolean).join(" ") || `@${u?.username ?? ""}`);
        }
        // A peer can be resolved even when the search returned no chat object for
        // it (a deleted account, a channel this account left); fall back to the
        // raw id rather than printing `title: null` with no way to identify it.
        const peerIds = new Map<string, string>();
        for (const c of chats) if (c?.id !== undefined) peerIds.set(String(c.id), markedId(c));
        for (const u of users) if (u?.id !== undefined) peerIds.set(String(u.id), markedId(u));

        const raw: any[] = Array.isArray(result?.messages) ? result.messages : [];
        // A search result can be a MessageEmpty placeholder: it has an id and
        // nothing else, and reporting it produced a blank row that looked like a
        // match the caller could not read.
        let rows = raw.filter((m) => typeof m?.id === "number" && String(m?.className ?? "") !== "MessageEmpty");

        // Telegram's rate cursor repeats rows, and not always just one: measured
        // pages came back with the previous page's last *two* messages. Passing
        // offsetId does not stop it. So drop everything up to and including the
        // caller's last-seen row — that is exactly the overlap, however long it is.
        let skipped = 0;
        if (offsetId !== undefined && rows.length) {
          const at = rows.findIndex((m) => Number(m?.id) === offsetId);
          // -1 means the whole page was already returned; dropping all of it is
          // the honest answer, and `skipped` says so rather than a silent empty.
          skipped = at >= 0 ? at + 1 : rows.length;
          rows = at >= 0 ? rows.slice(at + 1) : [];
        }

        const hits: any[] = rows.map((m) => {
          const rawPeerId = m?.peerId?.channelId ?? m?.peerId?.chatId ?? m?.peerId?.userId;
          const key = rawPeerId !== undefined ? String(rawPeerId) : null;
          return {
            ...shapeMessage(m),
            chat: {
              id: key !== null ? peerIds.get(key) ?? key : null,
              title: key !== null ? titles.get(key) ?? null : null,
            },
          };
        });

        const nextRate: number | null = result?.nextRate ?? null;
        return ok({
          query,
          count: hits.length,
          // How many rows the overlap cost on this page. Nothing is dropped
          // silently — a shorter page than asked for is visible, not mysterious.
          skippedRepeat: skipped,
          // The server's own total, the only honest answer to "how many are
          // there" — a page length cannot tell a search with 20 matches from one
          // with 215.
          totalMatches: typeof result?.count === "number" ? result.count : null,
          hasMore: nextRate !== null,
          nextOffsetRate: nextRate,
          // Hand back the last id so the next call can skip the boundary row.
          nextOffsetId: hits.length ? Number(hits[hits.length - 1].id) : null,
          results: hits,
        });
      }),
  );
}
