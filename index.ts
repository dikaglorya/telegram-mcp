#!/usr/bin/env node
/**
 * Entrypoint. Loads .env, builds the MCP server, serves over stdio.
 * stdout = MCP protocol only; diagnostics go to stderr.
 */
import "./stream-guard.js";
import "./env.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";
import { ensureDirs, getConfig, redact } from "./config.js";
import { shutdownLogin } from "./login-tools.js";

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

main().catch((err) => {
  process.stderr.write(`[telegram-mcp] fatal: ${redact(err instanceof Error ? err.stack ?? err.message : String(err))}\n`);
  process.exit(1);
});
