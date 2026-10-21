#!/usr/bin/env node
/**
 * Portable launcher.
 *
 * Finds a Node.js runtime without hardcoding any path or platform:
 *   1. process.execPath      — the exact node running this script
 *   2. TELEGRAM_MCP_NODE     — explicit override
 *   3. `node` on PATH        — last resort (child of a node process always has one)
 *
 * Then spawns the real server entrypoint (dist/index.js next to this file).
 * This lets npm's `bin` shim work on Windows, macOS, and Linux identically.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));

const entry = [
  path.join(here, "index.js"), // bin/ next to dist/index.js (published layout)
  path.join(here, "..", "dist", "index.js"), // bin/ inside package root (dev layout)
].find((p) => fs.existsSync(p));

if (!entry) {
  process.stderr.write("[telegram-mcp] cannot locate index.js — run `npm run build` first.\n");
  process.exit(1);
}

const nodeBin = process.env.TELEGRAM_MCP_NODE || process.execPath || "node";
const child = spawn(nodeBin, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
child.on("error", (err) => {
  process.stderr.write(`[telegram-mcp] failed to start node: ${err.message}\n`);
  process.exit(1);
});
