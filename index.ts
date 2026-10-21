#!/usr/bin/env node
/**
 * Entrypoint. Loads .env, builds the MCP server, serves over stdio.
 * stdout = MCP protocol only; diagnostics go to stderr.
 *
 * Exception: `--version` / `--help` are plain CLI invocations. They answer on
 * stdout and exit before the transport is created, so nothing is corrupted.
 */
import "./stream-guard.js";
import "./env.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { ensureDirs, getConfig, redact } from "./config.js";
import { shutdownLogin } from "./login-tools.js";
import { PACKAGE_NAME, SERVER_NAME, SERVER_VERSION } from "./version.js";
import { warnIfOutdated } from "./update-check.js";

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

An MCP server for a personal Telegram account, spoken over stdio.

Usage:
  telegram-mcp                 serve MCP on stdio (what an MCP client runs)
  telegram-mcp --version, -v   print the version and exit
  telegram-mcp --help, -h      print this help and exit

Setup:
  1. Get api_id and api_hash from https://my.telegram.org/apps
  2. Provide them as TELEGRAM_API_ID / TELEGRAM_API_HASH, or let the agent call
     telegram_setup
  3. Log in with telegram_login_start (the agent can do this for you)

Updating:
  npx -y ${PACKAGE_NAME}@latest               # npx, always current
  npm install -g ${PACKAGE_NAME}@latest       # global install

Docs: https://github.com/dikaglorya/telegram-mcp
`;

function handleCliFlags(argv: string[]): boolean {
  const flags = new Set(argv.slice(2));
  if (flags.has("--version") || flags.has("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return true;
  }
  if (flags.has("--help") || flags.has("-h")) {
    process.stdout.write(HELP);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  // A missing .env must NOT be fatal: the user needs telegram_setup (and the
  // doctor) to be reachable so they can fix it from chat. Only a genuinely
  // broken server would exit here.
  let config: ReturnType<typeof getConfig> | null = null;
  try {
    config = getConfig();
    ensureDirs(config);
  } catch (err) {
    process.stderr.write(
      `[telegram-mcp] not configured yet: ${err instanceof Error ? err.message : String(err)}\n` +
        `[telegram-mcp] serving anyway — call telegram_setup to create .env, then telegram_login_start.\n`,
    );
  }

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    config
      ? `[telegram-mcp] serving over stdio (allowAll=${config.allowAllChats}, allowlist=${config.allowlist.length})\n`
      : `[telegram-mcp] serving over stdio (unconfigured — telegram_setup required)\n`,
  );

  // After the transport is live, so a slow or unreachable registry can never
  // delay the first tool call.
  warnIfOutdated();

  const shutdown = async (signal: string) => {
    process.stderr.write(`[telegram-mcp] ${signal}, shutting down\n`);
    try {
      // Drops any half-finished login socket too, not just the main client.
      await shutdownLogin();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (!handleCliFlags(process.argv)) {
  main().catch((err) => {
    process.stderr.write(`[telegram-mcp] fatal: ${redact(err instanceof Error ? err.stack ?? err.message : String(err))}\n`);
    process.exit(1);
  });
}
