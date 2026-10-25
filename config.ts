/**
 * Credentials and secret handling.
 *
 * Secrets (api_hash, session string, 2FA password, login codes) must never be
 * passed to the language model. They only ever live in:
 *   - the process environment (TELEGRAM_API_ID / TELEGRAM_API_HASH)
 *   - the session file on disk (0600 permissions)
 *   - memory inside the MCP server process
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lockDir, lockFile } from "./perms.js";

export { SERVER_NAME, SERVER_VERSION } from "./version.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Config = {
  apiId: number;
  /** Secret — never expose to the model. */
  apiHash: string;
  sessionPath: string;
  mediaDir: string;
  exportDir: string;
  auditLogPath: string;
  allowAllChats: boolean;
  allowlist: string[];
  statePath: string;
};

function envList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function expandHome(p: string): string {
  // Accept ~ and both separators: Windows users type `~\`, POSIX users `~/`.
  const m = /^~([\\/].*)?$/.exec(p);
  if (m) return m[1] ? path.join(os.homedir(), m[1].slice(1)) : os.homedir();
  return p;
}

function resolvePath(value: string | undefined, fallback: string[]): string {
  const base = expandHome(value?.trim() || path.join(os.homedir(), ...fallback));
  return path.resolve(base);
}

/**
 * The state directory without requiring API credentials.
 *
 * The dashboard, the approval store and `telegram_permissions` all need this
 * before a session exists, so it must not depend on `getConfig()` succeeding.
 */
export function stateDirPath(): string {
  return resolvePath(process.env.TELEGRAM_STATE_DIR, [".telegram-mcp"]);
}

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (cachedConfig !== null) return cachedConfig;

  const apiIdRaw = process.env.TELEGRAM_API_ID ?? process.env.API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH ?? process.env.API_HASH;

  if (!apiIdRaw) {
    throw new ConfigError(
      "TELEGRAM_API_ID is not set. Get api_id/api_hash from https://my.telegram.org/apps and set them in the MCP server environment (never in the prompt).",
    );
  }
  const apiId = Number(apiIdRaw);
  if (!Number.isInteger(apiId) || apiId <= 0) {
    throw new ConfigError("TELEGRAM_API_ID must be a positive integer.");
  }
  if (!apiHash) {
    throw new ConfigError(
      "TELEGRAM_API_HASH is not set. Get it from https://my.telegram.org/apps and set it in the MCP server environment.",
    );
  }

  const stateDir = stateDirPath();
  const sessionPath = resolvePath(process.env.TELEGRAM_SESSION_PATH, [".telegram-mcp", "session.txt"]);
  const mediaDir = resolvePath(process.env.TELEGRAM_MEDIA_DIR, [".telegram-mcp", "media"]);
  const exportDir = resolvePath(process.env.TELEGRAM_EXPORT_DIR, [".telegram-mcp", "exports"]);
  const auditLogPath = resolvePath(process.env.TELEGRAM_AUDIT_LOG, [".telegram-mcp", "audit.log"]);
  const statePath = path.join(stateDir, "state.json");

  cachedConfig = {
    apiId,
    apiHash,
    sessionPath,
    mediaDir,
    exportDir,
    auditLogPath,
    statePath,
    allowAllChats: envBool("TELEGRAM_ALLOW_ALL_CHATS", true),
    allowlist: envList("TELEGRAM_ALLOWED_CHATS"),
  };
  return cachedConfig;
}

/** Invalidate memoized config (for testing or if env changes at runtime). */
export function invalidateConfigCache(): void {
  cachedConfig = null;
}

/** Test-only: force config to re-read env vars on next getConfig() call. */
export function resetConfigForTest(): void {
  cachedConfig = null;
}

export function ensureDirs(config: Config): void {
  for (const dir of [
    path.dirname(config.sessionPath),
    path.dirname(config.statePath),
    config.mediaDir,
    config.exportDir,
    path.dirname(config.auditLogPath),
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    lockDir(dir);
  }
}

export function readSessionString(config: Config): string {
  try {
    return fs.readFileSync(config.sessionPath, "utf8").trim();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

export function hasSession(config: Config): boolean {
  return readSessionString(config).length > 0;
}

export function writeSessionString(config: Config, session: string): void {
  fs.mkdirSync(path.dirname(config.sessionPath), { recursive: true, mode: 0o700 });
  lockDir(path.dirname(config.sessionPath));
  try {
    fs.unlinkSync(config.sessionPath);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(config.sessionPath, session, { encoding: "utf8", mode: 0o600 });
  // `mode` is subject to umask on some platforms; enforce explicitly (POSIX).
  lockFile(config.sessionPath);
}

/** Best-effort redaction of anything secret-ish before it leaves the process. */
let cachedSecrets: string[] | null = null;

function loadSecrets(): string[] {
  if (cachedSecrets !== null) return cachedSecrets;
  const secrets: string[] = [];
  if (process.env.TELEGRAM_API_HASH) secrets.push(process.env.TELEGRAM_API_HASH);
  if (process.env.API_HASH) secrets.push(process.env.API_HASH);
  // TELEGRAM_API_ID is a public identifier, not a secret — do not redact it.
  try {
    const session = readSessionString(getConfig());
    if (session) secrets.push(session);
  } catch {
    /* config may be incomplete during early errors */
  }
  cachedSecrets = secrets.filter((s) => s && s.length >= 4);
  return cachedSecrets;
}

/** Invalidate cached secrets (call after session write). */
export function invalidateRedactionCache(): void {
  cachedSecrets = null;
}

export function redact(text: string): string {
  let out = text;
  for (const secret of loadSecrets()) {
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
