#!/usr/bin/env node
/**
 * `telegram-mcp update` — bring the installed copy up to date.
 *
 * The hard part is not the upgrade, it is knowing *how* this copy was
 * installed. A global npm install is upgraded with `npm i -g`, an npx run is
 * replaced by asking npx for @latest, and a git checkout is updated with
 * `git pull` plus a rebuild. Guessing wrong either does nothing (npm refuses
 * to touch a package it does not own) or silently reinstalls the same version.
 *
 * So detection is made from the filesystem, not from a flag the user has to
 * remember:
 *   - the real path of this file lives under node_modules   -> npm package
 *     - under a global prefix (`npm root -g`)               -> global install
 *     - anywhere else (npx cache, local dep)                -> npx
 *   - a sibling `.git` directory                            -> git checkout
 *
 * With `--check` nothing is installed; it only reports. That is what
 * `telegram-mcp update --check` and the doctor use, and it never writes.
 */
import "../env.js";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_NAME, SERVER_VERSION, compareVersions } from "../version.js";
import { getUpdateInfo } from "../update-check.js";
import { banner, gap, hint, info, muted, sym, theme } from "../ui.js";

const out = (text: string): void => void process.stdout.write(text);

export type InstallKind = "global" | "npx" | "source" | "unknown";

export type Plan = {
  kind: InstallKind;
  /** Human readable location of the running copy. */
  location: string;
  current: string;
  latest: string | null;
  /** True when the registry has a version newer than this one. */
  outdated: boolean;
  /** The command that performs the upgrade, already split for spawn. */
  command: string[] | null;
  /** Extra explanation printed above the command. */
  note?: string;
};

/**
 * Where npm puts globally installed packages. Asking npm is more reliable than
 * reconstructing `process.execPath`, which differs between Homebrew, nvm,
 * Volta and the Windows installer. `NPM_CONFIG_PREFIX` still applies, so a
 * custom prefix is detected too.
 */
