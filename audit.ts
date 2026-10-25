/**
 * Append-only audit log. Every tool invocation is recorded with timestamp,
 * tool name, sanitized args, and outcome. Never logs secrets.
 *
 * Batches writes asynchronously to avoid blocking the event loop on every
 * tool call. Flushes every 50ms or when queue reaches 100 entries.
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

export function sanitizeForAudit(value: unknown): unknown {
  return sanitize(value);
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

/** Async batched audit writer — never blocks the hot path. */
const auditQueue: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 50;
const FLUSH_BATCH_SIZE = 100;
let isFlushing = false;

function scheduleFlush(): void {
  if (flushTimer || isFlushing) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushAuditQueue().catch(() => {});
  }, FLUSH_INTERVAL_MS);
}

async function flushAuditQueue(): Promise<void> {
  if (isFlushing || auditQueue.length === 0) return;
  isFlushing = true;
  const lines = auditQueue.splice(0, FLUSH_BATCH_SIZE);
  try {
    const config = getConfig();
    const dir = path.dirname(config.auditLogPath);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.appendFile(config.auditLogPath, lines.join("") + "\n", { encoding: "utf8", mode: 0o600 });
    lockFile(config.auditLogPath);
  } catch {
    /* auditing must never break a tool call */
  } finally {
    isFlushing = false;
    if (auditQueue.length > 0) scheduleFlush();
  }
}

/**
 * Append one audit record. `detail` may be a string or a structured object
 * (e.g. `{ code, message }` for failures); both are sanitized/truncated.
 * Never throws: auditing must not break a tool call.
 */
export function audit(tool: string, args: unknown, outcome: "ok" | "error", detail?: unknown): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      tool,
      outcome,
      args: sanitize(args),
      detail: detail === undefined ? undefined : sanitize(detail),
    });
    auditQueue.push(line + "\n");
    if (auditQueue.length >= FLUSH_BATCH_SIZE) {
      flushAuditQueue().catch(() => {});
    } else {
      scheduleFlush();
    }
  } catch {
    /* auditing must never break a tool call */
  }
}

/** Flush immediately (for shutdown). */
export async function flushAudit(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushAuditQueue();
}

/** Synchronous flush for tests — writes any queued records immediately. */
export function flushAuditSync(): void {
  if (auditQueue.length === 0) return;
  try {
    const config = getConfig();
    const dir = path.dirname(config.auditLogPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lines = auditQueue.splice(0);
    fs.appendFileSync(config.auditLogPath, lines.join("") + "\n", { encoding: "utf8", mode: 0o600 });
    lockFile(config.auditLogPath);
  } catch {
    /* ignore */
  }
}