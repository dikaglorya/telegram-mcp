#! /usr/bin/env node
/**
 * Env loader. Loads .env from the package root, resolved relative to THIS file
 * so it works no matter what cwd the MCP client spawns the process with, and
 * no matter the OS (Windows, macOS, Linux — path.resolve handles separators).
 *
 * Resolution walks upward from the running file until it finds .env, so both
 * layouts work unchanged:
 *   <root>/dist/index.js, <root>/dist/cli/login.js   (built)
 *   <root>/index.ts,      <root>/cli/login.ts        (tsx)
 */
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

// dotenv >= 17 prints a banner to stdout, which would corrupt the MCP
// JSON-RPC stream. Silence it. Older versions ignore the option.
dotenv.config({ quiet: true } as never);

const here = path.dirname(fileURLToPath(import.meta.url));

/** Walk up from `here` looking for a directory that contains `.env`. */
function findEnv(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const file = findEnv(here);
if (file) dotenv.config({ path: file, override: false, quiet: true } as never);
