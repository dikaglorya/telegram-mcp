/**
 * Human-in-the-loop approval for risky writes.
 *
 * A profile is a standing permission. Approval is a one-shot permission for a
 * *specific* tool call with *specific* arguments, granted out-of-band by the
 * human (terminal or local dashboard). The agent can request approval, but it
 * cannot grant it through the MCP server.
 *
 * Flow:
 *   1. Agent calls a write tool while TELEGRAM_APPROVAL_MODE is enabled.
 *   2. The server hashes tool + canonical arguments, finds no approved record,
 *      stores a pending request, and returns APPROVAL_REQUIRED with an id.
 *   3. Human runs `telegram-mcp approve <id>` (or clicks Approve in the local
 *      control center).
 *   4. Agent retries the exact same call; the server consumes the approval once
 *      and executes it.
 *
 * Records live in <state dir>/approvals.json (0600). Secret arguments are
 * sanitized before they are stored; the hash is one-way.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateDirPath } from "./config.js";
import { sanitizeForAudit, audit } from "./audit.js";
import { lockDir, lockFile } from "./perms.js";

export const APPROVAL_MODES = ["off", "destructive", "writes"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed";

export type ApprovalRequest = {
  id: string;
  tool: string;
  argsHash: string;
  /** Sanitized copy for the human to inspect. Never contains declared secrets. */
  argsPreview: unknown;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt?: string;
  deniedAt?: string;
  consumedAt?: string;
};

type Store = {
  version: 1;
  requests: ApprovalRequest[];
};

export type ApprovalModeState = {
  mode: ApprovalMode;
  source: "default" | "env";
  error?: string;
};

const MAX_RECORDS = 200;
const KEEP_FINISHED_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_SECONDS = 600;

/** Lock acquisition config — override via env for slow filesystems. */
const LOCK_ACQUIRE_TIMEOUT_MS = Number(process.env.TELEGRAM_APPROVAL_LOCK_TIMEOUT_MS ?? 10000);
const LOCK_STALE_MS = Number(process.env.TELEGRAM_APPROVAL_LOCK_STALE_MS ?? 5000);
const LOCK_BASE_BACKOFF_MS = 25;
const LOCK_MAX_BACKOFF_MS = 200;

/**
 * Authentication and local setup are exempt: requiring approval to log in would
 * make an approval-enabled install impossible to start, and `telegram_setup`
 * writes configuration rather than touching Telegram. Both are still audited.
 */
const APPROVAL_EXEMPT = new Set([
  "telegram_setup",
  "telegram_login_start",
  "telegram_login_code",
  "telegram_login_password",
  "telegram_login_cancel",
]);

export function isApprovalMode(value: string): value is ApprovalMode {
  return (APPROVAL_MODES as readonly string[]).includes(value);
}

/**
 * Invalid values fail closed to `writes` rather than silently disabling the
 * gate. The error is surfaced by telegram_permissions and telegram_doctor.
 */
export function readApprovalMode(env: NodeJS.ProcessEnv = process.env): ApprovalModeState {
  const raw = String(env.TELEGRAM_APPROVAL_MODE ?? "").trim().toLowerCase();
  if (!raw) return { mode: "off", source: "default" };
  if (isApprovalMode(raw)) return { mode: raw, source: "env" };
  return {
    mode: "writes",
    source: "env",
    error:
      `Invalid TELEGRAM_APPROVAL_MODE=${JSON.stringify(raw)}. ` +
      `Expected one of: ${APPROVAL_MODES.join(", ")}. Failing closed to writes.`,
  };
}

export function requiresApproval(
  mode: ApprovalMode,
  tool: string,
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean },
): boolean {
  if (mode === "off" || APPROVAL_EXEMPT.has(tool)) return false;
  if (mode === "destructive") return annotations?.destructiveHint === true;
  return annotations?.readOnlyHint !== true;
}

function ttlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.TELEGRAM_APPROVAL_TTL_SECONDS ?? DEFAULT_TTL_SECONDS);
  const seconds = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(seconds, 30), 24 * 60 * 60) * 1000;
}

export function approvalsPath(): string {
  return path.join(stateDirPath(), "approvals.json");
}

function ensureStateDir(): string {
  const dir = stateDirPath();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  lockDir(dir);
  return dir;
}

function emptyStore(): Store {
  return { version: 1, requests: [] };
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(approvalsPath(), "utf8")) as Partial<Store>;
    return {
      version: 1,
      requests: Array.isArray(parsed.requests) ? (parsed.requests as ApprovalRequest[]) : [],
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    // A corrupt approval file must not crash the server or silently approve
    // anything. Treat it as empty; the next write replaces it atomically.
    return emptyStore();
  }
}

function writeStore(store: Store): void {
  const file = approvalsPath();
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
  lockFile(tmp);
  fs.renameSync(tmp, file);
  lockFile(file);
}

function isExpired(request: ApprovalRequest, now: number): boolean {
  const expires = Date.parse(request.expiresAt);
  return !Number.isFinite(expires) || expires <= now;
}

function prune(store: Store, now: number): boolean {
  const before = store.requests.length;
  store.requests = store.requests
    .filter((request) => {
      if (request.status === "pending" || request.status === "approved") {
        return !isExpired(request, now);
      }
      const finished = Date.parse(request.consumedAt ?? request.deniedAt ?? request.approvedAt ?? request.createdAt);
      return Number.isFinite(finished) && now - finished < KEEP_FINISHED_MS;
    })
    .slice(-MAX_RECORDS);
  return store.requests.length !== before;
}

/**
 * Small cross-process lock. The server and the CLI/dashboard can approve at the
 * same time; without this, the last writer would silently discard the other
 * record. A stale lock (killed process) is reclaimed after LOCK_STALE_MS.
 */
function withStore<T>(fn: (store: Store) => T, options?: { readOnly?: boolean }): T {
  ensureStateDir();
  const file = approvalsPath();
  const lock = `${file}.lock`;
  const started = Date.now();
  let fd: number | null = null;
  let backoff = LOCK_BASE_BACKOFF_MS;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx", 0o600);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > LOCK_ACQUIRE_TIMEOUT_MS) {
        throw new Error("approval store is busy; try again");
      }
      // Exponential backoff with cap, keeps this helper usable from the
      // synchronous tool registry path. Base 25ms, cap 200ms.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoff);
      backoff = Math.min(backoff * 2, LOCK_MAX_BACKOFF_MS);
    }
  }

  try {
    const store = readStore();
    prune(store, Date.now());
    const result = fn(store);
    if (!options?.readOnly) {
      writeStore(store);
    }
    return result;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(lock, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(obj[key])}`).join(",")}}`;
}

/** One-way fingerprint of the exact call the human is approving. */
export function approvalHash(args: unknown): string {
  return createHash("sha256").update(canonical(args)).digest("hex");
}

function newId(): string {
  return randomBytes(6).toString("hex");
}

export type CreatedApproval = {
  request: ApprovalRequest;
  /** True when an identical pending request already existed. */
  reused: boolean;
};

