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
import { banner, gap, hint, info, muted, sym, theme } from "./ui.js";

function help(): string {
  const rows: Array<[string, string]> = [
    ["telegram-mcp", "serve MCP on stdio (what an MCP client runs)"],
    ["telegram-mcp --version", "print the version and exit"],
    ["telegram-mcp --help", "print this help and exit"],
    ["telegram-mcp login", "log in from this terminal instead of chat"],
    ["telegram-mcp doctor", "check config, session and connectivity"],
    ["telegram-mcp update", "upgrade this install to the latest release"],
    ["telegram-mcp update --check", "report the available version, install nothing"],
  ];
  const width = Math.max(...rows.map(([cmd]) => cmd.length));
  const usage = rows
    .map(([cmd, desc]) => `  ${theme.accent(cmd.padEnd(width))}  ${theme.muted(desc)}`)
    .join("\n");

  return [
    `${theme.title("▀█▀ █▀▀ █░░ █▀▀ █▀▀ █▀█ ▄▀█ █▀▄▀█")}`,
    `${theme.title("░█░ █▀▀ █░░ ██▄ █▄█ █▀▄ █▀█ █░▀░█")}  ${theme.muted(SERVER_VERSION)}`,
    "",
    theme.label("An MCP server for a personal Telegram account, over MTProto."),
    "",
    theme.bold("Usage"),
    usage,
    "",
    theme.bold("Setup"),
    `  ${theme.accent("1.")} Get api_id and api_hash from ${theme.underline("https://my.telegram.org/apps")}`,
    `  ${theme.accent("2.")} Provide them as ${theme.label("TELEGRAM_API_ID")} / ${theme.label("TELEGRAM_API_HASH")},`,
    `     or let the agent call ${theme.label("telegram_setup")}`,
    `  ${theme.accent("3.")} Log in with ${theme.label("telegram_login_start")} (the agent can do it),`,
    `     or run ${theme.label("telegram-mcp login")} in a terminal`,
    "",
    theme.bold("Updating"),
    `  ${theme.accent("telegram-mcp update".padEnd(42))} ${theme.muted("detects how it was installed")}`,
    `  ${theme.accent("telegram-mcp update --check".padEnd(42))} ${theme.muted("report only")}`,
    `  ${theme.accent(`npx -y ${PACKAGE_NAME}@latest`.padEnd(42))} ${theme.muted("npx, always current")}`,
    `  ${theme.accent(`npm install -g ${PACKAGE_NAME}@latest`.padEnd(42))} ${theme.muted("global install")}`,
    "",
    `${theme.muted("Docs")}  ${theme.underline("https://github.com/dikaglorya/telegram-mcp")}`,
    "",
  ].join("\n");
}

/** Subcommands that act like a CLI instead of serving stdio. */
function dispatchSubcommand(argv: string[]): boolean {
  const command = argv[0];
  if (command !== "login" && command !== "doctor" && command !== "update") return false;
  // Each module runs its own main() on import; they keep the same behaviour as
  // `npm run login` and `npm run doctor`, just reachable from one binary.
  const targets: Record<string, string> = {
    login: "./cli/login.js",
    doctor: "./cli/doctor.js",
    update: "./cli/update.js",
  };
  const target = targets[command];
  void import(target).catch((err) => {
    process.stderr.write(
      `${theme.fail(`${sym.fail} cannot start ${command}: ${err instanceof Error ? err.message : String(err)}`)}\n`,
    );
    process.exit(1);
  });
  return true;
}

/** Handled before the transport is created, so stdout stays parseable. */
function handleCliFlags(argv: string[]): boolean {
  // Claude Desktop (and a few other clients) launch the server with
  // `mcp-server-<name>` as an argument. That is not a subcommand, so anything
  // unrecognised must fall through to serving rather than be interpreted.
  const args = argv.slice(2).filter((a) => !/^mcp-server-/.test(a));
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return true;
  }
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    process.stdout.write(help());
    return true;
  }
  return dispatchSubcommand(args);
}

function startupBanner(configured: boolean, allowAll: boolean, allowlist: number): void {
  if (configured) {
    banner({ subtitle: "your Telegram account, as an MCP server", compact: true });
    info(
      `${theme.success(sym.ok)} serving over stdio ${theme.muted(`(allowAll=${allowAll}, allowlist=${allowlist})`)}`,
    );
    return;
  }
  banner({ subtitle: "not configured yet", compact: true });
  info(`${theme.warn(`${sym.warn} ${theme.bold("not configured")} — no api_id/api_hash yet`)}`);
  hint(`get them from ${theme.underline("https://my.telegram.org/apps")}`);
  hint(`then call ${theme.label("telegram_setup")} from chat, or run ${theme.label("telegram-mcp login")}`);
  gap();
  muted(`serving anyway — waiting for the agent`);
}


async function main(): Promise<void> {
  // A missing .env must NOT be fatal: the user needs telegram_setup (and the
  // doctor) to be reachable so they can fix it from chat. Only a genuinely
  // broken server would exit here.
  let config: ReturnType<typeof getConfig> | null = null;
  let reason = "";
  try {
    config = getConfig();
    ensureDirs(config);
  } catch (err) {
    reason = redact(err instanceof Error ? err.message : String(err));
  }

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  startupBanner(Boolean(config), config?.allowAllChats ?? false, config?.allowlist.length ?? 0);
  if (!config && reason) {
    hint(theme.muted(reason.split(".")[0]));
    hint(theme.muted("this server keeps running so the agent can call telegram_setup"));
  }

  // After the transport is live, so a slow or unreachable registry can never
  // delay the first tool call.
  warnIfOutdated();

  const shutdown = async (signal: string) => {
    muted(`${signal}, shutting down`);
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
    process.stderr.write(
      `${theme.fail(`${sym.fail} fatal: ${redact(err instanceof Error ? err.stack ?? err.message : String(err))}`)}\n`,
    );
    process.exit(1);
  });
}
