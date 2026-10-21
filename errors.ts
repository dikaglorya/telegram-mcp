/**
 * gramJS / RPC error normalization.
 *
 * gramJS throws RPCError with `.errorMessage` (e.g. "FLOOD_WAIT_42"),
 * `.code` (number) and sometimes `.seconds`. Plain Errors carry only a
 * message. This module turns any throwable into a stable, machine-readable
 * shape so MCP clients get an actionable hint instead of a bare code.
 */

export type NormalizedError = {
  /** Stable machine code, e.g. FLOOD_WAIT, CHANNEL_INVALID, NOT_AUTHORIZED. */
  code: string;
  /** Short human-readable summary. */
  message: string;
  /** Actionable next step for the caller/agent. */
  hint?: string;
  /** Seconds to wait, when the API asked us to back off. */
  retryAfterSec?: number;
  /** True when retrying the identical call later is expected to succeed. */
  retryable: boolean;
};

/** Hints for codes raised by our own code (not by the Telegram API). */
function hintForOwnCode(code: string): string | undefined {
  switch (code) {
    case "NO_SESSION":
    case "NOT_AUTHORIZED":
      return "Call telegram_login_start to authorize — the code arrives in the user's Telegram app. No terminal needed.";
    case "ACCESS_DENIED":
      return "The chat is not in TELEGRAM_ALLOWED_CHATS. Add it, or remove the allowlist for full access.";
    default:
      return undefined;
  }
}

