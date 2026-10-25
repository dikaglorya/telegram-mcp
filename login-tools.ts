/**
 * Login over MCP — so a user never has to open a terminal.
 *
 * The hard limit is Telegram itself: the login code is delivered to the user's
 * phone/app, so a code must round-trip through the agent's chat once. This
 * module makes that the ONLY manual step:
 *
 *   telegram_login_start  -> asks Telegram to send the code
 *   telegram_login_code   -> takes the code the user typed in chat
 *   telegram_login_password -> only if the account has 2FA
 *
 * Secret hygiene: the OTP and the 2FA password arrive as tool *arguments*,
 * which the registry passes to the audit logger. Both handlers therefore wrap
 * their body in `withToolContext` with a scrubbed arg view, so the real values
 * never reach state.json, the audit log, or any diagnostic output. The pending
 * flow lives in module memory only.
 *
 * Resume: if the process restarts mid-login, `telegram_login_start` re-sends a
 * code; nothing secret is lost because nothing secret was stored.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram";
import { getConfig, hasSession, readSessionString, writeSessionString, invalidateRedactionCache } from "./config.js";
import { createLogger } from "./logger.js";
import { disconnect, adoptClient } from "./telegram.js";
import { ok, guard } from "./util.js";

type Stage = "phone" | "code" | "password" | "done";

type Pending = {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
  stage: Stage;
  createdAt: number;
};

let pending: Pending | null = null;
const PENDING_TTL_MS = 10 * 60 * 1000;
let loginCleanupInterval: ReturnType<typeof setInterval> | null = null;

function expired(): boolean {
  return pending !== null && Date.now() - pending.createdAt > PENDING_TTL_MS;
}

async function discardPending(): Promise<void> {
  if (!pending) return;
  const client = pending.client;
  pending = null;
  await client.disconnect().catch(() => undefined);
}

function needPending(): Pending {
  if (!pending) {
    throw new Error(
      "No login in progress. Call telegram_login_start first (optionally with a phone number).",
    );
  }
  if (expired()) {
    void discardPending();
    throw new Error("The login attempt expired after 10 minutes. Call telegram_login_start again.");
  }
  return pending;
}

/** Periodic cleanup for abandoned pending logins — prevents socket leaks. */
if (typeof setInterval === "function") {
  loginCleanupInterval = setInterval(() => {
    if (expired()) {
      void discardPending();
    }
  }, 60_000);
  loginCleanupInterval.unref?.();
}

/** Clear the login cleanup interval (called on shutdown). */
export function clearLoginCleanupInterval(): void {
  if (loginCleanupInterval) {
    clearInterval(loginCleanupInterval);
    loginCleanupInterval = null;
  }
}

/** Telegram requires a country code and no spaces/dashes. */
function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (!digits.startsWith("+")) {
    throw new Error(
      `Phone must be in international format with a leading +, e.g. +15551234567 (got "${raw}").`,
    );
  }
  return digits;
}

async function finishLogin(p: Pending, user: Record<string, unknown>): Promise<Record<string, unknown>> {
  const session = (p.client.session as StringSession).save();
  writeSessionString(getConfig(), session);
  invalidateRedactionCache();
  pending = null;

  // Hand the live client to the server so tools work immediately, without a
  // restart or a reconnect round-trip.
  adoptClient(p.client);

  return {
    authorized: true,
    id: String(user.id ?? ""),
    username: user.username ?? null,
    firstName: user.firstName ?? null,
    phone: user.phone ?? null,
  };
}