export function createApprovalRequest(tool: string, args: unknown): CreatedApproval {
  const hash = approvalHash(args);
  const preview = sanitizeForAudit(args);
  let outcome: CreatedApproval | undefined;

  withStore((store) => {
    const now = Date.now();
    // Check for an existing pending request we can reuse.
    const existing = store.requests.find(
      (request) =>
        request.status === "pending" &&
        request.tool === tool &&
        request.argsHash === hash &&
        !isExpired(request, now),
    );
    if (existing) {
      outcome = { request: existing, reused: true };
      return;
    }

    // Check for a denied request with the same call — deny is final for this
    // exact tool+args combination. The human must explicitly approve a new
    // request if they change their mind.
    const denied = store.requests.find(
      (request) =>
        request.status === "denied" &&
        request.tool === tool &&
        request.argsHash === hash,
    );
    if (denied) {
      // Throw a special error that the registry will catch and return as a
      // permanent denial (not APPROVAL_REQUIRED).
      const err = new Error(
        `This call was denied by the human (approval ${denied.id}). ` +
          `To allow it, create a new approval request with different arguments or ask the human to approve a fresh call.`,
      ) as Error & { code: string; denied: true; approvalId: string };
      err.code = "APPROVAL_DENIED";
      err.denied = true;
      err.approvalId = denied.id;
      throw err;
    }

    let id = newId();
    while (store.requests.some((request) => request.id === id)) id = newId();
    const request: ApprovalRequest = {
      id,
      tool,
      argsHash: hash,
      argsPreview: preview,
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs()).toISOString(),
    };
    store.requests.push(request);
    outcome = { request, reused: false };
  });

  if (!outcome) throw new Error("could not create approval request");
  if (!outcome.reused) {
    audit("telegram_approval", { event: "requested", id: outcome.request.id, tool }, "ok");
  }
  return outcome;
}

/**
 * Consume an approved record for this exact call. One approval = one execution.
 * Returns null when there is no live approval, including a mismatched tool or
 * argument set.
 */
export function consumeApproval(tool: string, args: unknown): ApprovalRequest | null {
  const hash = approvalHash(args);
  let consumed: ApprovalRequest | undefined;

  withStore((store) => {
    const now = Date.now();
    const found = store.requests.find(
      (request) =>
        request.status === "approved" &&
        request.tool === tool &&
        request.argsHash === hash &&
        !isExpired(request, now),
    );
    if (!found) return;
    found.status = "consumed";
    found.consumedAt = new Date(now).toISOString();
    consumed = found;
  });

  if (consumed) {
    audit("telegram_approval", { event: "consumed", id: consumed.id, tool }, "ok");
  }
  return consumed ?? null;
}

export function approveRequest(id: string): ApprovalRequest {
  let result: ApprovalRequest | undefined;
  withStore((store) => {
    const now = Date.now();
    const request = store.requests.find((item) => item.id === id);
    if (!request) throw new Error(`no approval request with id ${id}`);
    if (request.status === "consumed") throw new Error(`approval ${id} was already used`);
    if (request.status === "denied") throw new Error(`approval ${id} was denied`);
    if (isExpired(request, now)) throw new Error(`approval ${id} expired; ask the agent to retry`);
    if (request.status === "pending") {
      request.status = "approved";
      request.approvedAt = new Date(now).toISOString();
    }
    result = request;
  });
  if (!result) throw new Error(`could not approve ${id}`);
  audit("telegram_approval", { event: "approved", id: result.id, tool: result.tool }, "ok");
  return result;
}

export function denyRequest(id: string): ApprovalRequest {
  let result: ApprovalRequest | undefined;
  withStore((store) => {
    const now = Date.now();
    const request = store.requests.find((item) => item.id === id);
    if (!request) throw new Error(`no approval request with id ${id}`);
    if (request.status === "consumed") throw new Error(`approval ${id} was already used`);
    request.status = "denied";
    request.deniedAt = new Date(now).toISOString();
    result = request;
  });
  if (!result) throw new Error(`could not deny ${id}`);
  audit("telegram_approval", { event: "denied", id: result.id, tool: result.tool }, "ok");
  return result;
}

export function listApprovals(options: { status?: ApprovalStatus; limit?: number } = {}): ApprovalRequest[] {
  let result: ApprovalRequest[] = [];
  withStore(
    (store) => {
      result = store.requests
        .filter((request) => !options.status || request.status === options.status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, Math.max(1, Math.min(options.limit ?? 50, 200)));
    },
    { readOnly: true },
  );
  return result;
}

export function pendingApprovalCount(): number {
  return listApprovals({ status: "pending", limit: 200 }).length;
}
