/**
 * The one place the version number comes from.
 *
 * `package.json` is the source of truth: npm writes the version it publishes,
 * so reading it back means the MCP `serverInfo`, `--version` and the update
 * check can never drift from the artifact that was actually shipped.
 *
 * Resolution walks up from this file, which covers every layout:
 *   <root>/dist/version.js   (published / built)
 *   <root>/version.ts        (tsx, dev)
 *   <root>/node_modules/@dikacode/telegram-mcp/dist/version.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_NAME = "telegram-mcp";
export const PACKAGE_NAME = "@dikacode/telegram-mcp";

/**
 * Last resort when package.json is unreadable. Deliberately not a plausible
 * version: a guess here would make the update check nag about a release the
 * user may already be running, so an unknown version disables the notice.
 */
const FALLBACK_VERSION = "0.0.0-unknown";

function readVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {
      /* keep walking: this directory is not the package root */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return FALLBACK_VERSION;
}

export const SERVER_VERSION = readVersion();

/** True when package.json could not be read, so the version is not trustworthy. */
export const VERSION_IS_KNOWN = SERVER_VERSION !== "0.0.0-unknown";

/** Dotted-numeric comparison, prerelease-aware, with no dependency. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string } => {
    const cleaned = v.trim().replace(/^v/i, "").split("+")[0];
    const dash = cleaned.indexOf("-");
    const core = dash === -1 ? cleaned : cleaned.slice(0, dash);
    const pre = dash === -1 ? "" : cleaned.slice(dash + 1);
    const nums = core.split(".").map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };

  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    if (left.nums[i] !== right.nums[i]) return left.nums[i] < right.nums[i] ? -1 : 1;
  }
  // Same core: a release outranks any prerelease of it.
  if (!left.pre && right.pre) return 1;
  if (left.pre && !right.pre) return -1;
  if (left.pre === right.pre) return 0;
  return left.pre < right.pre ? -1 : 1;
}
