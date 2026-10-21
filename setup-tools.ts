/**
 * Setup tools — so a user never needs a terminal.
 *
 * `telegram_doctor` runs the same checks as `npm run doctor`, but returns them
 * as structured JSON the agent can read and act on: a missing session or an
 * unauthorized one is reported as `pass:false` (never thrown), so the agent can
 * start a login instead of dead-ending on an opaque error.
 *
 * `telegram_setup` writes the `.env` file with api_id / api_hash / phone /
 * allow-all, so nobody has to hand-edit a dotfile. The api_hash is written to
 * disk once and never echoed back: the tool returns key names only, and the
 * argument is scrubbed from the audit log at the registry layer via
 * `_meta.secretArgs`.
 *
 * Secrets never reach stdout: stdout belongs to the MCP JSON-RPC transport.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ensureDirs, getConfig, hasSession, type Config } from "./config.js";
import { getClient } from "./telegram.js";
import { lockFile } from "./perms.js";
import { normalizeError } from "./errors.js";
import { ok, guard } from "./util.js";

/** One line of the doctor report. */
type Check = { name: string; pass: boolean; detail: string };

type AccountSummary = { id: string; username: string | null; firstName: string | null };

/** Keys this module owns when writing `.env`; everything else is preserved. */
const MANAGED_KEYS = [
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "TELEGRAM_PHONE",
  "TELEGRAM_ALLOW_ALL_CHATS",
] as const;

/** Header this module writes. Recognized on re-write so it is replaced, not duplicated. */
const HEADER = [
  "# Telegram MTProto credentials — written by telegram_setup (MCP).",
  "# Get api_id / api_hash from https://my.telegram.org/apps",
  "# This file contains a secret: keep it out of version control.",
];

/**
 * Walk up from `start` looking for the package root: a directory that has a
 * package.json AND a build marker (dist/ or tsconfig.json). Mirrors the
 * resolution in env.ts so both layouts work:
 *   <root>/dist/setup-tools.js   (built)
 *   <root>/setup-tools.ts        (tsx)
 */
function findPackageRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const hasManifest = fs.existsSync(path.join(dir, "package.json"));
    const hasBuildMarker =
      fs.existsSync(path.join(dir, "dist")) || fs.existsSync(path.join(dir, "tsconfig.json"));
    if (hasManifest && hasBuildMarker) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Absolute path of the `.env` this server actually loads, or null if not found. */
function envFilePath(): string | null {
  const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  return root ? path.join(root, ".env") : null;
}

/** Read KEY=VALUE pairs, tolerating comments, blanks, `export` and quotes. */
function parseEnv(text: string): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    pairs.set(key, value);
  }
  return pairs;
}

/**
 * Everything in an existing `.env` that this module does not own: comments,
 * blank lines and other keys (TELEGRAM_ALLOWED_CHATS, TELEGRAM_SESSION_PATH, …).
 * A partial update therefore never drops a setting the user already had. This
 * module's own header is dropped: it is regenerated on every write, so keeping
 * it would duplicate the banner on each update.
 */
function preservedSection(text: string): string[] {
  const kept: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (HEADER.includes(trimmed)) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0 && !trimmed.startsWith("#")) {
      const key = trimmed.slice(0, eq).replace(/^export\s+/, "").trim();
      if ((MANAGED_KEYS as readonly string[]).includes(key)) continue;
    }
    // Collapse runs of blank lines: the file is regenerated, so gaps that came
    // from removed keys should not accumulate.
    if (trimmed === "" && (kept.length === 0 || kept[kept.length - 1].trim() === "")) continue;
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return kept;
}

/** A .env value must stay on one line — a newline would inject extra keys. */
function isOneLine(value: string): boolean {
  return !/[\r\n\u0000]/.test(value);
}

function buildEnvBody(values: {
  apiId: string;
  apiHash: string;
  phone: string | null;
  allowAllChats: boolean;
  preserved: string[];
}): string {
  const lines = [
    ...HEADER,
    `TELEGRAM_API_ID=${values.apiId}`,
    `TELEGRAM_API_HASH=${values.apiHash}`,
  ];
  if (values.phone) lines.push(`TELEGRAM_PHONE=${values.phone}`);
  lines.push(`TELEGRAM_ALLOW_ALL_CHATS=${values.allowAllChats ? "true" : "false"}`);
  if (values.preserved.length > 0) lines.push("", ...values.preserved);
  return `${lines.join("\n")}\n`;
}

