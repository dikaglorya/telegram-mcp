/**
 * Cross-platform file-permission helper.
 *
 * POSIX systems get real 0600 bits. Windows has no chmod semantics — the call
 * would throw, so we skip it there and rely on the user's profile ACLs (the
 * state dir lives under the user's home). Never throws.
 */
import fs from "node:fs";

const IS_WINDOWS = process.platform === "win32";

/** Restrict a file to the current user (0600). No-op on Windows. */
export function lockFile(filePath: string): void {
  if (IS_WINDOWS) return;
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort — a filesystem may not support chmod */
  }
}

/** Restrict a directory to the current user (0700). No-op on Windows. */
export function lockDir(dirPath: string): void {
  if (IS_WINDOWS) return;
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    /* best effort */
  }
}
