/**
 * MCP-safe logger for gramJS.
 *
 * The default gramJS Logger uses console.log — i.e. **stdout** — which is the
 * MCP JSON-RPC channel. A single log line there corrupts the protocol stream
 * and the client drops the server. This subclass routes everything to stderr
 * instead, and silences INFO/DEBUG entirely so agent consoles stay readable.
 */
import { Logger, LogLevel } from "telegram/extensions/Logger.js";

const LEVELS = ["error", "warn", "info", "debug"] as const;

export class StderrLogger extends Logger {
  log(level: string, message: string): void {
    // Warnings are worth surfacing; info/debug are noise during every connect.
    if (level === LogLevel.INFO || level === LogLevel.DEBUG) return;
    process.stderr.write(`[telegram] ${level.toUpperCase()} ${message}\n`);
  }
}

/** A logger that emits only errors, all of them on stderr. */
export function createLogger(): StderrLogger {
  const logger = new StderrLogger(LogLevel.ERROR);
  // Guard against upstream calling setLevel with something noisier.
  logger.setLevel = () => undefined;
  return logger;
}

export { LEVELS as LOG_LEVELS };
