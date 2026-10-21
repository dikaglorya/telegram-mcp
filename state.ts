/**
 * Persistent local state (non-secret): allow list and download history.
 * Stored with 0600 permissions.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDirs, getConfig } from "./config.js";
import { lockFile } from "./perms.js";

export type AllowEntry = {
  value: string;
  id?: string;
  addedAt: string;
};

export type DownloadRecord = {
  id: string;
  path: string;
  mime: string;
  size: number;
  chatId?: string;
  messageId?: number;
  fileName: string;
  createdAt: string;
};

export type StoredState = {
  version: 1;
  allowlist: AllowEntry[];
  downloads: DownloadRecord[];
};

let cache: StoredState | null = null;
let cachePath: string | null = null;

export function statePath(): string {
  return getConfig().statePath;
}

export function loadState(): StoredState {
  const file = statePath();
  if (cache && cachePath === file) return cache;
  let state: StoredState = {
    version: 1,
    allowlist: [],
    downloads: [],
  };
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    state = {
      version: 1,
      allowlist: parsed.allowlist ?? [],
      downloads: parsed.downloads ?? [],
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  cache = state;
  cachePath = file;
  return state;
}

export function saveState(state: StoredState): void {
  const file = statePath();
  ensureDirs(getConfig());
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  lockFile(tmp);
  fs.renameSync(tmp, file);
  cache = state;
  cachePath = file;
}

export function mutateState(fn: (state: StoredState) => void): StoredState {
  const state = loadState();
  fn(state);
  saveState(state);
  return state;
}
