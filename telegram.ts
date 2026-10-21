/**
 * MTProto client lifecycle. One TelegramClient per process, lazy connect,
 * reuses the stored StringSession, never exposes secrets to callers.
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { getConfig, hasSession, readSessionString } from "./config.js";
import { createLogger } from "./logger.js";

export class NotAuthorizedError extends Error {
  /** Machine code so callers can branch on WHY, not just that it failed. */
  readonly code: string;
  constructor(message: string, code = "NOT_AUTHORIZED") {
    super(message);
    this.name = "NotAuthorizedError";
    this.code = code;
  }
}

let client: TelegramClient | null = null;
let connecting: Promise<TelegramClient> | null = null;
/**
 * Generation counter. `adoptClient()` (the MCP login flow) bumps it so an
 * in-flight `getClient()` connect cannot overwrite the freshly adopted client
 * when it resolves — otherwise a tool call racing a login would clobber the
 * session that login just created.
 */
let generation = 0;

export function isConnected(): boolean {
  return client !== null && (client as unknown as { connected?: boolean }).connected === true;
}

export async function getClient(): Promise<TelegramClient> {
  // A client that dropped its connection must never be handed to a tool. This
  // matters after a long idle period: gramJS reports connected:false and the
  // first tool call would otherwise fail with a confusing transport error.
  if (client && !isConnected()) {
    const dead = client;
    client = null;
    await dead.disconnect().catch(() => undefined);
  }
  if (client && isConnected()) return client;
  if (connecting) return connecting;

  const myGeneration = generation;
  connecting = (async () => {
    const config = getConfig();
    if (!hasSession(config)) {
      throw new NotAuthorizedError(
        "No Telegram session yet. Call telegram_login_start to authorize — the user types the " +
          "code Telegram sends them into this chat. No terminal needed.",
        "NO_SESSION",
      );
    }
    const session = new StringSession(readSessionString(config));
    const instance = new TelegramClient(session, config.apiId, config.apiHash, {
      connectionRetries: 3,
      autoReconnect: true,
      useWSS: false,
      // stdout belongs to the MCP transport — gramJS must never write there.
      baseLogger: createLogger(),
    });
    await instance.connect();
    if (!(await instance.isUserAuthorized())) {
      // Distinguish why it failed: a revoked key needs a fresh login, while a
      // duplicated one means a newer login superseded it. Same remedy, but the
      // operator needs to know which so they stop killing their own session.
      let reason = "AUTHORIZATION_MISSING";
      let detail = "the stored session is not logged in";
      try {
        await instance.getMe();
      } catch (err) {
        reason = String((err as { errorMessage?: string }).errorMessage ?? "AUTHORIZATION_MISSING");
        detail =
          reason === "AUTH_KEY_DUPLICATED"
            ? "a newer login superseded this session"
            : reason === "AUTH_KEY_UNREGISTERED"
              ? "this session was revoked or logged out"
              : detail;
      }
      await instance.disconnect().catch(() => undefined);
      throw new NotAuthorizedError(
        `Stored Telegram session is not authorized (${reason}: ${detail}). ` +
          "Call telegram_login_start to re-authorize — the code arrives in the user's Telegram app. " +
          "No terminal needed.",
      );
    }
    if (generation !== myGeneration) {
      // A login adopted a client while we were connecting; prefer theirs.
      await instance.disconnect().catch(() => undefined);
      if (client) return client;
    }
    client = instance;
    return instance;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function disconnect(): Promise<void> {
  if (!client) return;
  try {
    await client.disconnect();
  } finally {
    client = null;
  }
}

/**
 * Take ownership of a client that someone else connected (the MCP login flow).
 * After this the normal `getClient()` path reuses it, so tools work the instant
 * login finishes — no restart, no second handshake.
 */
export function adoptClient(instance: TelegramClient): void {
  generation += 1;
  client = instance;
  connecting = null;
}