const HINTS: Record<string, { hint: string; retryable: boolean }> = {
  NO_SESSION: {
    hint: "No stored session. Call telegram_login_start to authorize over MCP.",
    retryable: false,
  },
  NOT_AUTHORIZED: {
    hint: "The session is not authorized. Call telegram_login_start to re-authorize.",
    retryable: false,
  },
  AUTH_KEY_DUPLICATED: {
    hint: "A newer login replaced this session. Call telegram_login_start with force:true to re-authorize this client.",
    retryable: false,
  },
  AUTH_KEY_UNREGISTERED: {
    hint: "This session was revoked or logged out. Call telegram_login_start to re-authorize.",
    retryable: false,
  },
  ACCESS_DENIED: {
    hint: "Blocked by the local allowlist. Adjust TELEGRAM_ALLOWED_CHATS.",
    retryable: false,
  },
  NETWORK: {
    hint: "Connection to Telegram failed or dropped. Retry; if it persists, check the network/proxy.",
    retryable: true,
  },
  TIMEOUT_: {
    hint: "Timed out talking to Telegram. Retry.",
    retryable: true,
  },
  FILE_NOT_FOUND: {
    hint: "The local path does not exist. Pass an absolute path that exists on the MCP host.",
    retryable: false,
  },
  FILE_FORBIDDEN: {
    hint: "The MCP process cannot read that path (permissions).",
    retryable: false,
  },
  FLOOD_WAIT: {
    hint: "Telegram rate-limited this call. Wait retryAfterSec seconds, then retry. Do not parallelize identical writes.",
    retryable: true,
  },
  FRESH_RESET_AUTHORISATION_FORBIDDEN: {
    hint:
      "Telegram refuses to log out another session until this one is old enough (roughly 24h since " +
      "the login). Nothing is wrong with the account or the request — log the other device out from " +
      "the Telegram app, or retry this tool after the session has aged. Revoking the current session " +
      "is never allowed.",
    retryable: true,
  },
  SLOWMODE_WAIT: {
    hint: "Slow mode is enabled in this chat. Wait retryAfterSec seconds before sending again.",
    retryable: true,
  },
  CHANNEL_INVALID: {
    hint: "The channel reference is stale or has no access hash. Re-resolve it via telegram_list_chats or use the @username.",
    retryable: false,
  },
  PEER_ID_INVALID: {
    hint: "Unknown peer. Pass an @username, a t.me link, a phone number, or a chat from telegram_list_chats.",
    retryable: false,
  },
  CHANNEL_PRIVATE: {
    hint: "This chat is private: the account is not a member or was removed. Join first (telegram_join_chat) or request access.",
    retryable: false,
  },
  PREMIUM_ACCOUNT_REQUIRED: {
    hint: "This feature needs a Telegram Premium account. It cannot be enabled from the MCP side.",
    retryable: false,
  },
  PREMIUM_FEATURE_REQUIRED: {
    hint: "This feature needs a Telegram Premium account.",
    retryable: false,
  },
  CHAT_WRITE_FORBIDDEN: {
    hint: "The account cannot post here (no permission, read-only channel, or restricted).",
    retryable: false,
  },
  CHAT_ADMIN_REQUIRED: {
    hint: "This action requires admin rights in the chat. The account is an admin but is missing this specific right (e.g. changeInfo), and Telegram does not let an admin grant themselves a right — ask the chat's creator to restore it.",
    retryable: false,
  },
  USER_ID_INVALID: {
    hint: "Telegram would not accept that user id for this call. In a broadcast channel an admin cannot change their own rights, and a bare numeric id is not enough — resolve the user from the chat's participant list instead.",
    retryable: false,
  },
  USER_BANNED_IN_CHANNEL: {
    hint: "The account is banned in this chat and cannot interact with it.",
    retryable: false,
  },
  USERNAME_NOT_OCCUPIED: {
    hint: "No Telegram entity matches that username. Check the spelling or use telegram_search_users.",
    retryable: false,
  },
  USERNAME_INVALID: {
    hint: "That username is not valid. Check the spelling.",
    retryable: false,
  },
  MESSAGE_ID_INVALID: {
    hint: "Message id does not exist in that chat (deleted, or wrong chat).",
    retryable: false,
  },
  MESSAGE_NOT_MODIFIED: {
    hint: "The new content is identical to the current message; nothing was changed.",
    retryable: false,
  },
  CHAT_NOT_MODIFIED: {
    hint: "The chat already has that title/description, so Telegram changed nothing. This is not an error.",
    retryable: false,
  },
  CHAT_TITLE_EMPTY: {
    hint: "A chat title cannot be empty.",
    retryable: false,
  },
  CHAT_ABOUT_NOT_MODIFIED: {
    hint: "The chat already has that description, so Telegram changed nothing. This is not an error.",
    retryable: false,
  },
  MESSAGE_EDIT_TIME_EXPIRED: {
    hint: "Telegram no longer allows editing this message.",
    retryable: false,
  },
  MESSAGE_DELETE_FORBIDDEN: {
    hint: "The account cannot delete this message (not sender, not admin, or too old).",
    retryable: false,
  },
  USER_NOT_PARTICIPANT: {
    hint: "The account is not a participant of that chat.",
    retryable: false,
  },
  INVITE_HASH_EXPIRED: {
    hint: "The invite link expired. Ask for a fresh one.",
    retryable: false,
  },
  INVITE_HASH_INVALID: {
    hint: "The invite link is malformed or revoked.",
    retryable: false,
  },
  API_ID_INVALID: {
    hint: "TELEGRAM_API_ID / TELEGRAM_API_HASH are invalid. Re-check my.telegram.org and .env.",
    retryable: false,
  },
  SESSION_REVOKED: {
    hint: "The stored session was revoked. Call telegram_login_start to re-authorize.",
    retryable: false,
  },
  TOO_MANY_REQUESTS: {
    hint: "Too many attempts. Back off for a minute and retry.",
    retryable: true,
  },
  FILE_PART_INVALID: {
    hint: "Upload was rejected (file changed or too large mid-upload). Retry the upload.",
    retryable: true,
  },
  MEDIA_CAPTION_TOO_LONG: {
    hint: "Caption exceeds the limit. Shorten it (photo/video: 1024, text: 4096).",
    retryable: false,
  },
  FILE_TOO_LARGE: {
    hint: "File exceeds the size Telegram allows for this upload path.",
    retryable: false,
  },
  TIMEOUT: {
    hint: "Network timeout talking to Telegram. Retry.",
    retryable: true,
  },
  PHOTO_CROP_SIZE_SMALL: {
    hint: "The image is too small for a profile/chat photo. Telegram needs roughly a 400x400 or larger square; upscale it and retry.",
    retryable: false,
  },
  PHOTO_INVALID_DIMENSIONS: {
    hint: "The image dimensions are not accepted (too large or not a square-ish aspect). Resize it and retry.",
    retryable: false,
  },
  PHOTO_EXT_INVALID: {
    hint: "The file extension is not a supported image type. Use .jpg, .png or .webp.",
    retryable: false,
  },
  IMAGE_PROCESS_FAILED: {
    hint: "Telegram could not process the image. Re-encode it as a plain JPEG or PNG and retry.",
    retryable: false,
  },
};

