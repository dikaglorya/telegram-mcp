/**
 * Session and privacy tools: which devices are logged in, and how to cut off the
 * ones that are not this process.
 *
 * `account.GetAuthorizations` was unreachable from the toolset until now — an
 * agent could not even tell that a session existed elsewhere, let alone end one.
 * `account.ResetAuthorization` is the only way to revoke it, and it takes the
 * per-session `hash` rather than the id, so the hash is what this surfaces.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "telegram";
import { getClient } from "./telegram.js";
import { ok, fail, guard } from "./util.js";
import { toIso } from "./helpers.js";
import { normalizeError } from "./errors.js";

type Authorization = {
  hash?: unknown;
  current?: boolean;
  deviceModel?: string;
  platform?: string;
  systemVersion?: string;
  appName?: string;
  appVersion?: string;
  ip?: string;
  country?: string;
  region?: string;
  dateCreated?: number;
  dateActive?: number;
  officialApp?: boolean;
  passwordPending?: boolean;
  unconfirmed?: boolean;
};

function shapeAuth(a: Authorization) {
  return {
    // The hash is what ResetAuthorization takes; it is not a secret in the
    // credential sense (it identifies a session to revoke, and is useless
    // without the account's own auth key), but it is still account-scoped.
    hash: a.hash !== undefined ? String(a.hash) : null,
    current: Boolean(a.current),
    device: a.deviceModel ?? null,
    platform: a.platform ?? null,
    system: a.systemVersion ?? null,
    app: [a.appName, a.appVersion].filter(Boolean).join(" ") || null,
    ip: a.ip ?? null,
    location: [a.country, a.region].filter(Boolean).join(", ") || null,
    createdAt: toIso(a.dateCreated),
    lastActiveAt: toIso(a.dateActive),
    officialApp: Boolean(a.officialApp),
    passwordPending: Boolean(a.passwordPending),
    unconfirmed: Boolean(a.unconfirmed),
  };
}

export function registerSecurityTools(server: McpServer): void {
  server.registerTool(
    "telegram_list_sessions",
    {
      title: "List active sessions",
      description:
        "List every device currently logged into this account, marking the one running this server " +
        "with current:true. Each entry carries the hash that telegram_logout_session needs.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const client = await getClient();
        const result: any = await client.invoke(new Api.account.GetAuthorizations({} as any));
        const list: Authorization[] = Array.isArray(result?.authorizations) ? result.authorizations : [];
        const shaped = list.map(shapeAuth);

        return ok({
          count: shaped.length,
          currentCount: shaped.filter((s) => s.current).length,
          sessions: shaped,
        });
      }),
  );

  server.registerTool(
    "telegram_logout_session",
    {
      title: "Log out another session",
      description:
        "Revoke one session by the hash reported by telegram_list_sessions. Pass all=true to revoke " +
        "every session except this one. Refuses to revoke the session running this server.",
      inputSchema: {
        hash: z.string().min(1).optional(),
        all: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    },
    async ({ hash, all }) =>
      guard(async () => {
        if (!hash && !all) return fail("pass hash=<from telegram_list_sessions> or all=true");

        const client = await getClient();
        const result: any = await client.invoke(new Api.account.GetAuthorizations({} as any));
        const list: Authorization[] = Array.isArray(result?.authorizations) ? result.authorizations : [];

        const targets = all
          ? list.filter((a) => !a.current)
          : list.filter((a) => String(a.hash) === String(hash));

        if (!all && targets.length === 0) {
          const known = list.map((a) => ({ hash: String(a.hash), device: a.deviceModel ?? null, current: Boolean(a.current) }));
          return fail(`no session with that hash`, { sessions: known });
        }
        if (all && targets.length === 0) {
          return ok({ revoked: 0, reason: "this account has no other active session", sessions: list.map(shapeAuth) });
        }
        if (targets.some((a) => a.current)) {
          return fail(
            "refusing to revoke the session running this server — it would cut this agent off mid-call",
            { hint: "pass all=true to keep the current session and revoke the rest" },
          );
        }

        const revoked: string[] = [];
        const refused: { hash: string; code: string }[] = [];
        for (const a of targets) {
          try {
            await client.invoke(new Api.account.ResetAuthorization({ hash: a.hash } as any));
            revoked.push(String(a.hash));
          } catch (err) {
            // Telegram refuses to revoke another session from a fresh one
            // (FRESH_RESET_AUTHORISATION_FORBIDDEN). Stopping the whole loop on the
            // first refusal would hide the rest, so each is reported individually.
            const n = normalizeError(err);
            refused.push({ hash: String(a.hash), code: n.code });
          }
        }

        // Read back: a call returning without error is not proof the device is gone.
        const after: any = await client.invoke(new Api.account.GetAuthorizations({} as any));
        const remaining: Authorization[] = Array.isArray(after?.authorizations) ? after.authorizations : [];
        const stillThere = revoked.filter((h) => remaining.some((a) => String(a.hash) === h));

        return ok({
          revoked: revoked.length,
          revokedHashes: revoked,
          refused,
          verified: stillThere.length === 0,
          remainingCount: remaining.length,
          ...(stillThere.length ? { stillPresent: stillThere } : {}),
          ...(refused.length
            ? {
                hint:
                  "Telegram only lets a session that is old enough revoke others " +
                  "(FRESH_RESET_AUTHORISATION_FORBIDDEN). Log the device out from the Telegram app instead.",
              }
            : {}),
        });
      }),
  );
}