function npmGlobalRoot(): string | null {
  try {
    const root = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      shell: process.platform === "win32",
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Candidates for the global prefix. `npm root -g` is authoritative, but it is
 * skipped when npm is not on PATH (clients do strip it), and an explicit
 * `npm i -g --prefix <dir>` is easy to miss. The real path of this file gives
 * the answer either way: it ends in
 *   <prefix>/lib/node_modules/<name>/dist/cli/update.js   (POSIX)
 *   <prefix>/node_modules/<name>/dist/cli/update.js       (Windows)
 */
function globalRoots(): string[] {
  const candidates = new Set<string>();
  const fromNpm = npmGlobalRoot();
  if (fromNpm) candidates.add(fromNpm);
  const marker = process.platform === "win32" ? "/node_modules/" : "/lib/node_modules/";
  const here = fileURLToPath(import.meta.url).replace(/\\/g, "/");
  const at = here.lastIndexOf(marker);
  if (at !== -1) candidates.add(here.slice(0, at + marker.length - 1));
  return [...candidates].map((dir) => path.resolve(dir)).filter((dir) => fs.existsSync(dir));
}

/** Walk up looking for a package root (a directory with package.json + .git or dist). */
function findPackageRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

export function detectInstall(): { kind: InstallKind; location: string } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = findPackageRoot(here) ?? here;
  const normalized = root.replace(/\\/g, "/");

  // A git checkout is the only layout that carries its own .git.
  if (fs.existsSync(path.join(root, ".git"))) {
    return { kind: "source", location: root };
  }

  if (/\/node_modules\//.test(`${normalized}/`)) {
    const global = globalRoots().map((p) => p.replace(/\\/g, "/").replace(/\/+$/, ""));
    if (global.some((g) => normalized === g || normalized.startsWith(`${g}/`))) {
      return { kind: "global", location: root };
    }
    // Anything else under node_modules was put there by npx, or by a project
    // that lists this package as a dependency, and both are refreshed by
    // asking npm for @latest rather than by a -g install.
    return { kind: "npx", location: root };
  }

  return { kind: "unknown", location: root };
}

export async function plan(allowNetwork = true): Promise<Plan> {
  const { kind, location } = detectInstall();
  const info = await getUpdateInfo({ allowNetwork });
  const latest = info.source === "disabled" ? null : info.latest;
  const outdated = latest !== null ? compareVersions(latest, SERVER_VERSION) > 0 : false;

  const base: Omit<Plan, "command" | "note"> = {
    kind,
    location,
    current: SERVER_VERSION,
    latest: latest ?? null,
    outdated,
  };

  if (kind === "source") {
    // A detached HEAD, a shallow clone or a checkout without an upstream all
    // fail `pull --ff-only`. Ask git about the tracked upstream instead of
    // assuming `origin/main` exists.
    const upstream = git(location, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    if (!upstream) {
      return {
        ...base,
        command: null,
        note: "this checkout has no upstream branch; update it with `git pull` yourself, then npm install && npm run build",
      };
    }
    return {
      ...base,
      command: ["git", "-C", location, "pull", "--ff-only"],
      note: "then rebuild: npm install && npm run build",
    };
  }

  if (kind === "global") {
    // Respect a custom prefix: `npm i -g --prefix /opt/x` is a global install
    // too, and upgrading it with a plain `npm i -g` would land in a different
    // tree and leave the old copy in place.
    const prefix = globalPrefix();
    return {
      ...base,
      command: prefix
        ? ["npm", "install", "-g", "--prefix", prefix, `${PACKAGE_NAME}@latest`]
        : ["npm", "install", "-g", `${PACKAGE_NAME}@latest`],
    };
  }

  if (kind === "npx") {
    return {
      ...base,
      command: null,
      note: `this copy was loaded from a node_modules folder; restart with \`npx -y ${PACKAGE_NAME}@latest\` and npx will fetch the newest release`,
    };
  }

  return { ...base, command: null, note: "cannot tell how this copy was installed; use npm install -g @latest" };
}

/** Run git and return trimmed stdout, or null when it fails. Never throws. */
function git(cwd: string, args: string[]): string | null {
  try {
    const result = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * The prefix a global install lives under, or null when it is the default one.
 * Read from the resolved global root (`<prefix>/lib/node_modules` on POSIX,
 * `<prefix>/node_modules` on Windows) so no extra npm call is needed.
 */
function globalPrefix(): string | null {
  // Applies to the global root that contains the running copy: a custom
  // prefix must be reused, or the upgrade would install next to it instead of
  // over it.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const normalized = here.replace(/\\/g, "/");
  for (const root of globalRoots()) {
    const g = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized.startsWith(`${g}/`)) {
      return process.platform === "win32" ? path.dirname(root) : path.dirname(path.dirname(root));
    }
  }
  return null;
}

function run(command: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function printPlan(p: Plan, checkOnly: boolean): void {
  const label =
    p.kind === "global"
      ? "global npm package"
      : p.kind === "npx"
        ? "npx or project dependency"
        : p.kind === "source"
          ? "git checkout"
          : "unknown";
  out(`\n  ${theme.label("installed")}   ${theme.bold(p.current)}  ${theme.muted(p.location)}\n`);
  out(`  ${theme.label("latest")}      ${p.latest ? theme.bold(p.latest) : theme.muted("unknown")}\n`);
  out(`  ${theme.label("install")}     ${label}\n`);

  if (p.latest === null) {
    hint("could not reach the npm registry; check the network or TELEGRAM_UPDATE_CHECK");
    return;
  }

  if (!p.outdated) {
    out(`\n  ${theme.success(`${sym.ok} already up to date`)}\n\n`);
    return;
  }

  out(`\n  ${theme.warn(`${sym.warn} ${theme.bold(`${p.current} -> ${p.latest}`)} available`)}\n`);
  if (p.note) hint(p.note);
  if (checkOnly) {
    if (p.command) hint(`to upgrade, run ${theme.label(p.command.join(" "))}`);
    hint("run without --check to apply it");
    out("\n");
    return;
  }
}

/**
 * Exported because `telegram-mcp update` reaches this file by dynamic import
 * from index.ts. The guard at the bottom keeps the import side-effect free for
 * the unit checks, so the dispatcher has to call this itself.
 */
export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check") || argv.includes("--dry-run");

  if (argv.includes("--help") || argv.includes("-h")) {
    out(
      [
        "",
        `  ${theme.bold("telegram-mcp update")}          upgrade this install to the latest release`,
        `  ${theme.bold("telegram-mcp update --check")}  report only; install nothing`,
        "",
        "  The command is chosen from how this copy was installed:",
        `    ${theme.accent("global install")}  npm install -g ${PACKAGE_NAME}@latest`,
        `    ${theme.accent("npx run")}         restart with npx -y ${PACKAGE_NAME}@latest`,
        `    ${theme.accent("git checkout")}    git pull --ff-only, then npm install && npm run build`,
        "",
      ].join("\n"),
    );
    return;
  }

  banner({ subtitle: "update", compact: true });

  const p = await plan(true);
  printPlan(p, checkOnly);

  if (checkOnly || !p.outdated || !p.command) {
    if (!checkOnly && p.outdated && !p.command && p.note) {
      gap();
      hint("nothing was installed; this copy is refreshed by the command above");
      out("\n");
    }
    return;
  }

  info(`${theme.label("running")} ${p.command.join(" ")}`);
  const code = await run(p.command);
  if (code !== 0) {
    out(`\n  ${theme.fail(`${sym.fail} update command exited with ${code}`)}\n\n`);
    process.exitCode = code;
    return;
  }

  if (p.kind === "source") {
    info(`${theme.label("rebuilding")} npm install && npm run build`);
    const install = await run(["npm", "install"]);
    if (install === 0) await run(["npm", "run", "build"]);
  }

  gap();
  out(`  ${theme.success(`${sym.ok} updated to ${p.latest}`)}\n`);
  hint("restart your MCP client so it spawns the new copy");
  out("\n");
}

/**
 * Only run when this file is the entrypoint. `detectInstall` is imported by the
 * unit checks, and importing a module must not print a report or spawn npm.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  void main().catch((err) => {
    process.stderr.write(
      `${theme.fail(`${sym.fail} update failed: ${err instanceof Error ? err.message : String(err)}`)}\n`,
    );
    process.exit(1);
  });
}
