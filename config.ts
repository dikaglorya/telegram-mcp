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

export const SERVER_NAME = "telegram-mcp";
export const SERVER_VERSION = "1.0.0";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Config = {
  apiId: number;
  /** Secret — never expose to an AI model. */
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

export function getConfig(): Config {
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

  const stateDir = resolvePath(process.env.TELEGRAM_STATE_DIR, [".telegram-mcp"]);
  const sessionPath = resolvePath(process.env.TELEGRAM_SESSION_PATH, [".telegram-mcp", "session.txt"]);
  const mediaDir = resolvePath(process.env.TELEGRAM_MEDIA_DIR, [".telegram-mcp", "media"]);
  const exportDir = resolvePath(process.env.TELEGRAM_EXPORT_DIR, [".telegram-mcp", "exports"]);
  const auditLogPath = resolvePath(process.env.TELEGRAM_AUDIT_LOG, [".telegram-mcp", "audit.log"]);
  const statePath = path.join(stateDir, "state.json");

  return {
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
export function redact(text: string): string {
  let out = text;
  const secrets: string[] = [];
  if (process.env.TELEGRAM_API_HASH) secrets.push(process.env.TELEGRAM_API_HASH);
  if (process.env.API_HASH) secrets.push(process.env.API_HASH);
  if (process.env.TELEGRAM_API_ID) secrets.push(process.env.TELEGRAM_API_ID);
  try {
    const session = readSessionString(getConfig());
    if (session) secrets.push(session);
  } catch {
    /* config may be incomplete during early errors */
  }
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
