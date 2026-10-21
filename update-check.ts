/**
 * "A newer version exists" notice.
 *
 * Why it exists: the package is distributed through npx, where the version is
 * resolved on every run, and through `npm i -g`, where it is not. A user who
 * installed globally has no way to learn that a fix shipped unless they think
 * to run `npm outdated -g`. This module prints one line to stderr when the
 * registry has something newer.
 *
 * Design constraints, all deliberate:
 *   - stderr only. stdout belongs to the JSON-RPC transport; a stray line there
 *     would make the agent drop the server.
 *   - never fatal, never blocking. The check runs after the server is already
 *     serving; a timeout, an offline machine or a broken proxy just means no
 *     notice.
 *   - cached for a day, so restarting the client five times does not mean five
 *     registry requests.
 *   - opt out with TELEGRAM_UPDATE_CHECK=0. This is a local-first tool and a
 *     user is entitled to zero outbound traffic that is not Telegram itself.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PACKAGE_NAME, SERVER_VERSION, VERSION_IS_KNOWN, compareVersions } from "./version.js";

const DEFAULT_TIMEOUT_MS = 800;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type UpdateInfo = {
  current: string;
  latest: string;
  updateAvailable: boolean;
  /** Where the answer came from — useful in doctor output. */
  source: "registry" | "cache" | "disabled" | "unknown";
};

type CacheFile = {
  checkedAt: string;
  latest: string;
};

function enabled(): boolean {
  const raw = process.env.TELEGRAM_UPDATE_CHECK;
  if (raw === undefined || raw.trim() === "") return true;
  return !/^(0|false|no|off)$/i.test(raw.trim());
}

function timeoutMs(): number {
  const raw = process.env.TELEGRAM_UPDATE_CHECK_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, 10_000);
}

/**
 * Cache location. Deliberately independent of `getConfig()`: the notice must
 * work before api_id/api_hash are set, and it must not create the state dir
 * just to write a version number.
 */
function cachePath(): string {
  const configured = process.env.TELEGRAM_STATE_DIR?.trim();
  const base = configured
    ? path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()))
    : path.join(os.homedir(), ".telegram-mcp");
  return path.join(base, "update-check.json");
}

function readCache(): CacheFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8")) as Partial<CacheFile>;
    if (typeof parsed.latest !== "string" || typeof parsed.checkedAt !== "string") return null;
    if (Date.now() - Date.parse(parsed.checkedAt) > CACHE_TTL_MS) return null;
    return { latest: parsed.latest, checkedAt: parsed.checkedAt };
  } catch {
    return null;
  }
}

function writeCache(latest: string): void {
  try {
    const file = cachePath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ checkedAt: new Date().toISOString(), latest }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
    fs.renameSync(tmp, file);
  } catch {
    /* a cache we cannot write is not a failure — it just means we ask again */
  }
}

/** Ask the registry for `dist-tags.latest`. Returns null on any problem. */
async function fetchLatest(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs()),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" && body.version.trim() ? body.version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the current state. `allowNetwork: false` reads only the cache, which
 * is what `telegram_doctor` uses so a health check never waits on the network.
 */
export async function getUpdateInfo(opts: { allowNetwork?: boolean } = {}): Promise<UpdateInfo> {
  const current = SERVER_VERSION;
  // Without a trustworthy local version, "newer" has no meaning: skip the
  // notice rather than telling every user to upgrade to something.
  if (!VERSION_IS_KNOWN) return { current, latest: current, updateAvailable: false, source: "unknown" };
  if (!enabled()) return { current, latest: current, updateAvailable: false, source: "disabled" };

  const cached = readCache();
  if (cached) {
    return {
      current,
      latest: cached.latest,
      updateAvailable: compareVersions(cached.latest, current) > 0,
      source: "cache",
    };
  }

  if (opts.allowNetwork === false) {
    return { current, latest: current, updateAvailable: false, source: "unknown" };
  }

  const latest = await fetchLatest();
  if (!latest) return { current, latest: current, updateAvailable: false, source: "unknown" };
  writeCache(latest);
  return {
    current,
    latest,
    updateAvailable: compareVersions(latest, current) > 0,
    source: "registry",
  };
}

/** The single line users see. Shaped to be actionable, not just informative. */
export function formatNotice(info: UpdateInfo): string {
  const upgrade = process.env.npm_config_global === "true"
    ? `npm install -g ${PACKAGE_NAME}@latest`
    : `npx -y ${PACKAGE_NAME}@latest`;
  return (
    `[telegram-mcp] update available: ${info.current} -> ${info.latest}. ` +
    `Run \`${upgrade}\`, or set TELEGRAM_UPDATE_CHECK=0 to silence this.\n`
  );
}

/**
 * Fire-and-forget: called after the server is already serving, so a slow
 * registry can never delay the first tool call.
 */
export function warnIfOutdated(): void {
  void getUpdateInfo()
    .then((info) => {
      if (info.updateAvailable) process.stderr.write(formatNotice(info));
    })
    .catch(() => {
      /* the notice is best-effort by definition */
    });
}
