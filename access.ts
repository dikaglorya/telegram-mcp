/**
 * Server-side access profiles.
 *
 * The allowlist decides *which chats* an agent may touch. A profile decides
 * *which operations* it may perform at all. Both are enforced in the server,
 * before a handler runs — never by asking the model nicely.
 *
 * Profiles are cumulative:
 *
 *   readonly  -> tools annotated readOnlyHint:true (plus login/auth tools)
 *   messaging -> readonly + sending, editing, reacting, forwarding, local media
 *   moderator -> messaging + group/channel administration and moderation
 *   full      -> everything, including account-destructive operations
 *
 * The default is `full`, so upgrading never silently removes a capability.
 * Set TELEGRAM_ACCESS_PROFILE in the MCP client environment to opt into a
 * narrower profile.
 */

export const ACCESS_PROFILES = ["readonly", "messaging", "moderator", "full"] as const;
export type AccessProfile = (typeof ACCESS_PROFILES)[number];

export type AccessSource = "default" | "env";

export type AccessState = {
  profile: AccessProfile;
  source: AccessSource;
  /** Set when TELEGRAM_ACCESS_PROFILE was invalid; the server fails closed. */
  error?: string;
};

export type ToolKind = "read" | "auth" | "message" | "moderate" | "account" | "unknown";

export type ToolAccess = {
  kind: ToolKind;
  minimumProfile: AccessProfile;
  /** False means the tool was not named in a category and fell back to full. */
  classified: boolean;
};

export type AnnotationsLike = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

const RANK: Record<AccessProfile, number> = {
  readonly: 0,
  messaging: 1,
  moderator: 2,
  full: 3,
};

/**
 * Login tools are deliberately available in every profile. A profile cannot
 * read anything without a session, and these four tools never read message
 * content or change Telegram state. They are still audited like every call.
 */
const AUTH_TOOLS = new Set([
  "telegram_login_start",
  "telegram_login_code",
  "telegram_login_password",
  "telegram_login_cancel",
]);

/** Writes that a normal messaging user expects to be able to do. */
const MESSAGING_TOOLS = new Set([
  "telegram_send_message",
  "telegram_send_photo",
  "telegram_send_file",
  "telegram_send_location",
  "telegram_send_poll",
  "telegram_send_contact",
  "telegram_edit_message",
  "telegram_forward_messages",
  "telegram_react",
  "telegram_pin_message",
  "telegram_unpin_all",
  "telegram_mark_read",
  "telegram_typing",
  "telegram_archive_chat",
  "telegram_mute_chat",
  "telegram_pin_chat",
  "telegram_download_media",
  "telegram_delete_download",
  "telegram_export_history",
]);

/** Group/channel administration and moderation. */
const MODERATOR_TOOLS = new Set([
  "telegram_invite_members",
  "telegram_promote_admin",
  "telegram_kick_member",
  "telegram_set_chat_photo",
  "telegram_create_group",
  "telegram_create_channel",
  "telegram_edit_chat",
  "telegram_export_invite_link",
  "telegram_delete_messages",
  "telegram_join_chat",
  "telegram_leave_chat",
]);

/**
 * Account-destructive or credential-writing operations. These stay in `full`
 * even though a moderator can administer a group: deleting an account's chat
 * history, deleting a chat, changing the profile, or revoking sessions is a
 * different blast radius.
 */
const FULL_ONLY_TOOLS = new Set([
  "telegram_setup",
  "telegram_update_profile",
  "telegram_set_my_photo",
  "telegram_add_contact",
  "telegram_delete_contacts",
  "telegram_block_user",
  "telegram_delete_chat",
  "telegram_clear_history",
  "telegram_logout_session",
  "telegram_list_sessions",
]);

export function isAccessProfile(value: string): value is AccessProfile {
  return (ACCESS_PROFILES as readonly string[]).includes(value);
}

/**
 * Read the configured profile without needing Telegram credentials. An invalid
 * value fails closed to `readonly` and carries an explanation, so a typo can
 * never silently leave an agent at full access.
 */
export function readAccessProfile(env: NodeJS.ProcessEnv = process.env): AccessState {
  const raw = String(env.TELEGRAM_ACCESS_PROFILE ?? "").trim().toLowerCase();
  if (!raw) return { profile: "full", source: "default" };
  if (isAccessProfile(raw)) return { profile: raw, source: "env" };
  return {
    profile: "readonly",
    source: "env",
    error:
      `Invalid TELEGRAM_ACCESS_PROFILE=${JSON.stringify(raw)}. ` +
      `Expected one of: ${ACCESS_PROFILES.join(", ")}. Failing closed to readonly.`,
  };
}

export function classifyTool(name: string, annotations?: AnnotationsLike): ToolAccess {
  if (annotations?.readOnlyHint === true) {
    return { kind: "read", minimumProfile: "readonly", classified: true };
  }
  if (AUTH_TOOLS.has(name)) {
    return { kind: "auth", minimumProfile: "readonly", classified: true };
  }
  if (MESSAGING_TOOLS.has(name)) {
    return { kind: "message", minimumProfile: "messaging", classified: true };
  }
  if (MODERATOR_TOOLS.has(name)) {
    return { kind: "moderate", minimumProfile: "moderator", classified: true };
  }
  if (FULL_ONLY_TOOLS.has(name)) {
    return { kind: "account", minimumProfile: "full", classified: true };
  }
  // Fail closed for a write-capable tool nobody classified. `full` is allowed
  // to run it; every narrower profile refuses until the category is declared.
  return { kind: "unknown", minimumProfile: "full", classified: false };
}

export function profileAllows(profile: AccessProfile, required: AccessProfile): boolean {
  return RANK[profile] >= RANK[required];
}

export type AccessDecision =
  | { allowed: true; requiredProfile: AccessProfile; kind: ToolKind }
  | {
      allowed: false;
      requiredProfile: AccessProfile;
      kind: ToolKind;
      profile: AccessProfile;
      reason: string;
      hint: string;
    };

export function checkToolAccess(
  name: string,
  annotations: AnnotationsLike | undefined,
  profile: AccessProfile,
): AccessDecision {
  const access = classifyTool(name, annotations);
  if (profileAllows(profile, access.minimumProfile)) {
    return { allowed: true, requiredProfile: access.minimumProfile, kind: access.kind };
  }
  return {
    allowed: false,
    requiredProfile: access.minimumProfile,
    kind: access.kind,
    profile,
    reason:
      `Access profile "${profile}" does not allow ${name}; ` +
      `it requires "${access.minimumProfile}".`,
    hint:
      `Set TELEGRAM_ACCESS_PROFILE=${access.minimumProfile} (or "full") in the MCP client ` +
      `environment and restart the server. Nothing was sent to Telegram.`,
  };
}

export function profileDescription(profile: AccessProfile): string {
  switch (profile) {
    case "readonly":
      return "Read-only: reads, searches, downloads nothing; no Telegram writes.";
    case "messaging":
      return "Messaging: read, send, edit, react, forward and local media operations.";
    case "moderator":
      return "Moderator: messaging plus group/channel administration and moderation.";
    case "full":
      return "Full: every tool the account itself is allowed to use.";
  }
}
