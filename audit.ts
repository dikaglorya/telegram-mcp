/**
 * Append-only audit log. Every tool invocation is recorded with timestamp,
 * tool name, sanitized args, and outcome. Never logs secrets.
 */
import fs from "node:fs";
import path from "node:path";
import { getConfig, redact } from "./config.js";
import { lockFile } from "./perms.js";

/** Keys whose *value* is always a secret, regardless of content. */
const SECRET_KEYS = new Set([
  "api_hash",
  "apihash",
  "password",
  "phonecode",
  "phone_code",
  "phone_code_hash",
  "phonecodehash",
  "session",
  "sessionstring",
  "token",
  "2fa",
  "invite_hash",
  "invitehash",
]);

/**
 * Keys that hold either a secret or a harmless classification label.
 *
 * `code: "FLOOD_WAIT"` must stay readable in the audit log, while
 * `code: "12345"` (an OTP) must not. Same for `hash`. The decision is made on
 * the value's *shape* only for these two keys — everywhere else, key names
 * decide. This is a last-resort heuristic; credentials that arrive as tool
 * arguments are scrubbed explicitly at the registry (`_meta.secretArgs`).
 */
const CONDITIONALLY_SECRET_KEYS = new Set(["code", "hash"]);

function looksLikeSecretCode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Anything with a digit that is not an obvious UPPER_SNAKE taxonomy label.
  const isTaxonomyLabel = /^[A-Z][A-Z0-9_]*$/.test(trimmed);
  if (isTaxonomyLabel) return false;
  return true;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? redact(value).slice(0, 500) : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.toLowerCase();
    if (SECRET_KEYS.has(key)) {
      out[k] = "[redacted]";
      continue;
    }
    if (CONDITIONALLY_SECRET_KEYS.has(key) && looksLikeSecretCode(v)) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = sanitize(v, depth + 1);
  }
  return out;
}

/**
 * Append one audit record. `detail` may be a string or a structured object
 * (e.g. `{ code, message }` for failures); both are sanitized/truncated.
 * Never throws: auditing must not break a tool call.
 */
export function audit(tool: string, args: unknown, outcome: "ok" | "error", detail?: unknown): void {
  try {
    const config = getConfig();
    fs.mkdirSync(path.dirname(config.auditLogPath), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tool,
      outcome,
      args: sanitize(args),
      detail: detail === undefined ? undefined : sanitize(detail),
    });
    fs.appendFileSync(config.auditLogPath, line + "\n", { encoding: "utf8", mode: 0o600 });
    lockFile(config.auditLogPath);
  } catch {
    /* auditing must never break a tool call */
  }
}
