#!/usr/bin/env node
/**
 * `telegram-mcp approvals` / `approve <id>` / `deny <id>`
 *
 * The human half of the approval gate. The MCP server can create a pending
 * request, but only this local command (or the dashboard) can grant it. That is
 * deliberate: an agent must not be able to approve its own destructive call.
 */
import "../env.js";
import {
  approveRequest,
  denyRequest,
  listApprovals,
  type ApprovalRequest,
} from "../approvals.js";
import { banner, gap, hint, info, muted, sym, theme } from "../ui.js";

const out = (text: string): void => void process.stdout.write(text);

function short(value: unknown, max = 160): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function age(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function printList(): void {
  const requests = listApprovals({ limit: 50 });
  if (requests.length === 0) {
    info(`${theme.muted("No approval requests yet.")}`);
    hint("Enable the gate with TELEGRAM_APPROVAL_MODE=destructive (or writes) and restart the server.");
    return;
  }

  banner({ subtitle: "approval queue", compact: true });
  gap();
  const pending = requests.filter((request) => request.status === "pending");
  const finished = requests.filter((request) => request.status !== "pending");

  if (pending.length) {
    out(`  ${theme.label("Pending")}\n`);
    for (const request of pending) {
      out(
        `  ${theme.warn(sym.warn)} ${theme.bold(request.id)}  ${theme.accent(request.tool)}  ` +
          `${theme.muted(age(request.createdAt))}  ${theme.muted(`expires ${request.expiresAt}`)}\n`,
      );
      out(`      ${theme.muted(short(request.argsPreview))}\n`);
      out(`      ${theme.muted(`approve: telegram-mcp approve ${request.id}`)}\n`);
    }
    gap();
  } else {
    info(`${theme.success(sym.ok)} no pending approvals`);
    gap();
  }

  if (finished.length) {
    out(`  ${theme.label("Recent decisions")}\n`);
    for (const request of finished.slice(0, 10)) {
      const icon =
        request.status === "approved" || request.status === "consumed"
          ? theme.success(sym.ok)
          : theme.fail(sym.fail);
      out(
        `  ${icon} ${theme.muted(request.id)}  ${request.tool}  ` +
          `${theme.muted(`${request.status} · ${age(request.createdAt)}`)}\n`,
      );
    }
  }
}

function printOne(request: ApprovalRequest, verb: string): void {
  info(`${theme.success(sym.ok)} ${verb} ${theme.bold(request.id)} (${request.tool})`);
  hint("Ask the agent to retry the exact same call. Approval is consumed once.");
}

export async function main(args: string[] = process.argv.slice(2), command?: string): Promise<void> {
  const cmd = command ?? args[0] ?? "list";
  const rest = command ? args : args.slice(1);

  if (cmd === "approvals" || cmd === "list") {
    printList();
    return;
  }

  if (cmd === "approve" || cmd === "deny") {
    const id = rest[0]?.trim();
    if (!id) {
      process.stderr.write(
        `${theme.fail(`${sym.fail} usage: telegram-mcp ${cmd} <approval-id>`)}\n` +
          `${theme.muted("Run `telegram-mcp approvals` to see pending ids.")}\n`,
      );
      process.exitCode = 1;
      return;
    }
    try {
      const request = cmd === "approve" ? approveRequest(id) : denyRequest(id);
      printOne(request, cmd === "approve" ? "approved" : "denied");
    } catch (err) {
      process.stderr.write(
        `${theme.fail(`${sym.fail} ${err instanceof Error ? err.message : String(err)}`)}\n`,
      );
      process.exitCode = 1;
    }
    return;
  }

  process.stderr.write(
    [
      `${theme.label("Usage")}`,
      `  telegram-mcp approvals              list pending requests`,
      `  telegram-mcp approve <id>           allow one exact call`,
      `  telegram-mcp deny <id>              refuse one call`,
      "",
      `${theme.muted("The approval gate is enabled with TELEGRAM_APPROVAL_MODE=destructive|writes.")}`,
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
}

/** Allow `node dist/cli/approvals.js ...` during development. */
const entry = process.argv[1] ?? "";
if (entry.endsWith("approvals.js") || entry.endsWith("approvals.ts")) {
  void main().catch((err) => {
    process.stderr.write(`${theme.fail(`${sym.fail} ${err instanceof Error ? err.message : String(err)}`)}\n`);
    process.exit(1);
  });
}
