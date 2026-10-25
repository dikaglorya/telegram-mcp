/**
 * Shared helpers: chat resolution, message shaping, allow-policy application.
 *
 * Resolution order for a chat reference:
 *   1. "me" / "self"              -> the logged-in account
 *   2. anything gramJS getEntity() understands (@username, phone, t.me link, id)
 *   3. a *title substring* match against the account's recent dialogs
 *
 * Step 3 exists because the README promises title lookups and because gramJS
 * cannot resolve a chat from its display name. It only ever searches dialogs
 * the account already participates in.
 */
import type { TelegramClient } from "telegram";
import { getConfig } from "./config.js";
import { isAllowed } from "./policy.js";
import { normalizeError } from "./errors.js";

/** Dialog cache with TTL to avoid N+1 fetches of 300 dialogs per title lookup. */
let dialogCache: { dialogs: any[]; expiresAt: number } | null = null;
const DIALOG_CACHE_TTL_MS = 30_000;

async function getDialogsCached(client: TelegramClient): Promise<any[]> {
  const now = Date.now();
  if (dialogCache && dialogCache.expiresAt > now) return dialogCache.dialogs;
  const dialogs = await client.getDialogs({ limit: 500 });
  dialogCache = { dialogs, expiresAt: now + DIALOG_CACHE_TTL_MS };
  return dialogs;
}

export function invalidateDialogCache(): void {
  dialogCache = null;
}

export type ResolvedChat = {
  /** Bare entity id as reported by Telegram (positive for users/chats). */
  id: string;
  /**
   * Marked peer id, safe for allowlists: -100<channelId> for channels and
   * supergroups, -<chatId> for basic groups, plain id for users.
   */
  peerId: string;
  title: string;
  username?: string;
  type: string;
  entity: any;
  inputEntity: any;
  /** How the reference was matched: "id" | "username" | "title". */
  resolvedBy: string;
};

function className(entity: any): string {
  const cn = entity?.className;
  if (typeof cn === "string" && cn) return cn;
  return entity?.constructor?.name ?? "Unknown";
}

/**
 * Which TL family an entity belongs to.
 *
 * Exported because the choice of API call depends on it and getting it wrong is
 * not a cosmetic bug: a legacy basic group and a supergroup are different
 * constructors, and passing the wrong one to Telegram produces a class-cast
 * error with no hint about which argument was wrong. `*Forbidden` variants are
 * folded in — they are the same peer, seen while banned or removed — so a caller
 * cannot silently fall through to the wrong branch.
 */
export function peerKind(entity: any): "user" | "basic-group" | "channel" | "unknown" {
  const cn = className(entity);
  if (/^User/.test(cn)) return "user";
  if (cn === "Chat" || cn === "ChatForbidden" || cn === "ChatEmpty") return "basic-group";
  if (/^Channel/.test(cn)) return "channel";
  return "unknown";
}

function typeOf(entity: any): string {
  const lower = className(entity).toLowerCase();
  if (lower.includes("user")) return "user";
  if (lower.includes("channel")) return "channel";
  if (lower.includes("chat")) return "group";
  return className(entity);
}

