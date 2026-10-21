#!/usr/bin/env node
/**
 * Interactive login. Run ONCE in a real terminal, never inside an agent.
 * Works identically on Windows, macOS, and Linux.
 *
 * Prompts for phone, login code, and 2FA password. The StringSession is written
 * to disk with 0600 permissions and is never printed.
 *
 * Secret prompts use readline's built-in terminal mode so backspace, arrows,
 * and paste behave natively on every OS — no raw-mode bit-twiddling.
 */
import "../env.js";
import readline from "node:readline";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import {
  ensureDirs,
  getConfig,
  hasSession,
  readSessionString,
  writeSessionString,
  redact,
} from "../config.js";
import { createLogger } from "../logger.js";

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

/**
 * Ask a question without echoing the answer. readline's `terminal` mode masks
 * the prompt on POSIX and Windows alike; it falls back to a plain read when
 * stdin is not a TTY (piped input) instead of hanging.
 */
function askSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) return ask(question);

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const onSigint = () => {
      rl.close();
      reject(new Error("cancelled"));
    };
    rl.on("SIGINT", onSigint);
    // readline >= 17 renders the masked prompt for us via _writeToOutput.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(question.replace(/: $/, " [hidden]: "));
      else if (s === "\r\n" || s === "\n") process.stdout.write("\n");
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main(): Promise<void> {
  const config = getConfig();
  ensureDirs(config);

  // Re-running login silently mints a NEW auth key for the same account. Telegram
  // then treats the previous key as AUTH_KEY_DUPLICATED and every client holding
  // it stops working. Refuse to overwrite a session that still works.
  if (hasSession(config) && !process.argv.includes("--force")) {
    const probe = new TelegramClient(new StringSession(readSessionString(config)), config.apiId, config.apiHash, {
      connectionRetries: 2,
      baseLogger: createLogger(),
    });
    try {
      await probe.connect();
      const ok = await probe.isUserAuthorized();
      if (ok) {
        const me = (await probe.getMe()) as unknown as Record<string, unknown>;
        process.stderr.write(
          `[login] already authorized as ${me.username ?? String(me.id ?? "")} — nothing to do.\n` +
            `[login] session: ${config.sessionPath}\n` +
            `[login] pass --force to overwrite it with a fresh auth key.\n`,
        );
        await probe.disconnect().catch(() => undefined);
        return;
      }
    } catch {
      /* dead or duplicated session — fall through and replace it */
    }
    await probe.disconnect().catch(() => undefined);
    process.stderr.write(`[login] existing session is unusable, issuing a fresh one\n`);
  }

  process.stderr.write(`[login] session will be stored at ${config.sessionPath}\n`);

  const existing = hasSession(config) ? readSessionString(config) : "";
  const session = new StringSession(existing);
  const client = new TelegramClient(session, config.apiId, config.apiHash, {
    connectionRetries: 5,
    baseLogger: createLogger(),
  });

  // The account may live on another data center; gramJS migrates, then asks the
  // code again. Keep prompts on stdout (the terminal), diagnostics on stderr.
  try {
    await client.start({
      phoneNumber: async () => {
        const stored = process.env.TELEGRAM_PHONE?.trim();
        if (stored) {
          process.stderr.write(`[login] using phone from .env\n`);
          return stored;
        }
        return ask("Phone number (international, e.g. +15551234567): ");
      },
      phoneCode: async () => ask("Login code from Telegram: "),
      password: async () => askSecret("2FA password (leave blank if none)"),
      onError: (err) => {
        // The update loop keeps pinging after we disconnect; those late
        // rejections are noise, not auth failures.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "TIMEOUT" || msg.includes("TIMEOUT")) return;
        process.stderr.write(`[login] auth error: ${redact(msg)}\n`);
      },
    });

    const me = (await client.getMe()) as unknown as Record<string, unknown>;
    const serialized = (client.session as StringSession).save();
    writeSessionString(config, serialized);
    process.stderr.write(
      `[login] authorized as id=${String(me.id ?? "")} username=${me.username ?? "none"}\n`,
    );
    process.stderr.write(`[login] session saved to ${config.sessionPath}\n`);
    process.stderr.write("[login] you can close this and start the MCP server.\n");
  } finally {
    // gramJS fires the update-ping loop the moment we connect. Disconnecting
    // while it is mid-ping prints `Error: TIMEOUT` after a perfectly good
    // login, which reads like a failure. Silence the top-level error handler
    // first, then disconnect.
    try {
      (client as unknown as { _errorHandler?: unknown })._errorHandler = undefined;
      await client.disconnect();
    } catch {
      /* already gone */
    }
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[login] failed: ${redact(msg)}\n`);
  process.exit(1);
});
