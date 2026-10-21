/**
 * Group/channel administration: invite, promote, demote, kick, ban, and the chat
 * photo. Everything here needs admin rights, and everything is reversible except
 * a ban (which is itself reversible with unban).
 *
 * The two rights objects are the trap in this API:
 *   - `ChatAdminRights` is what you *grant* an admin (changeInfo, postMessages…);
 *   - `ChatBannedRights` is what you *restrict*, and `untilDate: 0` means forever.
 * Sending the wrong one, or omitting `untilDate`, either grants nothing or bans
 * permanently, so each tool builds the object explicitly instead of accepting a
 * free-form blob from the caller.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "telegram";
import { CustomFile } from "telegram/client/uploads.js";
import { getClient } from "./telegram.js";
import { requireChat, resolveChat, enforce, peerKind } from "./helpers.js";
import { ok, fail, guard } from "./util.js";

/**
 * Read back the photo id a chat currently has, or null when it has none.
 *
 * `channels.EditPhoto` answers with a `Photo` even when it changes nothing, so
 * the only trustworthy check is to re-read the chat and look at its photo.
 */
async function chatPhotoId(client: any, inputEntity: any): Promise<string | null> {
  const entity: any = await client.getEntity(inputEntity);
  const photo: any = entity?.photo;
  if (!photo || photo.className === "ChatPhotoEmpty") return null;
  // `photoId` is a Long; String() keeps it exact instead of losing precision.
  return photo.photoId !== undefined ? String(photo.photoId) : null;
}

/**
 * Resolve a user into the exact `InputPeerUser` an admin RPC will accept.
 *
 * `EditAdmin` and `EditBanned` reject a bare numeric id (`USER_ID_INVALID`) and
 * reject `InputPeerSelf` outright, and `getInputEntity("me")` returns exactly
 * that. The access hash Telegram actually wants comes from the chat's own
 * participant list, so this asks the chat rather than the account.
 */
async function inputUserInChat(client: any, channel: any, ref: string): Promise<any> {
  const numeric = /^\d+$/.test(ref) ? ref : null;
  const self = /^(me|self)$/i.test(ref);
  const selfId = self ? String((await client.getEntity("me" as any))?.id ?? "") : null;
  const wantId = numeric ?? selfId;

  // Walk the participant list once; it carries both the user and its accessHash.
  const participants: any = await client.invoke(
    new Api.channels.GetParticipants({
      channel,
      filter: new Api.ChannelParticipantsRecent() as any,
      offset: 0,
      limit: 200,
      hash: BigInt(0) as any,
    } as any),
  );
  const users: any[] = Array.isArray(participants?.users) ? participants.users : [];
  let user = wantId ? users.find((u: any) => String(u.id) === wantId) : undefined;
  if (!user && !wantId) {
    const uname = ref.replace(/^@/, "").toLowerCase();
    user = users.find((u: any) => String(u.username ?? "").toLowerCase() === uname);
  }
  if (!user) return null;
  return new Api.InputPeerUser({ userId: user.id, accessHash: user.accessHash } as any);
}

/** Rights an admin is granted when `rights` is omitted: enough to moderate. */const MODERATOR = {
  changeInfo: true,
  deleteMessages: true,
  banUsers: true,
  inviteUsers: true,
  pinMessages: true,
};

/** Presets so callers do not have to remember fifteen booleans. */
const PRESETS: Record<string, Record<string, boolean>> = {
  moderator: MODERATOR,
  // Full admin except anonymous posting, which changes how messages are attributed.
  full: {
    changeInfo: true,
    postMessages: true,
    editMessages: true,
    deleteMessages: true,
    banUsers: true,
    inviteUsers: true,
    pinMessages: true,
    addAdmins: true,
    manageCall: true,
    other: true,
    manageTopics: true,
    postStories: true,
    editStories: true,
    deleteStories: true,
  },
  // Demote: every right explicitly false. Sending an empty object is not the same
  // — gramJS omits absent flags, and Telegram then leaves the rights untouched, so
  // "demote" reported success while the member stayed an admin.
  none: {
    changeInfo: false,
    postMessages: false,
    editMessages: false,
    deleteMessages: false,
    banUsers: false,
    inviteUsers: false,
    pinMessages: false,
    addAdmins: false,
    anonymous: false,
    manageCall: false,
    other: false,
    manageTopics: false,
    postStories: false,
    editStories: false,
    deleteStories: false,
  },
};

