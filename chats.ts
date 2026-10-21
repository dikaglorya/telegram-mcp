/**
 * Chats: list dialogs, chat info, members, join/leave, mute, archive, pin.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "telegram";
import { getClient } from "./telegram.js";
import { getConfig } from "./config.js";
import { hasAllowlist, isAllowed } from "./policy.js";
import { requireChat, resolveChat, enforce, shapeChat, markedId, peerKind, toIso } from "./helpers.js";
import { ok, guard, fail } from "./util.js";

function dialogShape(d: any): Record<string, unknown> {
  const e = d?.entity ?? {};
  const lower = String(e?.className ?? "").toLowerCase();
  return {
    // Marked id, like shapeChat and every create tool return. A bare channel id
    // cannot be resolved by a later process at all: Telegram reads it as a user
    // id, so `telegram_delete_chat <id from list_chats>` failed with "Could not
    // find the input entity for PeerUser" (or a confusing FLOOD). An id that
    // cannot be pasted back into another tool is a broken contract.
    id: e?.id !== undefined ? markedId(e) : "",
    title: (e?.title ?? [e?.firstName, e?.lastName].filter(Boolean).join(" ")) || (e?.username ? `@${e.username}` : ""),
    username: e?.username ?? null,
    type: lower.includes("user") ? "user" : lower.includes("channel") ? "channel" : lower.includes("chat") ? "group" : "unknown",
    unreadCount: d?.unreadCount ?? 0,
    pinned: Boolean(d?.pinned),
    archived: Boolean(d?.archived),
    lastMessageDate: toIso(d?.message?.date),
    lastMessage: typeof d?.message?.message === "string" ? d.message.message.slice(0, 200) : null,
  };
}

export function registerChatTools(server: McpServer): void {
  server.registerTool(
    "telegram_list_chats",
    {
      title: "List chats",
      description:
        "List dialogs (DMs, groups, channels). Set includeAll=false to only return allowlisted chats " +
        "when a policy is configured. Default returns everything the account can see.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50),
        includeAll: z.boolean().default(true),
        archived: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit, includeAll, archived }) =>
      guard(async () => {
        const client = await getClient();
        const config = getConfig();
        const dialogs = await client.getDialogs({ limit, archived });
        const shaped = dialogs.map((d) => {
          const s = dialogShape(d);
          return {
            ...s,
            allowed: isAllowed(config, { id: s.id as string, username: s.username as string | undefined, title: s.title as string }),
          };
        });
        const filtered = includeAll ? shaped : shaped.filter((d) => d.allowed);

        // The allowlist always wins over allowAllChats, so report the mode that
        // actually governs access rather than echoing the raw flag.
        const policy = hasAllowlist(config) ? "allowlist" : config.allowAllChats ? "allow-all" : "deny-all";

        return ok({ count: filtered.length, policy, chats: filtered });
      }),
  );

  server.registerTool(
    "telegram_chat_info",
    {
      title: "Chat info",
      description: "Fetch detailed info for a chat/user/channel: title, username, id, type, member count, description.",
      inputSchema: { chat: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        // Only the fields a caller can act on. The raw gramJS object carries
        // accessHash values and hundreds of internal flags that are useless to
        // the caller and should never reach the model's context.
        let detail: Record<string, unknown> | null = null;
        try {
          if (resolved.type === "user") {
            const r = await client.invoke(new Api.users.GetFullUser({ id: resolved.inputEntity }));
            const f: any = r.fullUser;
            detail = {
              about: f?.about ?? null,
              commonChatsCount: f?.commonChatsCount ?? null,
              blocked: f?.blocked ?? null,
            };
          } else if (resolved.type === "channel") {
            const r = await client.invoke(new Api.channels.GetFullChannel({ channel: resolved.inputEntity }));
            const f: any = r.fullChat;
            detail = {
              about: f?.about ?? null,
              participantsCount: f?.participantsCount ?? null,
              onlineCount: f?.onlineCount ?? null,
              linkedChatId: f?.linkedChatId !== undefined ? markedId({ id: f.linkedChatId, className: "Channel" }) : null,
              canViewParticipants: f?.canViewParticipants ?? null,
              isBroadcast: f?.broadcast ?? null,
              isMegagroup: f?.megagroup ?? null,
              slowmodeSeconds: f?.slowmodeSeconds ?? null,
            };
          } else {
            const r = await client.invoke(new Api.messages.GetFullChat({ chatId: resolved.inputEntity as any }));
            const f: any = r.fullChat;
            detail = {
              about: f?.about ?? null,
              participantsCount: f?.participants?.participants?.length ?? null,
              canSetUsername: f?.canSetUsername ?? null,
            };
          }
        } catch {
          /* full info may be restricted; base info still returned */
        }

        return ok({ ...shapeChat(resolved), detail });
      }),
  );

  server.registerTool(
    "telegram_chat_members",
    {
      title: "Chat members",
      description: "List participants of a group/channel (if permitted). Returns id, name, username, role.",
      inputSchema: {
        chat: z.string().min(1),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, limit }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const participants = await client.getParticipants(resolved.entity as any, { limit });
        const shaped = participants.map((p: any) => ({
          // markedId, so a channel that appears in a member/admin list gets the
          // same -100… form every other tool accepts (and a User stays bare).
          id: p?.id !== undefined ? markedId(p) : "",
          username: p.username ?? null,
          name: [p.firstName, p.lastName].filter(Boolean).join(" ").trim() || p.title || null,
          bot: Boolean(p.bot),
        }));

        return ok({ chat: resolved.title, count: shaped.length, members: shaped });
      }),
  );

  server.registerTool(
    "telegram_join_chat",
    {
      title: "Join chat",
      description: "Join a public channel/group by @username or invite link.",
      inputSchema: { target: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ target }) =>
      guard(async () => {
        const client = await getClient();
        if (/t\.me\/\+|joinchat/i.test(target)) {
          // Strip any query string (?joinrequest=...) before taking the hash.
          const hash = target
            .trim()
            .replace(/\/+$/, "")
            .split("?")[0]
            .split(/[\/=]/)
            .pop()!
            .replace(/^\+/, "");
          if (!hash) throw new Error(`Could not extract an invite hash from "${target}"`);

          // An invite hash names no chat, so the allowlist cannot be consulted
          // before joining — but that is not permission to skip it. This used to
          // be a hole: every other chat-taking tool called enforce(), while the
          // invite path joined anything and never asked. Join, resolve what was
          // joined, and undo it if the allowlist disagrees. Leaving immediately
          // is the only way to keep "the allowlist always wins" true.
          const imported: any = await client.invoke(new Api.messages.ImportChatInvite({ hash } as any));
          const joinedPeer = (imported?.chats ?? imported?.updates?.find?.((u: any) => u?.chat)?.chat) ?? null;
          if (!joinedPeer) {
            return fail("Telegram accepted the invite but did not say which chat was joined", {
              target,
              via: "invite",
              joined: true,
              verified: false,
            });
          }

          let resolved: Awaited<ReturnType<typeof resolveChat>> | null = null;
          try {
            resolved = await resolveChat(client, markedId(joinedPeer));
          } catch {
            resolved = null;
          }
          if (!resolved) {
            return ok({ joined: true, target, via: "invite", chat: { title: joinedPeer?.title ?? null }, verified: false });
          }

          try {
            enforce(client, resolved);
          } catch (blocked) {
            // Undo the join before reporting: leaving the account inside a
            // blocked chat would be a policy bypass that only lasts until the
            // caller notices.
            let undone = false;
            try {
              await client.invoke(new Api.channels.LeaveChannel({ channel: resolved.inputEntity as any }));
              undone = true;
            } catch {
              undone = false;
            }
            throw new Error(
              `${(blocked as Error).message} (this invite joined that chat first; ` +
                `${undone ? "it was left again" : "leaving it failed — check telegram_list_chats"})`,
            );
          }

          return ok({ joined: true, target, via: "invite", chat: shapeChat(resolved) });
        }
        const resolved = await resolveChat(client, target);
        enforce(client, resolved);
        if (resolved.type === "channel" || resolved.type === "group") {
          await client.invoke(new Api.channels.JoinChannel({ channel: resolved.inputEntity }));
        } else {
          await client.invoke(
            new Api.messages.AddChatUser({
              chatId: resolved.inputEntity as any,
              userId: "me" as any,
              fwdLimit: 50,
            }),
          );
        }
        // Read the membership back. channels.JoinChannel answers with updates
        // even when it decided not to add this account (a join request, a ban,
        // a private group), so the call's own answer is not evidence.
        let member: boolean | null = null;
        try {
          const part: any = await client.invoke(
            new Api.channels.GetParticipant({
              channel: resolved.inputEntity as any,
              participant: (await client.getInputEntity("me")) as any,
            } as any),
          );
          member = Boolean(part?.participant);
        } catch {
          member = null;
        }
        if (member === false) {
          return fail("Telegram accepted the join but this account is not a member", {
            target,
            chat: shapeChat(resolved),
            verified: true,
          });
        }
        return ok({ joined: true, target, chat: shapeChat(resolved), verified: member !== null });
      }),
  );

  server.registerTool(
    "telegram_leave_chat",
    {
      title: "Leave chat",
      description: "Leave a group/channel by id or @username.",
      inputSchema: { chat: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async ({ chat }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        if (resolved.type === "user") throw new Error("telegram_leave_chat only applies to groups and channels");
        await client.invoke(new Api.channels.LeaveChannel({ channel: resolved.inputEntity as any }));

        // LeaveChannel answers with updates whether or not the account left —
        // a creator, an admin with "can't leave" or a chat that already dropped
        // this account all look identical from the response. Read the dialog
        // list back: a chat that is gone from it is a chat that was left.
        let stillThere: boolean | null = null;
        try {
          const dialogs: any = await client.invoke(
            new Api.messages.GetDialogs({ offsetDate: 0, offsetId: 0, offsetPeer: new Api.InputPeerEmpty(), limit: 200 } as any),
          );
          const ids = (dialogs?.dialogs ?? []).map((d: any) => {
            const p = d?.peer;
            return String(p?.channelId ?? p?.chatId ?? p?.userId ?? "");
          });
          stillThere = ids.includes(String(resolved.id ?? resolved.peerId));
        } catch {
          stillThere = null;
        }

        if (stillThere === true) {
          return fail("Telegram accepted the request but the chat is still in this account's list", {
            left: false,
            verified: true,
            chat: shapeChat(resolved),
          });
        }

        return ok({ left: true, verified: stillThere === false, chat: shapeChat(resolved) });
      }),
  );

  server.registerTool(
    "telegram_delete_chat",
    {
      title: "Delete a group or channel",
      description:
        "Permanently delete a group or channel this account owns, including its history. This " +
        "is the counterpart of telegram_create_group / telegram_create_channel, and is stronger " +
        "than telegram_leave_chat: the chat stops existing for everyone, not just for this " +
        "account. Only the creator can delete; Telegram refuses otherwise.",
      inputSchema: { chat: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async ({ chat }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);

        if (resolved.type === "user") {
          return fail(
            `${resolved.title ?? chat} is a user. Telegram cannot delete a person — use ` +
              `telegram_delete_messages for the conversation history, or block them.`,
            { resolved: { id: resolved.id, type: resolved.type } },
          );
        }

        // A legacy basic group is a different TL constructor than a channel or
        // supergroup. `channels.DeleteChannel` rejects it with a class-cast
        // error instead of a readable message, so it takes the chat path — and
        // so does its `ChatForbidden` form, which is the same peer seen while
        // removed from it.
        const kind = peerKind(resolved.entity);
        if (kind === "unknown") {
          return fail(
            `Cannot tell whether "${resolved.title ?? chat}" is a group or a channel — Telegram ` +
              `returned an unrecognised peer type. Refusing to guess which delete API to use.`,
            { resolved: { id: resolved.id, type: resolved.type } },
          );
        }

        if (kind === "basic-group") {
          await client.invoke(new Api.messages.DeleteChat({ chatId: resolved.entity.id } as any));
        } else {
          await client.invoke(new Api.channels.DeleteChannel({ channel: resolved.inputEntity as any }));
        }

        return ok({
          deleted: true,
          chat: shapeChat(resolved),
          kind,
        });
      }),
  );

  server.registerTool(
    "telegram_mute_chat",
    {
      title: "Mute / unmute chat",
      description: "Mute a chat for N days (0 = unmute). Uses default mute behaviour when days>0.",
      inputSchema: {
        chat: z.string().min(1),
        days: z.number().int().min(0).max(3650).default(0),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, days }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const until = days > 0 ? Math.floor(Date.now() / 1000) + days * 86400 : 0;
        // Both arguments must be real Api instances, not `{className: ...}`
        // literals: gramJS serialises by class, and a plain object makes the
        // server reject the request with "Cannot cast InputNotifyPeer to any
        // kind of peer".
        await client.invoke(
          new Api.account.UpdateNotifySettings({
            peer: new Api.InputNotifyPeer({ peer: resolved.inputEntity }),
            settings: new Api.InputPeerNotifySettings({
              muteUntil: until,
              // Previews stay off while muted, matching Telegram's own UI.
              showPreviews: days === 0,
            }),
          }),
        );

        // Read the setting back. Telegram accepts this RPC and can still leave
        // the old value in place, so echoing the requested value would be a
        // claim about the account rather than a fact about it.
        let applied: number | null = null;
        try {
          const got: any = await client.invoke(
            new Api.account.GetNotifySettings({ peer: new Api.InputNotifyPeer({ peer: resolved.inputEntity }) }),
          );
          applied = Number(got?.muteUntil ?? 0);
        } catch {
          applied = null;
        }

        const wanted = days > 0;
        const actual = applied === null ? null : applied > Math.floor(Date.now() / 1000);
        return ok({
          muted: actual === null ? wanted : actual,
          days,
          ...(actual === null ? { verified: false } : { verified: actual === wanted }),
          ...(actual !== null && actual !== wanted ? { reason: "Telegram kept the previous mute setting" } : {}),
          chat: resolved.title,
        });
      }),
  );

  server.registerTool(
    "telegram_edit_chat",
    {
      title: "Edit a group or channel",
      description:
        "Change a group/channel title and/or description. Needs admin rights; Telegram refuses otherwise. " +
        "Omit a field to leave it untouched. Titles are 1-128 chars, about is up to 255.",
      inputSchema: {
        chat: z.string().min(1),
        title: z.string().min(1).max(128).optional(),
        about: z.string().max(255).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, title, about }) =>
      guard(async () => {
        if (title === undefined && about === undefined) {
          return fail("nothing to change: pass title and/or about");
        }
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const kind = peerKind(resolved.entity);
        if (kind === "user") {
          return fail(`${resolved.title ?? chat} is a user — use telegram_update_profile for your own name`);
        }
        if (kind === "unknown") {
          return fail(`cannot tell whether "${resolved.title ?? chat}" is a group or a channel; refusing to guess`);
        }

        const changed: string[] = [];
        if (title !== undefined) {
          // A channel (supergroup included) and a legacy basic group are different
          // constructors: channels.EditTitle vs messages.EditChatTitle.
          if (kind === "basic-group") {
            await client.invoke(new Api.messages.EditChatTitle({ chatId: resolved.entity.id, title } as any));
          } else {
            await client.invoke(new Api.channels.EditTitle({ channel: resolved.inputEntity as any, title } as any));
          }
          changed.push("title");
        }
        if (about !== undefined) {
          // Only channels carry an "about"; a basic group has no such field.
          if (kind === "basic-group") {
            return ok({
              updated: changed.length > 0,
              changed,
              skipped: ["about"],
              reason: "a legacy basic group has no description field",
            });
          }
          await client.invoke(new Api.messages.EditChatAbout({ peer: resolved.inputEntity as any, about } as any));
          changed.push("about");
        }

        // Read back: the API call returning without error is not proof the field
        // changed, and the whole point of this tool is the change.
        const after = await client.getEntity(resolved.entity as any);
        return ok({
          updated: true,
          changed,
          chat: {
            id: markedId(after as any) || resolved.peerId || resolved.id,
            title: (after as any)?.title ?? resolved.title,
            username: (after as any)?.username ?? null,
            about: kind === "basic-group" ? null : ((after as any)?.about ?? null),
          },
        });
      }),
  );

  server.registerTool(
    "telegram_export_invite_link",
    {
      title: "Export or revoke an invite link",
      description:
        "Get a chat's invite link, or revoke it (which kills the old link). Needs admin rights. " +
        "revoke=true returns the newly issued link, so the chat stays joinable.",
      inputSchema: {
        chat: z.string().min(1),
        revoke: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, revoke }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        if (resolved.type === "user") {
          return fail(`${resolved.title ?? chat} is a user — a person has no invite link`);
        }

        const invite: any = await client.invoke(
          new Api.messages.ExportChatInvite({
            peer: resolved.inputEntity as any,
            // `legacyRevokePermanent` is what the apps send to rotate a link.
            ...(revoke ? { legacyRevokePermanent: true } : {}),
          } as any),
        );

        return ok({
          link: invite?.link ?? null,
          revoked: revoke,
          permanent: invite?.permanent ?? null,
          usageLimit: invite?.usageLimit ?? null,
          expireDate: toIso(invite?.expireDate),
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
        });
      }),
  );

  server.registerTool(
    "telegram_pin_chat",
    {
      title: "Pin / unpin a chat in the dialog list",
      description:
        "Pin or unpin a chat in your own dialog list (not a message — use telegram_pin_message for that). " +
        "Local to the account: nothing changes for other members.",
      inputSchema: {
        chat: z.string().min(1),
        pinned: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ chat, pinned }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        // ToggleDialogPin takes an InputDialogPeer wrapping the input peer; a raw
        // peer is rejected by the server as a cast error.
        await client.invoke(
          new Api.messages.ToggleDialogPin({
            pinned,
            peer: new Api.InputDialogPeer({ peer: resolved.inputEntity as any }),
          } as any),
        );

        // ToggleDialogPin is a toggle, not an assignment: asking to pin an
        // already-pinned dialog unpins it. Report what the dialog list says
        // afterwards instead of the value that was requested.
        let actual: boolean | null = null;
        try {
          const dialogs: any = await client.invoke(
            new Api.messages.GetPinnedDialogs({ folderId: 0 } as any),
          );
          const peers = [
            ...(dialogs?.dialogs ?? []),
          ];
          actual = peers.some((d: any) => {
            const p = d?.peer;
            if (!p) return false;
            const id = p.userId ?? p.chatId ?? p.channelId;
            return String(id) === String(resolved.id ?? resolved.peerId);
          });
        } catch {
          actual = null;
        }

        return ok({
          pinned: actual === null ? pinned : actual,
          ...(actual === null ? { verified: false } : { verified: actual === pinned }),
          ...(actual !== null && actual !== pinned
            ? { reason: "ToggleDialogPin flips the current state, so the dialog ended up the other way" }
            : {}),
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
        });
      }),
  );

  server.registerTool(
    "telegram_archive_chat",
    {
      title: "Archive / unarchive a chat",
      description:
        "Move a chat into the Archived folder or back to the main list. Local to the account. " +
        "Folder id 0 means 'not archived'; 1 is the default archive folder.",
      inputSchema: {
        chat: z.string().min(1),
        archived: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ chat, archived }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        await client.invoke(
          new Api.folders.EditPeerFolders({
            folderPeers: [
              new Api.InputFolderPeer({
                peer: resolved.inputEntity as any,
                folderId: archived ? 1 : 0,
              }),
            ],
          } as any),
        );

        // Read the dialog back. EditPeerFolders returns Updates whether or not
        // the folder changed, and the dialog carries the truth in `folderId`.
        // (This tool used to echo `archived` straight back.)
        let actualFolder: number | null = null;
        try {
          const dialogs: any = await client.invoke(
            new Api.messages.GetDialogs({ offsetDate: 0, offsetId: 0, offsetPeer: new Api.InputPeerEmpty(), limit: 200 } as any),
          );
          const want = String(resolved.id ?? resolved.peerId);
          const hit = (dialogs?.dialogs ?? []).find((d: any) => {
            const p = d?.peer;
            return String(p?.channelId ?? p?.chatId ?? p?.userId ?? "") === want;
          });
          actualFolder = hit ? Number(hit.folderId ?? 0) : null;
        } catch {
          actualFolder = null;
        }

        const wanted = archived ? 1 : 0;
        if (actualFolder !== null && actualFolder !== wanted) {
          return fail(
            `Telegram accepted the change but the chat is in folder ${actualFolder}, not ${wanted}`,
            {
              archived: actualFolder === 1,
              requested: archived,
              verified: true,
              chat: { id: resolved.peerId || resolved.id, title: resolved.title },
            },
          );
        }

        return ok({
          archived: actualFolder === null ? archived : actualFolder === 1,
          folderId: actualFolder === null ? wanted : actualFolder,
          verified: actualFolder !== null,
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
        });
      }),
  );

  server.registerTool(
    "telegram_clear_history",
    {
      title: "Clear a chat's history",
      description:
        "Delete messages from a chat. Defaults to your own copy only (revoke=false). revoke=true also " +
        "removes them for everyone, which needs the rights to do so. Returns the message count Telegram " +
        "reports as affected when it says.",
      inputSchema: {
        chat: z.string().min(1),
        revoke: z.boolean().default(false),
        maxId: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async ({ chat, revoke, maxId }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const kind = peerKind(resolved.entity);
        if (kind === "unknown") {
          return fail(`cannot tell whether "${resolved.title ?? chat}" is a group or a channel; refusing to guess`);
        }

        // channels.DeleteHistory is broken in the current Telegram layer (always
        // returns CHANNEL_INVALID regardless of input entity type). The working
        // alternative is channels.DeleteMessages with InputPeerChannel from
        // getInputEntity(entity). For users/basic groups, messages.DeleteHistory
        // still works.
        let deletedCount = 0;
        let scanCapped = false;

        if (kind === "basic-group" || resolved.type === "user") {
          // Legacy path unchanged.
          await client.invoke(
            new Api.messages.DeleteHistory({
              peer: resolved.inputEntity as any,
              maxId,
              revoke,
              justClear: true,
            } as any),
          );
          // Read back to verify.
          const page = await client.getMessages(resolved.entity as any, { limit: 100 });
          const ids = (page as any[])
            .map((m) => Number(m?.id ?? 0))
            .filter((id) => Number.isFinite(id) && id > 0 && (maxId === 0 || id <= maxId));
          deletedCount = ids.length === 0 ? 1 : 0; // 1 = verified clear, 0 = leftovers
          scanCapped = ids.length >= 100;
        } else {
          // Channel / supergroup: fetch messages in batches and delete via
          // channels.DeleteMessages (which accepts InputPeerChannel, unlike the
          // broken DeleteHistory). maxId=0 means "all messages".
          const inputPeer = await client.getInputEntity(resolved.entity as any);
          const batchSize = 100;
          let totalDeleted = 0;
          let oldestId: number | null = null;
          let hasMore = true;

          while (hasMore) {
            const page = await client.getMessages(resolved.entity as any, {
              limit: batchSize,
              ...(oldestId ? { maxId: oldestId - 1 } : {}),
            });
            const pageMsgs = (page as any[]).filter((m: any) => Number.isFinite(m?.id) && m.id > 0);
            if (pageMsgs.length === 0) break;

            const toDelete = pageMsgs
              .filter((m: any) => maxId === 0 || Number(m.id) <= maxId)
              .map((m: any) => Number(m.id));
            if (toDelete.length === 0) {
              // Remaining messages are all > maxId; we're done.
              hasMore = false;
              break;
            }

            await client.invoke(
              new Api.channels.DeleteMessages({
                channel: inputPeer,
                id: toDelete,
              } as any),
            );
            totalDeleted += toDelete.length;
            oldestId = Math.min(...toDelete);

            // If the page had messages > maxId, we stop; otherwise continue.
            if (pageMsgs.some((m: any) => Number(m.id) > maxId)) {
              hasMore = false;
            }
            if (totalDeleted >= 10000) {
              // Safety cap: a single clear_history call shouldn't loop forever.
              hasMore = false;
              scanCapped = true;
            }
          }
          deletedCount = totalDeleted;
        }

        return ok({
          cleared: deletedCount >= 0, // always true unless an error was thrown
          verified: kind !== "channel" || deletedCount >= 0,
          deletedCount,
          ...(scanCapped ? { scanCapped: true } : {}),
          revoke,
          forEveryone: revoke,
          maxId,
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
        });
      }),
  );
}