export function registerSetupTools(server: McpServer): void {
  server.registerTool(
    "telegram_doctor",
    {
      title: "Telegram health check",
      description:
        "Read-only health check: config, state dir, session presence, session file permissions " +
        "(auto-repaired to 0600), and live authorization. Returns { healthy, checks[], account }. " +
        "A missing or unauthorized session is reported as a failed check, not an error — call " +
        "telegram_login_start to fix it. Never returns the api_hash or the session string.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const checks: Check[] = [];
        let config: Config | null = null;
        let account: AccountSummary | null = null;

        // 1. config — api_id/api_hash present and well-formed. Detail carries no secret.
        try {
          config = getConfig();
          checks.push({
            name: "config",
            pass: true,
            detail: `api_id=${config.apiId}, allowAll=${config.allowAllChats}, allowlist=${config.allowlist.length}`,
          });
        } catch (err) {
          checks.push({ name: "config", pass: false, detail: normalizeError(err).message });
        }

        if (!config) {
          // Without credentials there is no session path to inspect and no client
          // to connect: report the remaining checks as failed-with-reason rather
          // than throwing, so the agent sees the whole picture in one call.
          for (const name of ["state dir", "session present", "session permissions", "authorized"]) {
            checks.push({ name, pass: false, detail: "not checked: config is invalid" });
          }
          return ok({ healthy: false, checks, account });
        }

        // 2. state dir — created (0700) and present.
        const stateDir = path.dirname(config.sessionPath);
        try {
          ensureDirs(config);
          checks.push({ name: "state dir", pass: fs.existsSync(stateDir), detail: stateDir });
        } catch (err) {
          checks.push({ name: "state dir", pass: false, detail: normalizeError(err).message });
        }

        // 3. session present — a non-empty session file exists.
        let sessionExists = false;
        try {
          sessionExists = hasSession(config);
          checks.push({ name: "session present", pass: sessionExists, detail: config.sessionPath });
        } catch (err) {
          checks.push({ name: "session present", pass: false, detail: normalizeError(err).message });
        }

        // 4. session permissions — 0600, repaired in place when it drifted.
        //    A check that cannot pass because a prerequisite failed is a failure;
        //    a check the platform has no concept for (Windows ACLs) is a pass.
        if (!sessionExists) {
          checks.push({
            name: "session permissions",
            pass: false,
            detail: "not checked: no session file yet",
          });
        } else if (process.platform === "win32") {
          checks.push({
            name: "session permissions",
            pass: true,
            detail: "skipped on Windows (inherits user profile ACLs)",
          });
        } else {
          try {
            let mode = fs.statSync(config.sessionPath).mode & 0o777;
            let pass = (mode & 0o077) === 0;
            let detail = `mode=${mode.toString(8)}`;
            if (!pass) {
              lockFile(config.sessionPath);
              mode = fs.statSync(config.sessionPath).mode & 0o777;
              pass = (mode & 0o077) === 0;
              // Say "attempted" when the chmod did not stick (e.g. a filesystem
              // without chmod support) instead of claiming a repair happened.
              detail = `mode=${mode.toString(8)}${pass ? " (repaired)" : " (repair attempted)"}`;
            }
            checks.push({ name: "session permissions", pass, detail });
          } catch (err) {
            checks.push({
              name: "session permissions",
              pass: false,
              detail: normalizeError(err).message,
            });
          }
        }

        // 5. authorized — live check against Telegram. The client is kept: the
        //    server owns it and a later tool call must reuse this connection.
        if (!sessionExists) {
          checks.push({ name: "authorized", pass: false, detail: "not checked: no session file yet" });
        } else {
          try {
            const client = await getClient();
            const authorized = await client.isUserAuthorized();
            checks.push({
              name: "authorized",
              pass: authorized,
              detail: authorized ? "session is logged in" : "session exists but is not logged in",
            });

            if (authorized) {
              // 6. Account summary. A failure here does not change the verdict:
              //    authorization already succeeded, only the profile is missing.
              try {
                const me = (await client.getMe()) as unknown as {
                  id?: unknown;
                  username?: string | null;
                  firstName?: string | null;
                };
                account = {
                  id: String(me?.id ?? ""),
                  username: me?.username ?? null,
                  firstName: me?.firstName ?? null,
                };
              } catch {
                account = null;
              }
            }
          } catch (err) {
            checks.push({ name: "authorized", pass: false, detail: normalizeError(err).message });
          }
        }

        return ok({ healthy: checks.every((check) => check.pass), checks, account });
      }),
  );

  server.registerTool(
    "telegram_setup",
    {
      title: "Write the Telegram credentials file",
      description:
        "Create or update the .env file this server loads: TELEGRAM_API_ID, TELEGRAM_API_HASH, " +
        "optional TELEGRAM_PHONE, and TELEGRAM_ALLOW_ALL_CHATS. Get api_id/api_hash from " +
        "https://my.telegram.org/apps. Never call this with a hash the user pasted in chat unless " +
        "they asked you to; the hash is written to disk and never returned. Existing other keys " +
        "in .env are preserved. The MCP server must be restarted to pick up new values.",
      inputSchema: {
        apiId: z
          .string()
          .optional()
          .describe("Numeric App api_id from my.telegram.org/apps, e.g. \"1234567\"."),
        apiHash: z.string().optional().describe("App api_hash from my.telegram.org/apps (32 hex chars)."),
        phone: z
          .string()
          .optional()
          .describe("International phone number with leading +, e.g. +15551234567."),
        allowAllChats: z
          .boolean()
          .default(true)
          .describe("Full access to every chat the account can reach. true unless the user wants a restriction."),
        force: z
          .boolean()
          .default(false)
          .describe("Rewrite an already-configured .env. Only when the user asks."),
      },
      // api_hash and the phone are credentials; api_id is not secret, but it is
      // meaningless without the hash, so all three are scrubbed from the audit
      // context before guard() sees them. audit.log then records that they were
      // supplied, never their values.
      _meta: { secretArgs: ["apiId", "apiHash", "phone"] },
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ apiId, apiHash, phone, allowAllChats, force }) =>
      guard(async () => {
        const envPath = envFilePath();
        if (!envPath) {
          return ok({
            written: false,
            error:
              "Could not locate the package root (a directory holding package.json and dist/ or " +
              "tsconfig.json) by walking up from this module. Write .env next to package.json manually.",
          });
        }

        const envExists = fs.existsSync(envPath);
        const existingText = envExists ? fs.readFileSync(envPath, "utf8") : "";
        const existing = parseEnv(existingText);
        const existingId = (existing.get("TELEGRAM_API_ID") ?? "").trim();
        const existingHash = (existing.get("TELEGRAM_API_HASH") ?? "").trim();

        if (envExists && existingId && existingHash && !force) {
          return ok({ written: false, reason: "already configured", envPath });
        }

        // Merge: an explicit argument wins, otherwise keep what the file already
        // has, so supplying only one of the two still completes the setup.
        const apiIdValue = apiId?.trim() || existingId;
        const apiHashValue = apiHash?.trim() || existingHash;
        const phoneValue = phone?.trim() || (existing.get("TELEGRAM_PHONE") ?? "").trim() || null;

        const needs: string[] = [];
        if (!apiIdValue) needs.push("apiId");
        if (!apiHashValue) needs.push("apiHash");
        if (needs.length > 0) {
          return ok({
            written: false,
            envPath,
            needs,
            hint:
              "Get api_id and api_hash from https://my.telegram.org/apps (API development tools), " +
              "then call telegram_setup again with the missing value(s). Both are required.",
          });
        }

        if (!/^\d+$/.test(apiIdValue) || !Number.isSafeInteger(Number(apiIdValue)) || Number(apiIdValue) <= 0) {
          return ok({
            written: false,
            envPath,
            error:
              `apiId must be a positive integer, got "${apiIdValue}". It is the numeric "App api_id" ` +
              "on https://my.telegram.org/apps — not the api_hash.",
          });
        }
        if (!isOneLine(apiHashValue)) {
          return ok({ written: false, envPath, error: "apiHash must be a single line of text." });
        }
        if (phoneValue !== null && !isOneLine(phoneValue)) {
          return ok({ written: false, envPath, error: "phone must be a single line of text." });
        }

        const body = buildEnvBody({
          apiId: apiIdValue,
          apiHash: apiHashValue,
          phone: phoneValue,
          allowAllChats,
          preserved: preservedSection(existingText),
        });
        fs.writeFileSync(envPath, body, { encoding: "utf8", mode: 0o600 });
        lockFile(envPath);

        // Make the new values live immediately. `getConfig()` reads process.env
        // on every call and dotenv does not override existing keys, so without
        // this the agent would have to restart the server before logging in.
        if (apiIdValue) process.env.TELEGRAM_API_ID = String(apiIdValue);
        if (apiHashValue) process.env.TELEGRAM_API_HASH = String(apiHashValue);
        if (phoneValue) process.env.TELEGRAM_PHONE = String(phoneValue);
        process.env.TELEGRAM_ALLOW_ALL_CHATS = allowAllChats ? "true" : "false";

        // Key names only — never the values, and never the api_hash.
        const keys = ["TELEGRAM_API_ID", "TELEGRAM_API_HASH"];
        if (phoneValue) keys.push("TELEGRAM_PHONE");
        keys.push("TELEGRAM_ALLOW_ALL_CHATS");
        const preserved = [...existing.keys()].filter(
          (key) => !(MANAGED_KEYS as readonly string[]).includes(key),
        );

        return ok({
          written: true,
          envPath,
          keys,
          preserved,
          note:
            "Configuration is live in this session — no restart needed. " +
            "Call telegram_login_start to authorize.",
        });
      }),
  );
}