/** Normalize any thrown value into a stable shape. */
export function normalizeError(err: unknown): NormalizedError {
  const raw = err instanceof Error ? err.message : String(err);
  const anyErr = err as { errorMessage?: unknown; code?: unknown; seconds?: unknown; name?: unknown };

  // Errors that already carry a semantic machine code (NotAuthorizedError with
  // NO_SESSION / AUTH_KEY_*, AccessDeniedError) must keep it. Node system errors
  // (ERR_*, ENOENT, ...) are excluded: they say nothing about Telegram and would
  // short-circuit the message sniffing below.
  const ownCode = typeof anyErr?.code === "string" ? anyErr.code : "";
  if (ownCode && /^[A-Z][A-Z0-9_]*$/.test(ownCode) && !/^(ERR_|E[A-Z]{2,}$)/.test(ownCode) && !ownCode.startsWith("NODE_")) {
    const known = HINTS[ownCode];
    // An error that names its own code may also know its own wait time — a flood
    // raised during a lookup does. Dropping it here left the caller with a
    // retryable code and no idea how long to wait.
    const ownSeconds = Number(anyErr?.seconds ?? (anyErr as { retryAfterSec?: unknown })?.retryAfterSec);
    return {
      code: ownCode,
      message: stripCause(raw),
      hint: known?.hint ?? hintForOwnCode(ownCode),
      retryAfterSec: Number.isFinite(ownSeconds) && ownSeconds > 0 ? ownSeconds : undefined,
      retryable: known?.retryable ?? false,
    };
  }

  // gramJS splits a flood across three fields: `message` carries the human text
  // ("A wait of 31951 seconds is required"), `errorMessage` carries the bare code
  // ("FLOOD"), and `seconds` carries the number. Preferring `errorMessage` here
  // discarded the only place the duration was written down, so a 9-hour flood was
  // reported as "rate-limited, no duration given" — advice that led straight into
  // another throttled call.
  const errorMessage = typeof anyErr?.errorMessage === "string" ? anyErr.errorMessage : "";
  // Use the richer of the two: a bare code adds nothing, a sentence with a number
  // adds everything.
  const looksBare = errorMessage !== "" && !/\d/.test(errorMessage) && /\d/.test(raw);
  const source = looksBare ? raw : errorMessage || raw;

  // "A wait of 42 seconds is required (caused by messages.SendMessage)"
  const waitSentence = /a wait of (\d+) seconds is required/i.exec(source);
  // "FLOOD_WAIT_42", "SLOWMODE_WAIT_7"
  const waitCode = /\b(FLOOD_WAIT|SLOWMODE_WAIT)(?:_(\d+))?\b/.exec(source);

  let retryAfterSec: number | undefined;
  if (waitSentence) retryAfterSec = Number(waitSentence[1]);
  else if (waitCode?.[2]) retryAfterSec = Number(waitCode[2]);
  // `FloodWaitError.seconds` is the authoritative field even when the text was
  // stripped somewhere upstream. Checking it last means the text wins when both
  // exist, but a bare "FLOOD" still gets its duration back.
  else if (Number.isFinite(Number(anyErr?.seconds)) && Number(anyErr?.seconds) > 0) {
    retryAfterSec = Number(anyErr.seconds);
  }

  // Extract a canonical UPPER_SNAKE code when present.
  const codeMatch = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/.exec(source);
  let code = codeMatch?.[1] ?? "";

  if (retryAfterSec !== undefined) code = waitCode?.[1] ?? "FLOOD_WAIT";

  if (!code) {
    if (/^FLOOD\b/i.test(source)) code = "FLOOD_WAIT";
    else if (/not authorized|not logged in|no session/i.test(source)) code = "NOT_AUTHORIZED";
    else if (/timed? ?out/i.test(source)) code = "TIMEOUT";
    else if (/ECONN|ENOTFOUND|ETIMEDOUT|socket hang up/i.test(source)) code = "NETWORK";
    else if (/ENOENT/.test(source)) code = "FILE_NOT_FOUND";
    else if (/EACCES|EPERM/.test(source)) code = "FILE_FORBIDDEN";
    else code = "UNKNOWN";
  }

  const known = HINTS[code];
  const retryable = known?.retryable ?? Boolean(anyErr?.code && Number(anyErr.code) >= 500);

  const message = stripCause(source);

  // Telegram sometimes answers with a bare "FLOOD" and no wait time. The
  // generic hint then reads "Wait retryAfterSec seconds" with no number in it,
  // which tells the caller nothing it can act on.
  const bareFlood = (code === "FLOOD_WAIT" || code === "SLOWMODE_WAIT") && retryAfterSec === undefined;
  // A flood measured in hours is not something to retry: telling the caller to
  // "wait a minute and try again" turns one throttle into a loop that keeps
  // extending the penalty. Say plainly that this one is not worth waiting for.
  const longFlood = retryAfterSec !== undefined && retryAfterSec >= 3600;
  const hint = longFlood
    ? `Telegram has blocked this call for about ${Math.round(retryAfterSec! / 3600)} hour(s). ` +
      `Do not retry it in a loop — each attempt extends the penalty. Use a different approach or wait it out.`
    : bareFlood
      ? "Telegram rate-limited this call and did not say for how long. Wait at least a minute, then retry one call at a time."
      : known?.hint;

  return { code, message, hint, retryAfterSec, retryable };
}

/** Drop gramJS' "(caused by X)" noise from the human message. */
function stripCause(s: string): string {
  return s.replace(/\s*\(caused by [^)]*\)\s*$/i, "").trim();
}

/** Serialize a normalized error to the text form returned to MCP clients. */
export function formatError(n: NormalizedError): string {
  const parts = [`[${n.code}] ${n.message}`];
  if (n.retryAfterSec !== undefined) parts.push(`retry_after_seconds: ${n.retryAfterSec}`);
  if (n.hint) parts.push(`hint: ${n.hint}`);
  return parts.join("\n");
}