function titleOf(entity: any, fallback: string): string {
  const title = entity?.title;
  if (typeof title === "string" && title) return title;
  const name = [entity?.firstName, entity?.lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  const uname = entity?.username;
  return typeof uname === "string" && uname ? `@${uname}` : fallback;
}

/** Marked peer id: the canonical id form used by allowlists and Telegram itself. */
export function markedId(entity: any): string {
  const raw = entity?.id;
  if (raw === undefined || raw === null) return "";
  const id = String(raw);
  switch (className(entity)) {
    case "Channel":
    case "ChannelForbidden":
      return `-100${id}`;
    case "Chat":
    case "ChatForbidden":
      return `-${id}`;
    default:
      return id;
  }
}

function toResolved(entity: any, inputEntity: any, resolvedBy: string, fallback: string): ResolvedChat {
  return {
    id: entity?.id !== undefined ? String(entity.id) : "",
    peerId: markedId(entity),
    title: titleOf(entity, fallback),
    username: typeof entity?.username === "string" ? entity.username : undefined,
    type: typeOf(entity),
    entity,
    inputEntity,
    resolvedBy,
  };
}

/**
 * Find a chat by title among recent dialogs.
 *
 * Only *exact* (case-insensitive) title matches are auto-selected, and only
 * when unambiguous. A substring match is reported as candidates but never
 * auto-resolved: silently picking "Announcements" for "ann" would route a
 * message to the wrong chat.
 */
async function findByTitle(client: TelegramClient, query: string): Promise<any | null> {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const dialogs = await getDialogsCached(client);
  const exact: any[] = [];
  const partial: any[] = [];
  for (const d of dialogs) {
    const e: any = d.entity;
    if (!e) continue;
    const text = String(e.title ?? [e.firstName, e.lastName].filter(Boolean).join(" ")).toLowerCase().trim();
    if (!text) continue;
    if (text === needle) exact.push(e);
    else if (text.includes(needle)) partial.push(e);
  }

  if (exact.length === 1) return exact[0];

  const describe = (list: any[]) =>
    list
      .slice(0, 8)
      .map((e) => `${titleOf(e, "?")}${e.username ? ` (@${e.username})` : ""} [${markedId(e)}]`)
      .join("; ");

  if (exact.length > 1) {
    throw new Error(
      `Ambiguous chat title "${query}": ${exact.length} chats share this exact title: ${describe(exact)}. ` +
        `Use an @username or numeric id.`,
    );
  }
  if (partial.length > 0) {
    throw new Error(
      `No exact title match for "${query}". Close matches: ${describe(partial)}. ` +
        `Re-call with the exact title, an @username, or a numeric id.`,
    );
  }
  return null;
}

export async function resolveChat(client: TelegramClient, chat: string | number): Promise<ResolvedChat> {
  const ref = typeof chat === "number" ? chat : chat.trim();
  if (ref === "") throw new Error("chat is empty");

  if (/^(me|self)$/i.test(String(ref))) {
    const entity: any = await client.getEntity("me" as any);
    return toResolved(entity, await client.getInputEntity(entity as any), "self", "me");
  }

  try {
    const entity: any = await withFloodRetry(() => client.getEntity(ref as any));
    const resolvedBy = typeof ref === "string" && ref.replace(/^@/, "") === entity?.username ? "username" : "id";

    // gramJS falls back to a *fuzzy name search* when the reference is not a
    // username or an id, and that fallback is not reliable: `getEntity("Archive")`
    // on this account answers a user actually named "Message", which has nothing
    // to do with what was asked for. A silently wrong entity is the worst
    // possible outcome for a tool that then edits, deletes or messages it. When
    // the caller did not name a username or an id, the resolved entity must at
    // least carry the text they typed — otherwise it is a guess and is refused.
    const bare = typeof ref === "string" ? ref.replace(/^@/, "").trim() : "";
    const looksLikeId = /^-?\d+$/.test(bare);
    const looksLikeUsername = typeof entity?.username === "string" && entity.username.toLowerCase() === bare.toLowerCase();
    const looksLikePhone = /^\+?\d{6,}$/.test(bare.replace(/[\s-]/g, ""));
    if (!looksLikeId && !looksLikeUsername && !looksLikePhone) {
      const entityName = String(
        entity?.title ?? [entity?.firstName, entity?.lastName].filter(Boolean).join(" "),
      )
        .trim()
        .toLowerCase();
      if (entityName !== bare.toLowerCase()) {
        // A guessed entity. The exact-title search below refuses rather than
        // picking something close, so route through it by reporting not-found.
        const guessed = new Error(
          `Telegram resolved "${ref}" to ${JSON.stringify(entityName || "something unnamed")}, which is not what was asked for.`,
        ) as Error & { code?: string };
        guessed.code = "PEER_ID_INVALID";
        throw guessed;
      }
    }

    return toResolved(entity, await client.getInputEntity(entity as any), resolvedBy, String(ref));
  } catch (err) {
    const n = normalizeError(err);

    // A rate limit is not "not found", and it must be reported as such. This is
    // checked before the notFound list on purpose: FLOOD_WAIT is absent from
    // that list, so testing it afterwards made this branch unreachable.
    if (isFlood(n)) {
      // Keep the machine-readable code and the wait time. Throwing a plain Error
      // made this surface as `[UNKNOWN]`, so the harness — and any agent reading
      // the code — treated an actionable rate limit as a tool defect. `code` and
      // `seconds` are the conventions `normalizeError` already understands.
      const err = new Error(
        `Telegram rate-limited the lookup for "${ref}". Wait a moment and retry` +
          (n.retryAfterSec ? ` (~${n.retryAfterSec}s)` : "") +
          ".",
      ) as Error & { code?: string; seconds?: number };
      err.code = "FLOOD_WAIT";
      if (n.retryAfterSec) err.seconds = n.retryAfterSec;
      throw err;
    }

    const notFound = ["USERNAME_NOT_OCCUPIED", "USERNAME_INVALID", "PEER_ID_INVALID", "UNKNOWN"].includes(n.code);
    if (!notFound) throw err;

    const byTitle = await findByTitle(client, String(ref));
    if (byTitle) {
      return toResolved(byTitle, await client.getInputEntity(byTitle as any), "title", String(ref));
    }

    throw new Error(
      `${n.message} — no chat matched "${ref}" by username, id, phone, link, or title. ` +
        `Use telegram_list_chats to find the exact reference.`,
    );
  }
}

/** True when a normalized error is a Telegram rate limit. */
export function isFlood(n: ReturnType<typeof normalizeError>): boolean {
  return n.code === "FLOOD_WAIT" || /^FLOOD/i.test(n.message);
}

/**
 * Retry a call a couple of times when Telegram rate-limits it.
 *
 * Username lookups get flooded easily when an agent resolves the same handle
 * repeatedly, and the wait is normally a few seconds. Anything longer than
 * `MAX_FLOOD_WAIT_MS` is a genuine ban: it is reported instead of slept on, so
 * a tool call can never hang for minutes.
 */
export const MAX_FLOOD_WAIT_MS = 8000;

export async function withFloodRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const n = normalizeError(err);
      if (!isFlood(n) || attempt >= attempts) throw err;

      const waitMs = (n.retryAfterSec ?? 2 ** (attempt - 1)) * 1000;
      if (waitMs > MAX_FLOOD_WAIT_MS) throw err;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * Enforce network policy only when the operator configured an allowlist.
 * In open mode (allowAllChats with no allowlist) the guard is a no-op.
 */
export function enforce(_client: TelegramClient, resolved: ResolvedChat): void {
  const config = getConfig();
  if (
    !isAllowed(config, {
      id: resolved.id,
      username: resolved.username,
      title: resolved.title,
    })
  ) {
    throw new Error(
      `Chat "${resolved.title}" (id ${resolved.peerId || resolved.id}) is blocked by the allowlist. ` +
        `Add it to TELEGRAM_ALLOWED_CHATS or remove the allowlist for full access.`,
    );
  }
}

export async function requireChat(client: TelegramClient, chat: string | number): Promise<ResolvedChat> {
  const resolved = await resolveChat(client, chat);
  enforce(client, resolved);
  return resolved;
}

/** Compact chat reference for tool output (no accessHash, no raw entity). */
export function shapeChat(r: ResolvedChat): Record<string, unknown> {
  return {
    id: r.peerId || r.id,
    title: r.title,
    username: r.username ?? null,
    type: r.type,
    resolvedBy: r.resolvedBy,
  };
}

/**
 * gramJS hands back `date` as unix seconds (a number) for messages, but some
 * code paths (and Date fields elsewhere) give a real Date. Accept both, so
 * timestamps never silently disappear from tool output.
 */
export function toIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Anything below ~1e11 is seconds; larger is already milliseconds.
    const ms = value < 1e11 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

/**
 * Media as plain scalars, never a raw TL object.
 *
 * Returning only the class name (`"MessageMediaDocument"`) is the other extreme
 * of the raw-entity leak this project already fixed: a caller cannot tell a
 * forwarded PDF from a 12-byte `/etc/hostname` upload. Documents carry the file
 * name, MIME type and size; photos carry their largest encoding's size; web page
 * previews carry the URL and title.
 */
export function shapeMedia(media: any): Record<string, unknown> | null {
  if (!media) return null;
  const out: Record<string, unknown> = { type: String(media.className ?? "media") };

  const doc = media.document;
  if (doc) {
    const attrs: any[] = Array.isArray(doc.attributes) ? doc.attributes : [];
    const fileName = attrs.find((a: any) => typeof a?.fileName === "string")?.fileName;
    if (typeof fileName === "string" && fileName) out.fileName = fileName;
    if (typeof doc.mimeType === "string" && doc.mimeType) out.mime = doc.mimeType;
    const size = Number(doc.size ?? 0);
    if (size > 0) out.size = size;

    // A document's attributes describe what it actually is: a video knows its
    // width, height and length, an audio file knows its performer and title, a
    // voice note knows how many seconds it runs. Reporting only `size` turned
    // every attachment into "some bytes".
    for (const a of attrs) {
      const cls = String(a?.className ?? "");
      if (cls === "DocumentAttributeVideo") {
        if (Number(a.w)) out.width = Number(a.w);
        if (Number(a.h)) out.height = Number(a.h);
        if (Number(a.duration)) out.durationSec = Number(a.duration);
        if (a.roundMessage) out.round = true;
        if (a.supportsStreaming) out.streamable = true;
      } else if (cls === "DocumentAttributeAudio") {
        if (Number(a.duration)) out.durationSec = Number(a.duration);
        if (typeof a.performer === "string" && a.performer) out.performer = a.performer;
        if (typeof a.title === "string" && a.title) out.title = a.title;
        if (a.voice) out.voice = true;
      } else if (cls === "DocumentAttributeImageSize") {
        if (Number(a.w)) out.width = Number(a.w);
        if (Number(a.h)) out.height = Number(a.h);
      } else if (cls === "DocumentAttributeSticker") {
        out.sticker = true;
        if (typeof a.alt === "string" && a.alt) out.emoji = a.alt;
      } else if (cls === "DocumentAttributeFilename" && !out.fileName) {
        if (typeof a.fileName === "string" && a.fileName) out.fileName = a.fileName;
      } else if (cls === "DocumentAttributeAnimated") {
        out.animated = true;
      }
    }
  }

  // A photo keeps no document: its bytes are described by an encoding list, and
  // the largest entry is the closest thing to a file size. The same list carries
  // the pixel dimensions, which are what a caller actually needs to lay the
  // image out.
  const sizes: any[] = media.photo?.sizes ?? [];
  if (sizes.length) {
    let biggest = 0;
    let best: any = null;
    for (const s of sizes) {
      const n = Number(s?.size ?? (Array.isArray(s?.sizes) ? s.sizes[s.sizes.length - 1] : 0));
      if (Number.isFinite(n) && n > biggest) {
        biggest = n;
        best = s;
      }
    }
    if (!out.size && biggest > 0) out.size = biggest;
    // A PhotoSizeProgressive carries its dimensions too; take the largest entry.
    const dims = best ?? sizes[sizes.length - 1];
    if (!out.width && Number(dims?.w)) out.width = Number(dims.w);
    if (!out.height && Number(dims?.h)) out.height = Number(dims.h);
  }

  const page = media.webpage;
  if (page) {
    if (typeof page.url === "string" && page.url) out.url = page.url;
    if (typeof page.title === "string" && page.title) out.title = page.title;
    if (typeof page.siteName === "string" && page.siteName) out.site = page.siteName;
    if (typeof page.description === "string" && page.description) out.description = page.description;
    if (typeof page.type === "string" && page.type) out.previewType = page.type;
    // A webpage with a photo or document is a link preview with an image; saying
    // so lets a caller decide whether downloading it is worth a request.
    if (page.photo) out.hasPreviewPhoto = true;
    if (page.document) out.hasPreviewDocument = true;
  }

  // Polls and contacts carry the question and the options; without them the
  // message is just the word "poll".
  const poll = media.poll;
  if (poll) {
    out.poll = {
      question: poll.question ?? null,
      answers: (poll.answers ?? []).map((a: any) => ({
        text: a?.text ?? null,
        voters: a?.voters ?? null,
        chosen: Boolean(a?.chosen),
      })),
      quiz: Boolean(poll.quiz),
      publicVoters: Boolean(poll.publicVoters),
      multipleChoice: Boolean(poll.multipleChoice),
      closed: Boolean(poll.closed),
    };
  }

  const contact = media.userId !== undefined && media.firstName !== undefined ? media : null;
  if (contact) {
    out.contact = {
      userId: contact.userId !== undefined ? String(contact.userId) : null,
      firstName: contact.firstName ?? null,
      lastName: contact.lastName ?? null,
      phoneNumber: contact.phoneNumber ?? null,
    };
  }

  // A location is only useful with its coordinates.
  const geo = media.geo;
  if (geo) out.location = { lat: geo.lat ?? null, long: geo.long ?? null, accessHash: undefined };

  // A sticker or GIF served as a document still wants its emoji/alt, which the
  // attribute loop above already filled in.

  return out;
}

/**
 * The numeric id inside a Peer wrapper (`PeerUser.userId`, `PeerChannel.channelId`,
 * `PeerChat.chatId`). Falling back to `String(peer)` produced the literal
 * "[object Object]" for any message sent by a channel — `userId` is undefined
 * there, so the object itself was stringified.
 */
export function peerIdOf(peer: any): string | null {
  if (peer === undefined || peer === null) return null;
  const raw = peer?.userId ?? peer?.channelId ?? peer?.chatId ?? peer?.id;
  if (raw !== undefined && raw !== null) return String(raw);
  // A bare id, or a marked one, is already usable.
  if (typeof peer === "string" || typeof peer === "number" || typeof peer === "bigint") return String(peer);
  return null;
}

/**
 * A message entity in a form a caller can act on: the kind, where it sits, and
 * the target it points at.
 *
 * Only `entities.length` used to be reported, which told a reader that a message
 * contained three links and nothing about what they were or where. A mention,
 * a hashtag, a URL, a bold span and a text link all became the number 3.
 */
function shapeEntity(e: any): Record<string, unknown> | null {
  if (!e) return null;
  const kind = String(e.className ?? "")
    .replace(/^MessageEntity/, "")
    .replace(/^InputMessageEntity/, "");
  if (!kind) return null;
  const out: Record<string, unknown> = {
    type: kind.toLowerCase(),
    offset: Number(e.offset ?? 0),
    length: Number(e.length ?? 0),
  };
  // The target differs per kind: a text link and a mention both carry `url` in
  // some layers, a pre block carries `language`, a custom emoji carries its id.
  if (typeof e.url === "string" && e.url) out.url = e.url;
  if (typeof e.language === "string" && e.language) out.language = e.language;
  const docId = e.documentId ?? e.userId ?? e.chatId ?? e.channelId;
  if (docId !== undefined && docId !== null) out.targetId = String(docId);
  return out;
}

/**
 * The reaction summary of a message: which emoji, how many, and whether this
 * account is one of the reactors.
 */
function shapeReactions(r: any): Record<string, unknown> | null {
  const results: any[] = Array.isArray(r?.results) ? r.results : [];
  if (!results.length) return null;
  const items = results
    .map((x: any) => {
      const emoji = x?.reaction?.emoticon ?? x?.reaction?.documentId ?? null;
      return {
        emoji: emoji === null ? null : String(emoji),
        count: Number(x?.count ?? 0),
        chosen: Boolean(x?.chosenOrder !== undefined && x?.chosenOrder !== null),
      };
    })
    .filter((x) => x.emoji !== null);
  if (!items.length) return null;
  return { total: items.reduce((n, x) => n + x.count, 0), items };
}

/** The reply header: what is being replied to, plus the quote when there is one. */
function shapeReply(m: any): Record<string, unknown> | null {
  const r = m?.replyTo;
  if (!r) return null;
  const quote = typeof r.quoteText === "string" && r.quoteText ? r.quoteText : null;
  return {
    messageId: r.replyToMsgId ?? null,
    // Forum topics: a reply inside a topic carries both the topic root and the
    // message it answers. Collapsing them loses which thread the message is in.
    topId: r.replyToTopId ?? null,
    forumTopic: Boolean(r.forumTopic),
    quote,
    ...(r.replyToPeerId ? { peerId: peerIdOf(r.replyToPeerId) } : {}),
  };
}

export function shapeMessage(m: any): Record<string, unknown> {
  const reply = shapeReply(m);
  const reactions = shapeReactions(m?.reactions);
  const entities: any[] = Array.isArray(m?.entities) ? m.entities : [];
  const shapedEntities = entities.map(shapeEntity).filter(Boolean) as Record<string, unknown>[];

  // The sender's own name. gramJS caches the resolved sender on `_sender` for
  // every message it fetched, so reading it costs nothing — no extra request.
  // Without it a reader sees `senderId: "1815233335"` and has no idea who that
  // is; a channel post shows only the channel's own id.
  const sender = m?._sender ?? null;
  const senderFullName = [sender?.firstName, sender?.lastName].filter(Boolean).join(" ");
  const senderName = sender?.title ?? (senderFullName.length ? senderFullName : null);

  return {
    id: Number(m?.id ?? 0),
    date: toIso(m?.date),
    text: typeof m?.message === "string" ? m.message : "",
    senderId: peerIdOf(m?.fromId) ?? peerIdOf(m?.senderId),
    senderName: senderName && senderName.length ? senderName : null,
    outgoing: Boolean(m?.out),
    // A channel post carries the signature the channel set for it.
    postAuthor: typeof m?.postAuthor === "string" && m.postAuthor ? m.postAuthor : null,
    replyTo: reply?.messageId ?? null,
    ...(reply ? { reply } : {}),
    media: shapeMedia(m?.media),
    views: m?.views ?? null,
    forwards: m?.forwards ?? null,
    // A channel's discussion thread reports its own counters; losing them made a
    // post with 40 comments look like a post with none.
    // `replies.comments` is a *boolean* ("this is a comment thread"), not a
    // count — the count is `replies.replies`. Reading the flag as the number
    // printed `count: true`.
    ...(m?.replies
      ? {
          comments: {
            isCommentThread: Boolean(m.replies.comments),
            count: Number(m.replies.replies ?? 0),
            latestReplyId: m.replies.maxId ?? null,
            threadChannelId: m.replies.channelId !== undefined ? String(m.replies.channelId) : null,
          },
        }
      : {}),
    editDate: toIso(m?.editDate),
    pinned: Boolean(m?.pinned),
    // Every photo of an album shares one groupedId. Without it a gallery of ten
    // photos looks like ten unrelated messages.
    groupedId: m?.groupedId !== undefined && m?.groupedId !== null ? String(m.groupedId) : null,
    forward: m?.fwdFrom ? shapeForward(m.fwdFrom) : null,
    reactions,
    // A service message (joined, pinned, title changed) has an action and no
    // text. Reporting it as an empty message loses what actually happened.
    action: m?.action ? String(m.action.className ?? "action").replace(/^MessageAction/, "") : null,
    entities: shapedEntities.length ? shapedEntities : null,
    entitiesCount: shapedEntities.length,
  };
}

function shapeForward(f: any): Record<string, unknown> {
  return {
    fromName: f?.fromName ?? null,
    fromId: f?.fromId ? String(f.fromId.userId ?? f.fromId.channelId ?? f.fromId) : null,
    date: toIso(f?.date),
    channelPost: f?.channelPost ?? null,
    // "Forwarded from a private chat" is the common case: `fromId` is null but
    // the origin is still named. Reporting only fromId made those look like
    // forwards from nowhere.
    savedFromName: f?.savedFromName ?? null,
    savedFromPeer: f?.savedFromPeer ? peerIdOf(f.savedFromPeer) : null,
    savedFromMsgId: f?.savedFromMsgId ?? null,
    author: f?.postAuthor ?? null,
  };
}

/* ------------------------------------------------------------------ uploads */

/**
 * Wrap a local path as a gramJS `CustomFile` and upload it.
 *
 * `client.uploadFile()` accepts only a browser `File` or a gramJS `CustomFile`;
 * handing it a path or a Buffer throws `Could not create buffer from file …`.
 * `client.sendFile()` builds the wrapper internally, which is why sending a photo
 * worked while setting a chat photo silently never did. Every caller that needs
 * an `InputFile` (profile photo, chat photo) goes through here.
 */
export async function uploadFileFromPath(client: TelegramClient, filePath: string): Promise<unknown> {
  const { CustomFile } = await import("telegram/client/uploads.js");
  const stat = (await import("node:fs")).statSync(filePath);
  const path = await import("node:path");
  return client.uploadFile({
    file: new CustomFile(path.basename(filePath), stat.size, filePath),
    workers: 1,
  } as any);
}
