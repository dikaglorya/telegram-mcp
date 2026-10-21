/**
 * Local access policy: which chats this agent may touch.
 *
 * Two modes, selected by configuration:
 *   - open     : TELEGRAM_ALLOW_ALL_CHATS=true and no allowlist -> everything
 *                the account can reach is fair game (default).
 *   - allowlist: an allowlist is configured (env and/or state.json) -> only
 *                matching chats are permitted, regardless of allowAllChats.
 *
 * The allowlist always wins over TELEGRAM_ALLOW_ALL_CHATS: if the operator
 * took the trouble to name chats, restricting to those is the intent.
 */
import type { AllowEntry } from "./state.js";
import { loadState } from "./state.js";
import type { Config } from "./config.js";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export type ChatRef = {
  id?: string | number;
  username?: string;
  title?: string;
};

function norm(v: string): string {
  return v.trim().toLowerCase().replace(/^@/, "");
}

export function allowEntries(config: Config): AllowEntry[] {
  const fromState = loadState().allowlist;
  const fromEnv: AllowEntry[] = config.allowlist.map((value) => ({ value, addedAt: "env" }));
  const seen = new Set<string>();
  const out: AllowEntry[] = [];
  for (const entry of [...fromState, ...fromEnv]) {
    const key = norm(entry.value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/** True when at least one allowlist entry exists, i.e. allowlist mode. */
export function hasAllowlist(config: Config): boolean {
  return allowEntries(config).length > 0;
}

/**
 * Match an allowlist entry against a chat.
 *
 * Title matching is EXACT, never substring: an allowlist entry is an
 * authorization decision, and a substring rule would let "Alice's scam group"
 * pass an `alice` entry — and, combined with title-based resolution, silently
 * authorize the wrong chat.
 */
function matches(entry: AllowEntry, chat: ChatRef): boolean {
  const value = norm(entry.value);
  if (!value) return false;
  if (entry.id && chat.id !== undefined && String(chat.id) === String(entry.id)) return true;
  if (chat.id !== undefined && String(chat.id) === entry.value.trim()) return true;
  if (chat.username && norm(chat.username) === value) return true;
  if (chat.title && norm(chat.title) === value) return true;
  return false;
}

export function isAllowed(config: Config, chat: ChatRef): boolean {
  const entries = allowEntries(config);
  if (entries.length > 0) return entries.some((entry) => matches(entry, chat));
  return config.allowAllChats;
}
