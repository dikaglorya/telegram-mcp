/**
 * Media: download attachments, send files/photos/docs, list local downloads.
 * Full access — sends immediately, downloads any permitted attachment.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "telegram";
import { getClient } from "./telegram.js";
import { ensureDirs, getConfig } from "./config.js";
import { requireChat } from "./helpers.js";
import { loadState, mutateState, type DownloadRecord } from "./state.js";
import { ok, fail, guard, idsFromUpdates } from "./util.js";

/** Message random ids are 64-bit signed; gramJS accepts a Long-like value. */
function randomId(): any {
  // 48 random bits stay well inside the signed 64-bit range Telegram expects.
  return String(crypto.randomBytes(6).readUIntBE(0, 6));
}

/**
 * The download cap. `Number("1O24")` is `NaN`, and `NaN || 0` is `0`, which this
 * file used to read as "no cap" — so one typo in the environment quietly removed
 * the only limit on how much this server would pull off the network, and nothing
 * ever said so.
 *
 * The bad value is not thrown at import time on purpose: a misconfiguration would
 * then stop the whole server from starting, including `telegram_doctor`, which is
 * the tool someone would use to find out what is wrong. It surfaces as a normal
 * tool error at the moment a download would actually rely on it.
 */
const RAW_MAX_BYTES = process.env.TELEGRAM_MAX_DOWNLOAD_BYTES;
export function maxDownloadBytes(): number {
  const raw = RAW_MAX_BYTES;
  if (raw === undefined || raw.trim() === "") return 0; // 0 = no cap
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    const err = new Error(
      `TELEGRAM_MAX_DOWNLOAD_BYTES is ${JSON.stringify(raw)}, which is not a number. Refusing to ` +
        `treat a typo as "no download limit" — fix the value or remove it.`,
    ) as Error & { code?: string };
    err.code = "CONFIG_INVALID";
    throw err;
  }
  return n;
}

function safeName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "file";
}

/**
 * Compare a stored chat id against a freshly resolved one regardless of the marked
 * form. Records written before the marked-id convention went in carry the bare
 * channel id (`1234567890`, while the same chat is now reported as
 * `-1001234567890`); re-downloading that message has to update its row instead of
 * leaving a duplicate beside it.
 */
function sameChat(stored: unknown, resolved: string): boolean {
  const bare = (v: unknown) => String(v ?? "").replace(/^-100/, "").replace(/^-/, "");
  return bare(stored) === bare(resolved);
}