export function registerLoginTools(server: McpServer): void {
  server.registerTool(
    "telegram_login_start",
    {
      title: "Start Telegram login",
      description:
        "Begin authorization when no session exists. Sends the login code to the user's Telegram app. " +
        "Pass `phone` in international format (+15551234567) unless TELEGRAM_PHONE is set in the environment. " +
        "After calling this, ask the user to read the code Telegram just sent them and call telegram_login_code. " +
        "NEVER ask the user to paste the code anywhere except this chat, and never repeat it back.",
      inputSchema: {
        phone: z
          .string()
          .optional()
          .describe("International phone number with leading +, e.g. +15551234567"),
        force: z
          .boolean()
          .default(false)
          .describe("Replace an existing working session with a fresh one. Only when the user asks."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async ({ phone, force }) =>
      guard(async () => {
        const config = getConfig();

        // Refuse to silently replace a working session: a new login invalidates
        // the old auth key (AUTH_KEY_DUPLICATED) and breaks every other client.
        if (hasSession(config) && !force) {
          const existing = new TelegramClient(
            new StringSession(readSessionString(config)),
            config.apiId,
            config.apiHash,
            { connectionRetries: 1, baseLogger: createLogger() },
          );
          try {
            await existing.connect();
            if (await existing.isUserAuthorized()) {
              const me = (await existing.getMe()) as unknown as Record<string, unknown>;
              await discardPending();
              adoptClient(existing);
              return ok({
                alreadyAuthorized: true,
                id: String(me.id ?? ""),
                username: me.username ?? null,
                note: "A working session already exists; nothing was changed. Pass force:true only to replace it.",
              });
            }
          } catch {
            /* dead session — safe to replace */
          }
          await existing.disconnect().catch(() => undefined);
        }

        await discardPending();

        const rawPhone = phone?.trim() || process.env.TELEGRAM_PHONE?.trim();
        if (!rawPhone) {
          return ok({
            needsPhone: true,
            message:
              "No phone number supplied. Ask the user for their number in international format " +
              "(+15551234567), then call telegram_login_start again with it.",
          });
        }
        const normalized = normalizePhone(rawPhone);

        const client = new TelegramClient(new StringSession(""), config.apiId, config.apiHash, {
          connectionRetries: 3,
          baseLogger: createLogger(),
        });
        await client.connect();

        try {
          const sent = await client.invoke(
            new Api.auth.SendCode({
              phoneNumber: normalized,
              apiId: config.apiId,
              apiHash: config.apiHash,
              settings: new Api.CodeSettings({}),
            }),
          );

          if (sent instanceof Api.auth.SentCodeSuccess) {
            // Telegram skipped the code (already-authorized key on this device).
            const me = (await client.getMe()) as unknown as Record<string, unknown>;
            const result = await finishLogin(
              { client, phone: normalized, phoneCodeHash: "", stage: "done", createdAt: Date.now() },
              me,
            );
            return ok({ ...result, codeRequired: false });
          }

          const delivery =
            sent.type instanceof Api.auth.SentCodeTypeApp
              ? "your Telegram app"
              : sent.type instanceof Api.auth.SentCodeTypeSms
                ? "SMS"
                : sent.type instanceof Api.auth.SentCodeTypeCall
                  ? "a phone call"
                  : "Telegram";

          pending = {
            client,
            phone: normalized,
            phoneCodeHash: sent.phoneCodeHash,
            stage: "code",
            createdAt: Date.now(),
          };

          return ok({
            codeSent: true,
            deliveredTo: delivery,
            phone: normalized.replace(/\d(?=\d{2})/g, "•"),
            next:
              "Tell the user the code was sent and ask them to type it here. Then call " +
              "telegram_login_code with what they typed. Do not repeat the code back to them.",
          });
        } catch (err) {
          await client.disconnect().catch(() => undefined);
          throw err;
        }
      }),
  );

  server.registerTool(
    "telegram_login_code",
    {
      title: "Submit the Telegram login code",
      description:
        "Finish login by submitting the code Telegram sent the user. Call telegram_login_start first. " +
        "If the account has 2FA, this returns needsPassword:true and you must ask the user for their " +
        "2FA password, then call telegram_login_password. Never echo the code or password back.",
      inputSchema: {
        code: z.string().min(1).describe("The code the user typed, digits only."),
      },
      // Keeps the OTP out of audit.log at the registry layer (read by wrapServer).
      _meta: { secretArgs: ["code"] },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async ({ code }) =>
      guard(async () => {
        const p = needPending();
        const clean = code.replace(/[^0-9]/g, "");
        if (!clean) return ok({ error: "The login code must contain digits." });

        try {
          // signIn returns either success or SESSION_PASSWORD_NEEDED (2FA).
          const result: any = await p.client.invoke(
            new Api.auth.SignIn({
              phoneNumber: p.phone,
              phoneCodeHash: p.phoneCodeHash,
              phoneCode: clean,
            }),
          );

          if (result instanceof Api.auth.Authorization) {
            const me = (await p.client.getMe()) as unknown as Record<string, unknown>;
            const done = await finishLogin(p, me);
            return ok({ ...done, codeRequired: false, passwordRequired: false });
          }

          // Should not be reachable, but fail loudly rather than claim success.
          return ok({ error: "Unexpected sign-in response.", resultType: String(result?.className ?? "") });
        } catch (err) {
          const msg = String((err as { errorMessage?: string }).errorMessage ?? (err as Error).message ?? "");

          if (msg === "SESSION_PASSWORD_NEEDED") {
            p.stage = "password";
            return ok({
              passwordRequired: true,
              next:
                "This account has two-step verification. Ask the user for their 2FA password, " +
                "then call telegram_login_password. Tell them to change it afterwards if they pasted it anywhere else.",
            });
          }

          if (msg.startsWith("PHONE_CODE_INVALID")) {
            return ok({ error: "That code is not valid. Ask the user to check it and try again.", retry: true });
          }
          if (msg.startsWith("PHONE_CODE_EXPIRED")) {
            await discardPending();
            return ok({ error: "The code expired. Call telegram_login_start again to get a new one.", retry: true });
          }
          throw err;
        }
      }),
  );

  server.registerTool(
    "telegram_login_password",
    {
      title: "Submit the Telegram 2FA password",
      description:
        "Complete login when the account has two-step verification enabled. Only call after " +
        "telegram_login_code returned passwordRequired:true. The password is used once and never stored.",
      inputSchema: {
        password: z.string().min(1).describe("The user's Telegram two-step verification password."),
      },
      // Keeps the 2FA password out of audit.log at the registry layer.
      _meta: { secretArgs: ["password"] },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async ({ password }) =>
      guard(async () => {
        const p = needPending();
        if (p.stage !== "password") {
          return ok({
            error: "No password step is pending. Call telegram_login_code first.",
          });
        }

        try {
          const { computeCheck } = await import("telegram/Password.js");
          const pwdInfo = await p.client.invoke(new Api.account.GetPassword());
          const check = await computeCheck(pwdInfo, password);
          await p.client.invoke(new Api.auth.CheckPassword({ password: check }));

          const me = (await p.client.getMe()) as unknown as Record<string, unknown>;
          const done = await finishLogin(p, me);
          return ok({
            ...done,
            passwordRequired: false,
            note: "Logged in. The 2FA password was used once and was never written to disk or logs.",
          });
        } catch (err) {
          const msg = String((err as { errorMessage?: string }).errorMessage ?? (err as Error).message ?? "");
          if (msg.startsWith("PASSWORD_HASH_INVALID")) {
            return ok({ error: "Wrong 2FA password. Ask the user to try again.", retry: true });
          }
          throw err;
        }
      }),
  );

  server.registerTool(
    "telegram_login_cancel",
    {
      title: "Cancel a pending login",
      description: "Abandon an in-progress login. No code or password is retained after this.",
      inputSchema: {},
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    async () =>
      guard(async () => {
        const was = pending !== null;
        await discardPending();
        return ok({ cancelled: was });
      }),
  );
}

/** Drop any half-finished login on shutdown so sockets don't linger. */
export async function shutdownLogin(): Promise<void> {
  await discardPending();
  await disconnect().catch(() => undefined);
}