/**
 * Build the rights object for a preset.
 *
 * Exported so the offline checks can pin the one property that matters: the
 * "none" preset must carry every flag as an explicit `false`. An empty object
 * means "leave the rights alone" to Telegram, not "remove them", which made
 * demotion silently a no-op.
 */
export function adminRights(preset: string): Api.ChatAdminRights {
  const rights = PRESETS[preset] ?? MODERATOR;
  return new Api.ChatAdminRights(rights as any);
}

/**
 * Every right Telegram understands, in the order the API defines them.
 *
 * This list has to track `Api.ChatAdminRights` exactly. It was 11 entries while
 * the class has 15 — the four story/topic rights were missing, so the "none"
 * preset left `manageTopics`/`postStories`/`editStories`/`deleteStories` absent,
 * which Telegram reads as "leave unchanged", and a demoted admin kept the right
 * to manage topics and post stories.
 */
export const ALL_ADMIN_RIGHTS = [
  "changeInfo",
  "postMessages",
  "editMessages",
  "deleteMessages",
  "banUsers",
  "inviteUsers",
  "pinMessages",
  "addAdmins",
  "anonymous",
  "manageCall",
  "other",
  "manageTopics",
  "postStories",
  "editStories",
  "deleteStories",
] as const;

/**
 * Read one member's current admin status back from the chat.
 *
 * `channels.EditAdmin` returns Updates whether or not it changed anything, and it
 * is silently ignored when the target is the chat's creator — a creator cannot be
 * promoted (they already are) or demoted (nobody outranks them). Reporting
 * `promoted: true` from the call alone therefore lies for the most likely caller,
 * the owner of the chat. This is what makes the answer honest.
 */
async function adminStatusOf(client: any, inputEntity: any, userId: string): Promise<{
  found: boolean;
  role: string | null;
  creator: boolean;
  rank: string | null;
  rights: string[];
} | null> {
  try {
    const result: any = await client.invoke(
      new Api.channels.GetParticipant({
        channel: inputEntity,
        participant: userId,
      } as any),
    );
    const p: any = result?.participant;
    if (!p) return { found: false, role: null, creator: false, rank: null, rights: [] };
    const rights = p?.adminRights ?? p?.rights ?? null;
    const granted = rights
      ? Object.entries(rights)
          .filter(([, v]) => v === true)
          .map(([k]) => k)
      : [];
    return {
      found: true,
      role: p?.className?.replace("ChannelParticipant", "").toLowerCase() ?? null,
      creator: p?.className === "ChannelParticipantCreator",
      rank: p?.rank || null,
      rights: granted,
    };
  } catch {
    // A member who is not in the chat, or a filter the account cannot use, is not
    // a reason to fail the whole call — the caller still gets the write's result.
    return null;
  }
}

