/**
 * Full-access account + profile tools. Everything you can see/change about the
 * account itself: status, profile, update profile, privacy-free session info.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "telegram";
import { getClient } from "./telegram.js";
import { getConfig } from "./config.js";
import { allowEntries } from "./policy.js";
import { resolveChat, enforce, markedId, uploadFileFromPath, requireChat } from "./helpers.js";
import { ok, guard, fail } from "./util.js";

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    "telegram_status",
    {
      title: "Telegram status",
      description:
        "Connection + authorization status, and the logged-in account summary. Secrets are never returned.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const client = await getClient();
        const me = (await client.getMe()) as any;
        const authorized = await client.isUserAuthorized();

        return ok({
          authorized,
          connected: true,
          account: {
            id: String(me.id ?? ""),
            username: me.username ?? null,
            firstName: me.firstName ?? null,
            lastName: me.lastName ?? null,
            phone: me.phone ?? null,
            premium: Boolean(me.premium),
          },
          allowAllChats: getConfig().allowAllChats,
          allowlist: allowEntries(getConfig()).map((e) => e.value),
        });
      }),
  );

  server.registerTool(
    "telegram_me",
    {
      title: "My profile",
      description: "Full profile of the authorized account (id, names, username, phone, premium).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const client = await getClient();
        const me = (await client.getMe()) as any;

        return ok({
          id: String(me.id ?? ""),
          username: me.username ?? null,
          firstName: me.firstName ?? null,
          lastName: me.lastName ?? null,
          phone: me.phone ?? null,
          premium: Boolean(me.premium),
          bio: me.about ?? null,
        });
      }),
  );

  server.registerTool(
    "telegram_full_user",
    {
      title: "Full user info",
      description:
        "Complete User object for one account (all non-secret fields Telegram exposes). " +
        "Defaults to the authorized account; pass user to look at somebody else. " +
        "Phone numbers of other people are only present when their privacy settings share them.",
      inputSchema: { user: z.string().min(1).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ user }) =>
      guard(async () => {
        const client = await getClient();
        // This tool used to hardcode `getInputEntity("me")` while advertising an
        // empty schema, so a caller passing `user` got *its own* profile back
        // with no error — the worst kind of wrong answer, because the phone
        // number it returned looked like the other person's. `user` is honoured
        // now, and the registry rejects undeclared arguments outright.
        const target = user ? await requireChat(client, user) : null;
        if (target && target.type !== "user") {
          return fail(`${target.title ?? user} is a ${target.type}, not a user — try telegram_chat_info`);
        }
        const peer = target ? (target.inputEntity as any) : ((await client.getInputEntity("me")) as any);
        const users = await client.invoke(new Api.users.GetFullUser({ id: peer }));
        const u: any = users.users?.[0];
        const f: any = users.fullUser;
        // "Is this me?" is a question about identity, not about whether an
        // argument was passed: `user: "me"` and `user: "@<own handle>"` both
        // resolve to this account and must answer isSelf too.
        const selfId = String(((await client.getMe()) as any)?.id ?? "");

        // Explicit field list: the raw User/UserFull objects carry flags,
        // accessHash and dozens of internal booleans that are noise to a caller
        // and must not be copied into the model's context.
        return ok({
          user: {
            id: String(u?.id ?? ""),
            isSelf: String(u?.id ?? "") === selfId,
            username: u?.username ?? null,
            firstName: u?.firstName ?? null,
            lastName: u?.lastName ?? null,
            phone: u?.phone ?? null,
            premium: u?.premium ?? false,
            verified: u?.verified ?? false,
            bot: u?.bot ?? false,
          },
          // Telegram omits `phone` for a user who does not share it. Saying that
          // explicitly stops a null from being read as "this person has no phone".
          ...(u?.phone ? {} : { phoneNote: "this account does not share its phone number with you" }),
          profile: {
            about: f?.about ?? null,
            commonChatsCount: f?.commonChatsCount ?? null,
            pinnedMsgId: f?.pinnedMsgId ?? null,
            phoneCallsAvailable: f?.phoneCallsAvailable ?? null,
            phoneCallsPrivate: f?.phoneCallsPrivate ?? null,
          },
        });
      }),
  );

  server.registerTool(
    "telegram_update_profile",
    {
      title: "Update my profile",
      description: "Change first/last name and/or bio of the authorized account.",
      inputSchema: {
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        about: z.string().max(70).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ firstName, lastName, about }) =>
      guard(async () => {
        const client = await getClient();
        // `account.UpdateProfile` is a flags-based TL object: every field is
        // optional, and an omitted field is left untouched. Sending
        // `firstName` alone used to also send `lastName: ""`, which silently
        // erased the user's last name — data loss for a caller that only wanted
        // to change one field.
        if (firstName !== undefined || lastName !== undefined) {
          const patch: Record<string, string> = {};
          if (firstName !== undefined) patch.firstName = firstName;
          if (lastName !== undefined) patch.lastName = lastName;
          await client.invoke(new Api.account.UpdateProfile(patch as any));
        }
        if (about !== undefined) {
          await client.invoke(new Api.account.UpdateProfile({ about }));
        }

        return ok({ updated: true });
      }),
  );

  server.registerTool(
    "telegram_user_photos",
    {
      title: "List a user's profile photos",
      description:
        "List the profile photos of a user (or of 'me'). Returns photo ids with their sizes and a " +
        "downloadable file reference; use telegram_download_media only for chat messages, not for these.",
      inputSchema: {
        user: z.string().min(1).default("me"),
        limit: z.number().int().min(1).max(100).default(10),
        offset: z.number().int().min(0).default(0),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ user, limit, offset }) =>
      guard(async () => {
        const client = await getClient();
        // Resolved through the same gate as every other chat-taking tool. Reading
        // a blocked account's profile photos is still reaching that account, so
        // this must not be a way around the allowlist — it was the one tool that
        // was, verified by probing a denied chat against a live allowlist.
        const resolved = await resolveChat(client, user);
        enforce(client, resolved);
        const entity: any = resolved.inputEntity;
        const result: any = await client.invoke(
          new Api.photos.GetUserPhotos({
            userId: entity as any,
            offset,
            limit,
            maxId: 0,
          } as any),
        );

        const photos: any[] = Array.isArray(result?.photos) ? result.photos : [];
        const shaped = photos.map((p: any) => {
          // Api.Photo keeps its renditions in `sizes`; PhotoSizeProgressive keeps
          // its bytes in a parallel array, so take the last entry of either.
          const sizes = (Array.isArray(p?.sizes) ? p.sizes : []).map((s: any) => ({
            type: s?.type ?? null,
            width: s?.w ?? null,
            height: s?.h ?? null,
            bytes: typeof s?.size === "number" ? s.size : Array.isArray(s?.sizes) ? s.sizes[s.sizes.length - 1] ?? null : null,
          }));
          return {
            id: p?.id !== undefined ? String(p.id) : null,
            date: p?.date ? new Date(Number(p.date) * 1000).toISOString() : null,
            dcId: p?.dcId ?? null,
            largest: sizes.slice().sort((a: any, b: any) => (b.bytes ?? 0) - (a.bytes ?? 0))[0] ?? null,
            sizes,
          };
        });

        return ok({
          count: shaped.length,
          offset,
          photos: shaped,
          note: "photo file references expire; re-list rather than storing them",
        });
      }),
  );

  server.registerTool(
    "telegram_set_my_photo",
    {
      title: "Set or remove your profile photo",
      description:
        "Upload a local image as your own profile photo, or remove the current one with remove=true. " +
        "Telegram also keeps the previous photo in your photo list; this does not delete it.",
      inputSchema: {
        filePath: z.string().min(1).optional(),
        remove: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ filePath, remove }) =>
      guard(async () => {
        if (!remove && !filePath) return fail("pass filePath=<local image> or remove=true");
        const client = await getClient();

        // photos.DeletePhotos does NOT mean "remove my current photo": it deletes
        // the exact photos you name, and an empty `id` array is a well-formed RPC
        // that Telegram accepts while doing nothing. The previous version passed
        // `id: []` and reported `removed: true` unconditionally — a false success
        // (the fifth one found in this project). The current photo has to be
        // looked up first and its InputPhoto passed in.
        if (remove) {
          const listing: any = await client.invoke(
            new Api.photos.GetUserPhotos({ userId: "me" as any, offset: 0, limit: 1, maxId: 0 } as any),
          );
          const current: any = Array.isArray(listing?.photos) ? listing.photos[0] : undefined;
          if (!current) return fail("this account has no profile photo to remove");

          await client.invoke(
            new Api.photos.DeletePhotos({
              id: [
                new Api.InputPhoto({
                  id: current.id,
                  accessHash: current.accessHash,
                  fileReference: current.fileReference,
                } as any),
              ],
            } as any),
          );

          // Read back: the same RPC style that silently ignores things elsewhere
          // is exactly why this project verifies every write.
          const after: any = await client.invoke(
            new Api.photos.GetUserPhotos({ userId: "me" as any, offset: 0, limit: 1, maxId: 0 } as any),
          );
          const stillThere = Array.isArray(after?.photos) && after.photos.some((p: any) => String(p.id) === String(current.id));
          if (stillThere) {
            return fail("Telegram accepted the delete but the photo is still there", {
              removedPhotoId: String(current.id),
              verified: false,
            });
          }
          return ok({
            updated: false,
            removed: true,
            verified: true,
            filePath: null,
            removedPhotoId: String(current.id),
          });
        }

        // Preflight the path: gramJS reads the file itself and reports a bad path
        // as a raw UNKNOWN, which tells the caller nothing.
        const full = path.resolve(filePath as string);
        if (!fs.existsSync(full)) return fail(`file not found: ${full}`);
        if (!/\.(jpe?g|png|webp)$/i.test(full)) {
          return fail(`a profile photo must be a .jpg, .png or .webp image, got ${path.basename(full)}`);
        }

        // `uploadFile` only accepts a gramJS CustomFile, never a path — see
        // uploadFileFromPath() for why that mattered here.
        const photo: any = await client.invoke(
          new Api.photos.UploadProfilePhoto({
            file: (await uploadFileFromPath(client, full)) as any,
          } as any),
        );
        // The upload's own Photo object is not proof; the read-back below is what
        // decides. Keep the id only to report which upload landed.
        const uploadedPhotoId = photo?.photo?.id !== undefined ? String(photo.photo.id) : null;

        // Read the photo list back: "the RPC returned a Photo" is not the same as
        // "the account now shows it".
        const listed: any = await client.invoke(
          new Api.photos.GetUserPhotos({ userId: "me" as any, offset: 0, limit: 1, maxId: 0 } as any),
        );
        const current: any = Array.isArray(listed?.photos) ? listed.photos[0] : undefined;
        const photoId = current?.id !== undefined ? String(current.id) : null;
        if (!photoId) return fail("Telegram accepted the upload but the profile still has no photo", { filePath: full });

        return ok({
          updated: true,
          removed: false,
          verified: true,
          filePath: full,
          photoId,
          uploadedPhotoId,
        });
      }),
  );

  server.registerTool(
    "telegram_common_chats",
    {
      title: "Chats shared with a user",
      description: "List the groups and channels this account has in common with another user.",
      inputSchema: {
        user: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ user, limit }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await resolveChat(client, user);
        // Same gate as every other user-taking tool: listing the chats shared
        // with a denied account still reaches that account.
        enforce(client, resolved);
        const result: any = await client.invoke(
          new Api.messages.GetCommonChats({
            userId: resolved.inputEntity as any,
            maxId: 0,
            limit,
          } as any),
        );

        const chats: any[] = Array.isArray(result?.chats) ? result.chats : [];
        return ok({
          count: chats.length,
          user: { id: resolved.peerId || resolved.id, title: resolved.title },
          chats: chats.map((c) => ({
            id: markedId(c),
            title: c?.title ?? null,
            username: c?.username ?? null,
            megagroup: Boolean(c?.megagroup),
            broadcast: Boolean(c?.broadcast),
            participantsCount: c?.participantsCount ?? null,
          })),
        });
      }),
  );
}
