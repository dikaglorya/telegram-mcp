#!/usr/bin/env node
/**
 * `telegram-mcp dashboard` — a localhost-only control center.
 *
 * Scope on purpose: this is a companion to the MCP server, not a second
 * Telegram client. It shows policy, local health, the audit log and the
 * approval queue. It never opens an MTProto connection, so a dashboard left
 * open cannot trigger FLOOD_WAIT or touch a chat.
 *
 * Security:
 *   - binds to 127.0.0.1 only, never 0.0.0.0;
 *   - random 192-bit token, HttpOnly SameSite=Strict cookie;
 *   - Host header allowlist (DNS-rebinding defence);
 *   - strict CSP, no external assets, no CORS;
 *   - POSTs require a custom header (CSRF defence);
 *   - no session string, api_hash or message content is returned by the API.
 */
import "../env.js";
import http from "node:http";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { getConfig, hasSession, redact, stateDirPath } from "../config.js";
import { profileDescription, readAccessProfile } from "../access.js";
import {
  approveRequest,
  denyRequest,
  listApprovals,
  readApprovalMode,
} from "../approvals.js";
import { readAuditPage, summarizeAudit } from "../audit-read.js";
import { buildServer } from "../server.js";
import { getToolCatalog } from "../server-registry.js";
import { SERVER_VERSION } from "../version.js";
import { banner, gap, hint, info, muted, sym, theme } from "../ui.js";
import { renderDashboardHtml } from "./dashboard-html.js";

const COOKIE = "tgmcp_dashboard";
const CSRF_HEADER = "x-requested-with";
const CSRF_VALUE = "telegram-mcp-dashboard";
const out = (text: string): void => void process.stdout.write(text);

export type DashboardOptions = {
  port?: number;
  token?: string;
};

export type DashboardHandle = {
  server: http.Server;
  token: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = part.slice(eq + 1).trim();
  }
  return out;
}

function tokenFrom(req: http.IncomingMessage): string {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[COOKIE]) return cookies[COOKIE];
  const auth = String(req.headers.authorization ?? "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const header = req.headers["x-dashboard-token"];
  return typeof header === "string" ? header : "";
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const supplied = tokenFrom(req);
  return supplied.length > 0 && safeEqual(supplied, token);
}

function hostAllowed(req: http.IncomingMessage, port: number): boolean {
  const host = String(req.headers.host ?? "").toLowerCase();
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]).has(host);
}

function securityHeaders(res: http.ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}

function sendText(res: http.ServerResponse, status: number, value: string): void {
  securityHeaders(res);
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(value);
}

function localSummary(): Record<string, unknown> {
  const access = readAccessProfile();
  const approval = readApprovalMode();
  let configured = false;
  let configError: string | null = null;
  let sessionPresent = false;
  let sessionPath = path.join(stateDirPath(), "session.txt");
  let auditPath = path.join(stateDirPath(), "audit.log");
  let allowAllChats: boolean | null = null;
  let allowlistCount: number | null = null;

  try {
    const config = getConfig();
    configured = true;
    sessionPresent = hasSession(config);
    sessionPath = config.sessionPath;
    auditPath = config.auditLogPath;
    allowAllChats = config.allowAllChats;
    allowlistCount = config.allowlist.length;
  } catch (err) {
    configError = redact(err instanceof Error ? err.message : String(err));
  }

  const summary = summarizeAudit(auditPath);
  const approvals = listApprovals({ limit: 100 });
  const pending = approvals.filter((request) => request.status === "pending");

  return {
    version: SERVER_VERSION,
    configured,
    configError,
    sessionPresent,
    sessionPath,
    stateDir: stateDirPath(),
    profile: access.profile,
    profileSource: access.source,
    profileError: access.error ?? null,
    profileDescription: profileDescription(access.profile),
    approvalMode: approval.mode,
    approvalSource: approval.source,
    approvalError: approval.error ?? null,
    allowAllChats,
    allowlistCount,
    audit: summary
      ? {
          path: summary.path,
          exists: true,
          calls: summary.calls,
          ok: summary.ok,
          error: summary.error,
          lastCallAt: summary.lastCallAt,
          firstCallAt: summary.firstCallAt,
          errorsByCode: summary.errorsByCode,
          perTool: summary.perTool.slice(0, 10),
        }
      : {
          path: auditPath,
          exists: false,
          calls: 0,
          ok: 0,
          error: 0,
          lastCallAt: null,
          firstCallAt: null,
          errorsByCode: {},
          perTool: [],
        },
    approvals: {
      pending: pending.length,
      total: approvals.length,
    },
  };
}