export function registerAdminTools(server: McpServer): void {
  server.registerTool(
    "telegram_invite_members",
    {
      title: "Add members to a group or channel",
      description:
        "Invite one or more users into a group/channel this account administers. Users are resolved " +
        "from @username or id. Returns the ids Telegram reports as invited, plus the ones it refused.",
      inputSchema: {
        chat: z.string().min(1),
        users: z.array(z.string().min(1)).min(1).max(20),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, users }) =>
      guard(async () => {
        const client = await getClient();
        const target = await requireChat(client, chat);
        if (target.type === "user") return fail(`${target.title ?? chat} is a user, not a group or channel`);

        const entities: any[] = [];
        const ids: string[] = [];
        const unresolved: string[] = [];
        for (const u of users) {
          try {
            const resolved = await resolveChat(client, u);
            // An invite is a real membership change, so the allowlist applies to
            // the person being added too — otherwise it is a policy bypass.
            enforce(client, resolved);
            entities.push(resolved.inputEntity);
            ids.push(String(resolved.peerId || resolved.id));
          } catch {
            unresolved.push(u);
          }
        }
        if (entities.length === 0) {
          return fail("none of the given users could be resolved", { unresolved });
        }

        // Who is already in the chat? `InviteToChannel` accepts a user who is
        // already a member and reports them as invited, so `invited: 1` was
        // returned for a no-op — the same lie `promote_admin` told. Asking first
        // is the only way to know whether anything actually changed.
        const alreadyMembers: string[] = [];
        for (const id of ids) {
          const status = await adminStatusOf(client, target.inputEntity, id);
          if (status?.found && status.role !== "left" && status.role !== "banned") alreadyMembers.push(id);
        }

        const result: any = await client.invoke(
          new Api.channels.InviteToChannel({
            channel: target.inputEntity as any,
            users: entities as any,
          } as any),
        );

        // InviteToChannel answers with InvitedUsers {updates, missingInvitees}.
        const missing: any[] = Array.isArray(result?.missingInvitees) ? result.missingInvitees : [];
        const missingIds = missing.map((m: any) => String(m?.userId ?? m?.id ?? "")).filter(Boolean);

        // Verify the ones that were supposed to be new actually joined.
        const newlyInvited = ids.filter((id) => !alreadyMembers.includes(id) && !missingIds.includes(id));
        const verified: string[] = [];
        for (const id of newlyInvited) {
          const status = await adminStatusOf(client, target.inputEntity, id);
          if (status?.found && status.role !== "left") verified.push(id);
        }
        const didNotJoin = newlyInvited.filter((id) => !verified.includes(id));

        return ok({
          // Only people who were not members and are members now.
          invited: verified.length,
          requested: users.length,
          alreadyMembers,
          didNotJoin,
          missingInvitees: missingIds,
          unresolved,
          chat: { id: target.peerId || target.id, title: target.title },
        });
      }),
  );

  server.registerTool(
    "telegram_promote_admin",
    {
      title: "Promote / demote an admin",
      description:
        "Grant or revoke admin rights for a member. preset: 'moderator' (default, can delete and ban), " +
        "'full' (everything except anonymous), 'none' (demote). Optional custom title (rank).",
      inputSchema: {
        chat: z.string().min(1),
        user: z.string().min(1),
        preset: z.enum(["moderator", "full", "none"]).default("moderator"),
        rank: z.string().max(16).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, user, preset, rank }) =>
      guard(async () => {
        const client = await getClient();
        const target = await requireChat(client, chat);
        if (target.type === "user") return fail(`${target.title ?? chat} is a user, not a group or channel`);
        const member = await resolveChat(client, user);
        enforce(client, member);
        if (member.type !== "user") return fail(`${member.title ?? user} is not a user — only users can be admins`);

        // EditAdmin rejects a bare id and rejects InputPeerSelf, which is exactly
        // what resolveChat("me") returns — so promoting or demoting your own
        // account failed with USER_ID_INVALID. The access hash Telegram accepts
        // comes from the chat's participant list.
        const memberPeer = await inputUserInChat(client, target.inputEntity, user);
        if (!memberPeer) {
          return fail(
            `${member.title ?? user} is not among the recent participants of ${target.title ?? chat}, ` +
              `so Telegram will not accept an admin change for them`,
            { hint: "only existing members can be promoted; invite them first" },
          );
        }
        const memberId = String(memberPeer.userId);

        await client.invoke(
          new Api.channels.EditAdmin({
            channel: target.inputEntity as any,
            userId: memberPeer,
            adminRights: adminRights(preset),
            rank: rank ?? "",
          } as any),
        );

        // Read it back: EditAdmin accepts the call for a creator and changes
        // nothing, so the call's own success says nothing about the result.
        const after = await adminStatusOf(client, target.inputEntity, String(memberId));
        const wanted = preset !== "none";
        const isAdminNow = Boolean(after?.found) && after!.role !== "member" && after!.role !== "left";
        const applied = after === null ? null : isAdminNow === wanted;

        if (applied === false) {
          return fail(
            after?.creator
              ? "this account created the chat, so its rights cannot be changed — a creator cannot be promoted or demoted"
              : `Telegram accepted the call but the member is still ${after?.role ?? "unknown"}`,
            {
              promoted: wanted,
              preset,
              verified: false,
              role: after?.role ?? null,
              creator: Boolean(after?.creator),
              rights: after?.rights ?? [],
              user: { id: member.peerId || member.id, title: member.title },
              chat: { id: target.peerId || target.id, title: target.title },
            },
          );
        }

        return ok({
          promoted: wanted,
          preset,
          rank: rank ?? null,
          verified: applied === true,
          role: after?.role ?? null,
          rightsCount: after?.rights?.length ?? null,
          user: { id: member.peerId || member.id, title: member.title },
          chat: { id: target.peerId || target.id, title: target.title },
        });
      }),
  );

  server.registerTool(
    "telegram_kick_member",
    {
      title: "Kick / ban / unban a member",
      description:
        "Remove a member from a group or channel. kick=true bans them (default), unban=true lifts the " +
        "ban so they may rejoin. Nothing is deleted from the chat history.",
      inputSchema: {
        chat: z.string().min(1),
        user: z.string().min(1),
        unban: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, user, unban }) =>
      guard(async () => {
        const client = await getClient();
        const target = await requireChat(client, chat);
        if (target.type === "user") return fail(`${target.title ?? chat} is a user, not a group or channel`);
        const member = await resolveChat(client, user);
        enforce(client, member);
        // Same constraint as EditAdmin: the peer has to come from the chat.
        const memberPeer = await inputUserInChat(client, target.inputEntity, user);
        if (!memberPeer) {
          return fail(`${member.title ?? user} is not among the recent participants of ${target.title ?? chat}`);
        }

        // `untilDate` must be 0 for "forever". Leaving it undefined makes the
        // restriction expire immediately, so the kick silently does nothing.
        const bannedRights = unban
          ? new Api.ChatBannedRights({ untilDate: 0 } as any)
          : new Api.ChatBannedRights({ viewMessages: true, untilDate: 0 } as any);

        // Check the creator case BEFORE the call: Telegram answers a bare
        // PARTICIPANT_ID_INVALID for a creator, which reads like a bad id rather
        // than "the owner cannot be removed from their own chat".
        const before = await adminStatusOf(client, target.inputEntity, String(member.peerId || member.id));
        if (before?.creator) {
          return fail("this account created the chat, so it cannot be removed from it", {
            banned: false,
            unbanned: false,
            role: before.role,
            creator: true,
            user: { id: member.peerId || member.id, title: member.title },
            chat: { id: target.peerId || target.id, title: target.title },
          });
        }

        // EditBanned wants an InputPeer for `participant`, not an InputUser.
        // Passing the resolved InputUser made Telegram answer PARTICIPANT_ID_INVALID
        // for every kick — including kicks that should have worked.
        const participant = new Api.InputPeerUser({
          userId: member.entity?.id ?? member.id,
          accessHash: member.entity?.accessHash,
        } as any);

        await client.invoke(
          new Api.channels.EditBanned({
            channel: target.inputEntity as any,
            participant: participant as any,
            bannedRights,
          } as any),
        );

        // Read back: EditBanned is also accepted-and-ignored for a creator, and a
        // kick that silently did nothing is the worst possible answer here.
        const after = await adminStatusOf(client, target.inputEntity, String(member.peerId || member.id));
        const verified = after === null ? null : unban ? after.role !== "banned" : after.role === "banned";

        if (verified === false) {
          return fail(
            after?.creator
              ? "this account created the chat, so it cannot be removed from it"
              : `Telegram accepted the call but the member's state is ${after?.role ?? "unknown"}`,
            {
              banned: !unban,
              unbanned: unban,
              verified: false,
              role: after?.role ?? null,
              user: { id: member.peerId || member.id, title: member.title },
              chat: { id: target.peerId || target.id, title: target.title },
            },
          );
        }

        return ok({
          unbanned: unban,
          banned: !unban,
          verified,
          role: after?.role ?? null,
          user: { id: member.peerId || member.id, title: member.title },
          chat: { id: target.peerId || target.id, title: target.title },
        });
      }),
  );

  server.registerTool(
    "telegram_set_chat_photo",
    {
      title: "Set or remove a chat photo",
      description:
        "Upload a local image as the group/channel photo, or remove the photo with remove=true. " +
        "Needs admin rights. The file is read from disk, never from a URL.",
      inputSchema: {
        chat: z.string().min(1),
        filePath: z.string().min(1).optional(),
        remove: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, filePath, remove }) =>
      guard(async () => {
        if (!remove && !filePath) return fail("pass filePath=<local image> or remove=true");
        const client = await getClient();
        const target = await requireChat(client, chat);
        const kind = peerKind(target.entity);
        if (kind === "user" || kind === "unknown") {
          return fail(`${target.title ?? chat} is not a group or channel that this tool can re-photo`);
        }

        if (remove) {
          const before = await chatPhotoId(client, target.inputEntity);
          if (before === null) {
            return ok({
              removed: false,
              verified: true,
              reason: "this chat has no photo to remove",
              chat: { id: target.peerId || target.id, title: target.title },
            });
          }
          // An empty InputChatPhoto is how the API clears the photo.
          await client.invoke(
            new Api.channels.EditPhoto({
              channel: target.inputEntity as any,
              photo: new Api.InputChatPhotoEmpty() as any,
            } as any),
          );
          // EditPhoto answers with the new photo, but "answered without error" is
          // not the same as "the photo is gone" — this project has already been
          // burned by RPCs Telegram accepts and ignores. Re-read the chat.
          const check = await chatPhotoId(client, target.inputEntity);
          if (check !== null) {
            return fail("Telegram accepted the edit but the chat still has a photo", {
              chat: { id: target.peerId || target.id, title: target.title },
              remainingPhotoId: check,
              verified: false,
            });
          }
          return ok({ removed: true, verified: true, chat: { id: target.peerId || target.id, title: target.title } });
        }

        // Preflight the path before handing it to gramJS: it reads the file itself
        // and a bad path surfaces as a raw UNKNOWN ("Could not create buffer from
        // file"), which tells the caller nothing about what to fix.
        const full = path.resolve(filePath as string);
        if (!fs.existsSync(full)) return fail(`file not found: ${full}`);
        const looksImage = /\.(jpe?g|png|webp)$/i.test(full);
        if (!looksImage) {
          return fail(`a chat photo must be a .jpg, .png or .webp image, got ${path.basename(full)}`);
        }

        // uploadFile does NOT accept a path or a Buffer: it accepts only a
        // gramJS CustomFile (see fileToBuffer in client/uploads.js) and throws
        // "Could not create buffer from file" for anything else. sendFile builds
        // that wrapper internally, which is why sending a photo worked while
        // setting a chat photo never did. Build it here.
        const stat = fs.statSync(full);
        const uploaded: any = await client.uploadFile({
          file: new CustomFile(path.basename(full), stat.size, full),
          workers: 1,
        } as any);
        await client.invoke(
          new Api.channels.EditPhoto({
            channel: target.inputEntity as any,
            photo: new Api.InputChatUploadedPhoto({ file: uploaded } as any),
          } as any),
        );

        const photoId = await chatPhotoId(client, target.inputEntity);
        if (photoId === null) {
          return fail("Telegram accepted the upload but the chat has no photo", { filePath, verified: false });
        }
        return ok({
          updated: true,
          verified: true,
          photoId,
          chat: { id: target.peerId || target.id, title: target.title },
          filePath,
        });
      }),
  );
}
