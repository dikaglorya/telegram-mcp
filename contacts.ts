/**
 * Contacts, user search, group/channel creation, invites. Full account ops.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "telegram";
import { getClient } from "./telegram.js";
import { enforce, markedId, resolveChat, invalidateDialogCache } from "./helpers.js";
import { ok, guard, fail } from "./util.js";

export function registerContactTools(server: McpServer): void {
  server.registerTool(
    "telegram_search_users",
    {
      title: "Search users",
      description: "Global search for users/chats by name or @username. Returns ids, usernames, types.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) =>
      guard(async () => {
        const client = await getClient();
        const res: any = await client.invoke(
          new Api.contacts.Search({ q: query, limit }),
        );
        const users = (res.users ?? []).map((u: any) => ({
          id: String(u.id ?? ""),
          username: u.username ?? null,
          name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null,
          bot: Boolean(u.bot),
        }));
        const chats = (res.chats ?? []).map((c: any) => ({
          // Marked id: a search result must be usable as the `chat` argument of
          // the next tool call, and a bare channel id is not.
          id: c?.id !== undefined ? markedId(c) : "",
          title: c.title ?? null,
          username: c.username ?? null,
          type: c.className ?? "chat",
        }));

        return ok({ count: users.length + chats.length, users, chats });
      }),
  );

  server.registerTool(
    "telegram_get_contacts",
    {
      title: "List contacts",
      description: "List saved contacts (id, name, username, phone).",
      inputSchema: { limit: z.number().int().min(1).max(1000).default(100) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) =>
      guard(async () => {
        const client = await getClient();
        const res: any = await client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) as any }));
        const users = (res.users ?? []).slice(0, limit).map((u: any) => ({
          id: String(u.id ?? ""),
          username: u.username ?? null,
          name: [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || null,
          phone: u.phone ?? null,
        }));

        return ok({ count: users.length, contacts: users });
      }),
  );

  server.registerTool(
    "telegram_add_contact",
    {
      title: "Add contact",
      description: "Save a Telegram user as a contact by @username or user id.",
      inputSchema: {
        user: z.string().min(1),
        firstName: z.string().min(1),
        lastName: z.string().default(""),
        phone: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ user, firstName, lastName, phone }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await resolveChat(client, user);
        // Same policy gate as every other chat-touching tool: without this,
        // add_contact could reach a chat the allowlist is meant to block.
        enforce(client, resolved);

        // contacts.AddContact only accepts an InputUser. `resolveChat` happily
        // resolves channels and groups too, which Telegram rejects with
        // "Cannot cast InputPeerChannel to any kind of InputUser".
        if (resolved.type !== "user") {
          return fail(
            `${resolved.title ?? user} is a ${resolved.type}, not a user. ` +
              `Contacts can only be Telegram accounts. Pass an @username, a phone number, or a user id.`,
            { resolved: { id: resolved.id, title: resolved.title, type: resolved.type } },
          );
        }

        const res: any = await client.invoke(
          new Api.contacts.AddContact({
            id: resolved.inputEntity as any,
            firstName,
            lastName,
            // `phone` is only meaningful when saving a number that is not yet on
            // Telegram; for an account already resolved by username or id an
            // empty string is the correct value. `addPhonePrivacyException` is
            // deliberately NOT sent: it is a privacy toggle for that number, not
            // part of saving a contact.
            phone: phone ?? "",
          } as any),
        );

        // The RPC answers with an Updates object whether or not the contact was
        // actually saved — saving a *bot* is accepted and silently ignored. So
        // the call returning is not evidence. Read the contact list back and
        // report what is really there: claiming `added: true` for a contact that
        // does not exist is the exact failure this project keeps fixing.
        let saved: { id: string; name: string | null } | null = null;
        try {
          const contacts: any = await client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) as any }));
          for (const c of contacts.contacts ?? []) {
            if (String(c.userId) !== String(resolved.id)) continue;
            const u = (contacts.users ?? []).find((x: any) => String(x.id) === String(resolved.id));
            saved = {
              id: String(c.userId),
              name: [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim() || c.firstName || null,
            };
            break;
          }
        } catch {
          // A failed read-back must not turn a successful save into an error;
          // `verified` simply stays false so the caller knows it was not checked.
          saved = null;
        }

        const users = (res?.users ?? []) as any[];
        const bot = Boolean(users.find((u) => String(u?.id) === String(resolved.id))?.bot);

        if (!saved) {
          return fail(
            `Telegram accepted the request but ${resolved.title ?? user} is not in the contact list, ` +
              `so nothing was saved.` +
              (bot
                ? ` Bots cannot be saved as contacts — that is a Telegram rule, not a permissions problem.`
                : ` Saving by id only works for an account this session has already seen; ` +
                  `pass an @username or a phone number instead.`),
            { user: resolved.title ?? null, id: resolved.id, bot },
          );
        }

        return ok({ added: true, verified: true, user: saved.name, id: saved.id, bot });
      }),
  );

  server.registerTool(
    "telegram_delete_contacts",
    {
      title: "Delete contacts",
      description:
        "Remove saved contacts by @username, user id, or numeric id. This is the inverse of " +
        "telegram_add_contact and may remove several at once. The account stays subscribed to " +
        "nothing new — it only forgets the saved contact entry.",
      inputSchema: {
        users: z.array(z.string().min(1)).min(1).describe("Users to forget, by @username or id."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ users }) =>
      guard(async () => {
        const client = await getClient();

        const entities = [];
        const resolvedNames: string[] = [];
        for (const u of users) {
          const resolved = await resolveChat(client, u);
          if (resolved.type !== "user") {
            return fail(
              `${resolved.title ?? u} is a ${resolved.type}, not a user. Only Telegram accounts can be contacts.`,
              { resolved: { id: resolved.id, title: resolved.title, type: resolved.type } },
            );
          }
          // Same allowlist gate as add_contact/create_group: forgetting someone
          // is still reaching that account.
          enforce(client, resolved);
          entities.push(resolved.inputEntity);
          resolvedNames.push(resolved.title ?? u);
        }

        const res: any = await client.invoke(
          new Api.contacts.DeleteContacts({ id: entities as any }),
        );

        return ok({
          deleted: true,
          users: resolvedNames,
          count: entities.length,
          // Telegram returns the contacts that still exist after the delete.
          remaining: (res?.users ?? []).length,
        });
      }),
  );

  server.registerTool(
    "telegram_create_group",
    {
      title: "Create a group",
      description: "Create a new group chat with the given users (by @username or id) and a title.",
      inputSchema: {
        title: z.string().min(1),
        users: z.array(z.string().min(1)).min(1),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ title, users }) =>
      guard(async () => {
        const client = await getClient();
        const entities = [];
        for (const u of users) {
          const resolved = await resolveChat(client, u);
          // Adding someone to a group you own is still reaching that person; it
          // must respect the same allowlist as every other chat-touching tool.
          enforce(client, resolved);
          entities.push(resolved.inputEntity);
        }
        const res: any = await client.invoke(
          new Api.channels.CreateChannel({
            title,
            about: "",
            megagroup: true,
            users: entities as any,
          } as any),
        );
        // Marked id, like every other tool returns. A bare channel id does not
        // match an allowlist entry and cannot be fed back into these tools.
        const rawId = res.chats?.[0]?.id;

        return ok({
          created: true,
          title,
          id: rawId !== undefined ? markedId({ id: rawId, className: "Channel" }) : null,
        });
      invalidateDialogCache();
      }),
  );

  server.registerTool(
    "telegram_create_channel",
    {
      title: "Create a channel",
      description: "Create a broadcast channel with the given title and optional description.",
      inputSchema: {
        title: z.string().min(1),
        about: z.string().max(255).default(""),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ title, about }) =>
      guard(async () => {
        const client = await getClient();
        const res: any = await client.invoke(
          new Api.channels.CreateChannel({ title, about, megagroup: false } as any),
        );
        // Marked id, like every other tool returns. A bare channel id does not
        // match an allowlist entry and cannot be fed back into these tools.
        const rawId = res.chats?.[0]?.id;

        return ok({
          created: true,
          title,
          id: rawId !== undefined ? markedId({ id: rawId, className: "Channel" }) : null,
        });
      invalidateDialogCache();
      }),
  );

  server.registerTool(
    "telegram_block_user",
    {
      title: "Block / unblock a user",
      description:
        "Block or unblock a user. A blocked user cannot message you or see your profile. " +
        "Pass unblock=true to reverse it.",
      inputSchema: {
        user: z.string().min(1),
        unblock: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ user, unblock }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await resolveChat(client, user);
        if (resolved.type !== "user") {
          return fail(`${resolved.title ?? user} is a ${resolved.type}, not a user — only users can be blocked`);
        }
        // Same allowlist rule as every other chat-taking tool: blocking is a real
        // change to the account, so it must not be a way around the policy.
        enforce(client, resolved);

        if (unblock) {
          await client.invoke(new Api.contacts.Unblock({ id: resolved.inputEntity as any } as any));
        } else {
          await client.invoke(new Api.contacts.Block({ id: resolved.inputEntity as any } as any));
        }

        // Read the block list back. `contacts.Block` and `Unblock` both return
        // `true` regardless of whether anything changed, so the call's own answer
        // says nothing — the same trap that made promote_admin and invite_members
        // report success for no-ops. Only the list knows.
        const id = String(resolved.peerId || resolved.id);
        const isBlockedNow = async (): Promise<boolean | null> => {
          try {
            const list: any = await client.invoke(new Api.contacts.GetBlocked({ offset: 0, limit: 100 } as any));
            const peers: any[] = Array.isArray(list?.blocked) ? list.blocked : [];
            const ids = peers.map((p: any) => String(p?.peerId?.userId ?? p?.peerId?.channelId ?? p?.peerId?.chatId ?? ""));
            return ids.includes(id);
          } catch {
            return null;
          }
        };

        const wanted = !unblock;
        const actual = await isBlockedNow();
        if (actual !== null && actual !== wanted) {
          return fail(
            `Telegram accepted the call but the user is still ${actual ? "blocked" : "unblocked"}`,
            {
              blocked: actual,
              requested: wanted,
              verified: false,
              user: { id: resolved.peerId || resolved.id, title: resolved.title, username: resolved.username ?? null },
            },
          );
        }

        return ok({
          blocked: wanted,
          verified: actual !== null,
          user: { id: resolved.peerId || resolved.id, title: resolved.title, username: resolved.username ?? null },
        });
      }),
  );

  server.registerTool(
    "telegram_list_blocked",
    {
      title: "List blocked users",
      description: "List the users this account has blocked (id, name, username, blocked-at).",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, offset }) =>
      guard(async () => {
        const client = await getClient();
        const result: any = await client.invoke(new Api.contacts.GetBlocked({ offset, limit } as any));

        // `blocked` holds PeerBlocked wrappers (peer + date); the users themselves
        // arrive in a parallel `users` array.
        const users: any[] = Array.isArray(result?.users) ? result.users : [];
        const byId = new Map<string, any>();
        for (const u of users) byId.set(String(u?.id), u);

        const entries = (Array.isArray(result?.blocked) ? result.blocked : []).map((b: any) => {
          const userId = b?.peerId?.userId ?? b?.peer?.userId;
          const u = userId !== undefined ? byId.get(String(userId)) : undefined;
          return {
            id: userId !== undefined ? String(userId) : null,
            name: [u?.firstName, u?.lastName].filter(Boolean).join(" ") || null,
            username: u?.username ?? null,
            blockedAt: b?.date ? new Date(Number(b.date) * 1000).toISOString() : null,
          };
        });

        return ok({ count: entries.length, offset, blocked: entries });
      }),
  );
}