export async function createDashboard(options: DashboardOptions = {}): Promise<DashboardHandle> {
  const envToken = String(process.env.TELEGRAM_DASHBOARD_TOKEN ?? "").trim();
  const token =
    options.token && options.token.length >= 16
      ? options.token
      : envToken.length >= 16
        ? envToken
        : randomBytes(24).toString("hex");
  if (envToken && envToken.length < 16) {
    process.stderr.write(
      `${theme.warn(`${sym.warn} TELEGRAM_DASHBOARD_TOKEN is shorter than 16 characters; using a random token instead`)}\n`,
    );
  }

  const port = Number.isInteger(options.port) && (options.port ?? -1) >= 0 ? Number(options.port) : 0;
  const catalog = getToolCatalog(buildServer());

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const actualPort = (server.address() as { port?: number } | null)?.port ?? port;

      if (!hostAllowed(req, actualPort)) {
        sendText(res, 421, "misdirected request: host header is not localhost");
        return;
      }

      // Unauthenticated health probe: no account data, safe for `curl`.
      if (req.method === "GET" && url.pathname === "/api/health") {
        sendJson(res, 200, { ok: true, version: SERVER_VERSION });
        return;
      }

      // One-time token exchange: /?token=... sets an HttpOnly cookie and
      // redirects, so the token does not stay in browser history or Referer.
      if (req.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
        if (!safeEqual(url.searchParams.get("token") ?? "", token)) {
          sendText(res, 401, "invalid dashboard token");
          return;
        }
        securityHeaders(res);
        res.statusCode = 302;
        res.setHeader(
          "Set-Cookie",
          `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        );
        res.setHeader("Location", "/");
        res.end();
        return;
      }

      if (!authorized(req, token)) {
        sendText(res, 401, "dashboard authentication required");
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        securityHeaders(res);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderDashboardHtml());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/summary") {
        sendJson(res, 200, localSummary());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/tools") {
        sendJson(res, 200, {
          version: SERVER_VERSION,
          tools: catalog.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            readOnly: tool.annotations.readOnlyHint === true,
            destructive: tool.annotations.destructiveHint === true,
            kind: tool.kind,
            minimumProfile: tool.minimumProfile,
            classified: tool.classified,
          })),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/audit") {
        let auditPath = path.join(stateDirPath(), "audit.log");
        try {
          auditPath = getConfig().auditLogPath;
        } catch {
          /* default path is enough */
        }
        const rawLimit = Number(url.searchParams.get("limit") ?? 100);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 100;
        const outcomeRaw = url.searchParams.get("outcome");
        const outcome = outcomeRaw === "ok" || outcomeRaw === "error" ? outcomeRaw : undefined;
        const tool = url.searchParams.get("tool")?.trim() || undefined;
        sendJson(res, 200, readAuditPage(auditPath, { limit, outcome, tool }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/approvals") {
        const all = listApprovals({ limit: 100 });
        sendJson(res, 200, {
          pending: all.filter((request) => request.status === "pending"),
          recent: all.filter((request) => request.status !== "pending").slice(0, 20),
        });
        return;
      }

      const approvalMatch = /^\/api\/approvals\/([a-f0-9]+)\/(approve|deny)$/.exec(url.pathname);
      if (req.method === "POST" && approvalMatch) {
        if (String(req.headers[CSRF_HEADER] ?? "") !== CSRF_VALUE) {
          sendJson(res, 403, { error: "missing X-Requested-With header" });
          return;
        }
        const [, id, action] = approvalMatch;
        try {
          const request = action === "approve" ? approveRequest(id) : denyRequest(id);
          sendJson(res, 200, { ok: true, request });
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        securityHeaders(res);
        res.statusCode = 204;
        res.end();
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on("clientError", (_err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const actualPort = (server.address() as { port: number }).port;
  return {
    server,
    token,
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/?token=${token}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function parseArgs(args: string[]): { port?: number; token?: string; help: boolean } {
  const result: { port?: number; token?: string; help: boolean } = { help: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--port") result.port = Number(args[++i]);
    else if (arg.startsWith("--port=")) result.port = Number(arg.slice("--port=".length));
    else if (arg === "--token") result.token = args[++i];
    else if (arg.startsWith("--token=")) result.token = arg.slice("--token=".length);
  }
  return result;
}

export async function main(args: string[] = process.argv.slice(2), _command?: string): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.help) {
    out(
      [
        `${theme.label("Usage")}`,
        `  telegram-mcp dashboard [--port 8787] [--token <16+ chars>]`,
        "",
        `${theme.muted("Binds to 127.0.0.1 only. Prints a one-time URL with an access token.")}`,
        `${theme.muted("Set TELEGRAM_DASHBOARD_PORT / TELEGRAM_DASHBOARD_TOKEN to avoid flags.")}`,
        "",
      ].join("\n"),
    );
    return;
  }

  const port = parsed.port ?? Number(process.env.TELEGRAM_DASHBOARD_PORT ?? 0);
  const handle = await createDashboard({
    port: Number.isFinite(port) ? port : 0,
    token: parsed.token ?? process.env.TELEGRAM_DASHBOARD_TOKEN,
  });

  banner({ subtitle: "local control center", compact: true });
  info(`${theme.success(sym.ok)} listening on ${theme.underline(`http://127.0.0.1:${handle.port}/`)}`);
  gap();
  out(`  ${theme.label("Open")}  ${theme.accent(handle.url)}\n`);
  hint("The token is exchanged for an HttpOnly cookie and removed from the URL.");
  hint("Bound to 127.0.0.1 only. Ctrl+C stops it.");
  gap();
  muted("This dashboard never connects to Telegram; live checks stay in telegram_doctor.");

  const shutdown = () => {
    void handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function invokedDirectly(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("dashboard.js") || entry.endsWith("dashboard.ts");
}

if (invokedDirectly()) {
  void main().catch((err) => {
    process.stderr.write(
      `${theme.fail(`${sym.fail} dashboard failed: ${err instanceof Error ? err.message : String(err)}`)}\n`,
    );
    process.exit(1);
  });
}