export function registerMediaTools(server: McpServer): void {
  server.registerTool(
    "telegram_download_media",
    {
      title: "Download media",
      description:
        "Download the attachment of a message to the local media directory. Returns local path + size. " +
        "Set TELEGRAM_MAX_DOWNLOAD_BYTES in env for a cap (0 = unlimited).",
      inputSchema: {
        chat: z.string().min(1),
        messageId: z.number().int().positive(),
        fileName: z.string().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, messageId, fileName }) =>
      guard(async () => {
        const config = getConfig();
        ensureDirs(config);
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const messages = await client.getMessages(resolved.entity as any, { ids: messageId });
        const msg: any = messages[0];
        if (!msg) return fail(`message ${messageId} not found`);

        // A message can be perfectly valid and carry no attachment at all.
        // `downloadMedia` is a method on every gramJS message, so testing for the
        // method proved nothing: message 1 of a channel with no media sailed
        // through, wrote a 0-byte file and reported `downloaded: true`. Check for
        // the attachment itself.
        if (!msg.media) {
          return fail(`message ${messageId} has no attachment to download`, {
            messageId,
            hasText: Boolean(msg.text),
          });
        }

        const doc = msg.media.document;

        // Photos keep their size in a list of encodings rather than a document,
        // so the byte cap below never applied to them.
        const photoSizes: any[] = msg.media.photo?.sizes ?? [];
        let photoBytes = 0;
        for (const s of photoSizes) {
          const n = Number(s?.size ?? (Array.isArray(s?.sizes) ? s.sizes[s.sizes.length - 1] : 0));
          if (Number.isFinite(n) && n > photoBytes) photoBytes = n;
        }

        const sizeGuess = Number(doc?.size ?? photoBytes ?? 0);
        const cap = maxDownloadBytes();
        if (cap > 0 && sizeGuess > cap) {
          return fail(`attachment is ${sizeGuess} bytes, above TELEGRAM_MAX_DOWNLOAD_BYTES (${cap})`, {
            size: sizeGuess,
            maxBytes: cap,
          });
        }
        const suggested =
          fileName ||
          doc?.attributes?.find((a: any) => typeof a?.fileName === "string")?.fileName ||
          `msg_${messageId}`;
        // Stream directly to disk to avoid loading large files into memory.
        // gramJS supports outputFile as a path string (OutFile type).
        const savedName = safeName(suggested);
        const chatId = resolved.peerId || resolved.id;
        const prev = loadState().downloads.find(
          (d) => sameChat(d.chatId, chatId) && d.messageId === messageId && d.fileName === savedName,
        );
        const id = prev?.id ?? crypto.randomBytes(4).toString("hex");
        const dest = path.join(config.mediaDir, `${id}_${savedName}`);

        // Ensure parent dir exists before streaming.
        fs.mkdirSync(config.mediaDir, { recursive: true, mode: 0o700 });

        const result = await msg.downloadMedia({ outputFile: dest });
        // When outputFile is provided, gramJS returns the path string on success,
        // or undefined on failure. It does not return a Buffer.
        if (!result) {
          // Clean up any partial file.
          try {
            fs.unlinkSync(dest);
          } catch {
            /* ignore */
          }
          return fail(`download produced no data for message ${messageId}`);
        }

        // Verify the file was written and get its size.
        let size: number;
        try {
          size = fs.statSync(dest).size;
        } catch {
          return fail(`downloaded file not found at ${dest}`);
        }
        if (size === 0) {
          fs.unlinkSync(dest);
          return fail(`download produced empty file for message ${messageId}`);
        }
        const record: DownloadRecord = {
          id,
          path: dest,
          // The real type, not a blanket octet-stream: a downloaded mp4 was being
          // recorded as an unknown binary, which makes the index useless.
          mime:
            typeof doc?.mimeType === "string" && doc.mimeType
              ? doc.mimeType
              : msg.media?.className === "MessageMediaPhoto"
                ? "image/jpeg"
                : "application/octet-stream",
          size,
          chatId,
          messageId,
          fileName: savedName,
          createdAt: new Date().toISOString(),
        };
        mutateState((s) => {
          // Collapse older rows for the same message and file name: they point at
          // files that no longer exist, and this fresh row supersedes them.
          s.downloads = s.downloads.filter(
            (d) =>
              !(
                sameChat(d.chatId, chatId) &&
                d.messageId === messageId &&
                d.fileName === savedName
              ),
          );
          s.downloads.push(record);
          if (s.downloads.length > 500) s.downloads = s.downloads.slice(-500);
        });

        return ok({ downloaded: true, path: dest, size, fileName: record.fileName });
      }),
  );

  server.registerTool(
    "telegram_delete_download",
    {
      title: "Delete a download record",
      description:
        "Remove one record from the local downloads index by its id, optionally deleting the file it " +
        "points at. This is local bookkeeping only — nothing is deleted on Telegram. Use it to prune " +
        "records whose file is already gone (telegram_list_downloads reports exists:false for those).",
      inputSchema: {
        id: z.string().min(1),
        deleteFile: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ id, deleteFile }) =>
      guard(async () => {
        const state = loadState();
        const record = state.downloads.find((d) => d.id === id);
        if (!record) {
          const known = state.downloads.slice(-10).map((d) => ({ id: d.id, fileName: d.fileName }));
          return fail(`no download record with id "${id}"`, { recentIds: known });
        }

        // The media dir is the only place a record is allowed to point at; refuse
        // to unlink anything outside it even if state.json was edited by hand.
        const mediaDir = getConfig().mediaDir;
        const inside = path.resolve(record.path).startsWith(path.resolve(mediaDir) + path.sep);
        let fileDeleted = false;
        let fileExisted = false;
        if (deleteFile) {
          if (!inside) {
            return fail(
              `record ${id} points outside the media directory (${record.path}); refusing to delete that file`,
              { mediaDir },
            );
          }
          fileExisted = fs.existsSync(record.path);
          if (fileExisted) {
            fs.rmSync(record.path, { force: true });
            fileDeleted = !fs.existsSync(record.path);
            if (!fileDeleted) return fail(`could not delete ${record.path}`);
          }
        }

        mutateState((s) => {
          s.downloads = s.downloads.filter((d) => d.id !== id);
        });

        return ok({
          deleted: true,
          id,
          fileName: record.fileName,
          fileDeleted,
          fileExisted,
          remaining: loadState().downloads.length,
        });
      }),
  );

  server.registerTool(
    "telegram_send_file",
    {
      title: "Send a file",
      description:
        "Send a local file as a document (forceDocument) or auto-detected media. Supports caption. Sends immediately.",
      inputSchema: {
        chat: z.string().min(1),
        filePath: z.string().min(1),
        caption: z.string().max(1024).optional(),
        forceDocument: z.boolean().default(true),
        replyTo: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, filePath, caption, forceDocument, replyTo }) =>
      guard(async () => {
        const full = path.resolve(filePath);
        if (!fs.existsSync(full)) return fail(`file not found: ${full}`);
        // Reject symlinks to prevent path traversal via symlinks.
        const lstat = fs.lstatSync(full);
        if (lstat.isSymbolicLink()) return fail(`refusing to upload symlink: ${full}`);
        const stat = fs.statSync(full);
        if (!stat.isFile()) return fail(`not a regular file: ${full}`);
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const sent: any = await client.sendFile(resolved.entity as any, {
          file: full,
          caption,
          forceDocument,
          replyTo,
        } as any);

        // A send that produced no id is not a success. `sent: true` with
        // `messageId: null` told the caller a file had been delivered when the
        // id it needs to read or delete that file was never produced — and a
        // message that cannot be named cannot be cleaned up either.
        const messageId = sent?.id ?? null;
        if (messageId === null) {
          return fail("Telegram accepted the file but returned no message id", {
            chat: { id: resolved.peerId || resolved.id, title: resolved.title },
            sent: false,
            filePath: full,
            size: stat.size,
          });
        }
        return ok({
          sent: true,
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
          messageId,
          filePath: full,
          size: stat.size,
        });
      }),
  );

  server.registerTool(
    "telegram_send_photo",
    {
      title: "Send a photo",
      description: "Send a local image as a photo (inline preview). Sends immediately.",
      inputSchema: {
        chat: z.string().min(1),
        filePath: z.string().min(1),
        caption: z.string().max(1024).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, filePath, caption }) =>
      guard(async () => {
        const full = path.resolve(filePath);
        if (!fs.existsSync(full)) return fail(`file not found: ${full}`);
        // Reject symlinks to prevent path traversal via symlinks.
        const lstat = fs.lstatSync(full);
        if (lstat.isSymbolicLink()) return fail(`refusing to upload symlink: ${full}`);
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const sent: any = await client.sendFile(resolved.entity as any, { file: full, caption, forceDocument: false } as any);

        // Same rule as send_file: no id means nothing to read back and nothing
        // to delete, so it is not a delivery.
        const messageId = sent?.id ?? null;
        if (messageId === null) {
          return fail("Telegram accepted the photo but returned no message id", {
            chat: { id: resolved.peerId || resolved.id, title: resolved.title },
            sent: false,
            filePath: full,
          });
        }
        return ok({
          sent: true,
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
          messageId,
        });
      }),
  );

  server.registerTool(
    "telegram_list_downloads",
    {
      title: "List downloads",
      description: "List files downloaded by this server (paths, sizes, source message).",
      inputSchema: { limit: z.number().int().min(1).max(500).default(50) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit }) =>
      guard(async () => {
        const state = loadState();
        const items = state.downloads.slice(-limit).reverse();

        // A record whose file is gone is worse than useless: it makes the index
        // look like a complete inventory of what is on disk. Say so instead.
        const downloads = items.map((d) => ({
          ...d,
          exists: fs.existsSync(d.path),
        }));

        return ok({ count: downloads.length, downloads });
      }),
  );

  server.registerTool(
    "telegram_send_location",
    {
      title: "Send a location",
      description:
        "Send a geographic point to a chat. `lat`/`long` are decimal degrees; optional accuracy in " +
        "metres. Sends immediately.",
      inputSchema: {
        chat: z.string().min(1),
        lat: z.number().min(-90).max(90),
        long: z.number().min(-180).max(180),
        accuracy: z.number().int().min(0).max(1500).optional(),
        replyTo: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ chat, lat, long, accuracy, replyTo }) =>
      guard(async () => {
        const client = await getClient();
        const resolved = await requireChat(client, chat);
        const geoPoint = new Api.InputGeoPoint({
          lat,
          long,
          // `accuracy ? ...` dropped an explicit accuracy of 0, which the schema
          // allows, while the reply below still claimed it had been sent.
          ...(accuracy !== undefined ? { accuracyRadius: accuracy } : {}),
        } as any);
        const media = new Api.InputMediaGeoPoint({ geoPoint } as any);
        const sent: any = await client.invoke(
          new Api.messages.SendMedia({
            peer: resolved.inputEntity as any,
            media,
            message: "",
            randomId: randomId(),
            ...(replyTo ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: replyTo } as any) } : {}),
          } as any),
        );

        // SendMedia returns Updates; the new message id lives in one of the update
        // wrappers, and gramJS's `_getResponseMessage` helper cannot see it (it
        // builds an id-less object — the same trap that hid forward ids).
        const messageId = idsFromUpdates(sent)[0] ?? null;
        if (messageId === null) {
          return fail("Telegram accepted the location but returned no message id", {
            chat: { id: resolved.peerId || resolved.id, title: resolved.title },
            sent: false,
            location: { lat, long, accuracy: accuracy ?? null },
          });
        }
        return ok({
          sent: true,
          chat: { id: resolved.peerId || resolved.id, title: resolved.title },
          messageId,
          // Report what was actually put on the wire, not what was asked for.
          location: { lat, long, accuracy: accuracy ?? null },
        });
      }),
  );
}
