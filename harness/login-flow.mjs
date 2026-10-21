#!/usr/bin/env node
/**
 * Interactive login flow over MCP — the same path an AI agent uses.
 *
 * Proves the "no terminal, no manual commands" promise end to end:
 *   1. start the built server and do the MCP handshake
 *   2. telegram_login_start  -> Telegram sends the code to the user's app
 *   3. wait for the code (stdin, or --code for non-interactive runs)
 *   4. telegram_login_code   -> finishes auth, session written 0600
 *   5. telegram_status       -> confirms the account is live
 *
 * Usage:
 *   node harness/login-flow.mjs                 # prompts for the code
 *   node harness/login-flow.mjs --phone=+1555   # supply the number up front
 *   node harness/login-flow.mjs --force         # replace a working session
 *   node harness/login-flow.mjs --code=12345    # non-interactive (CI)
 *   node harness/login-flow.mjs --resume        # skip login_start; reuse a pending
 *                                               #   login already open in an attached server
 *   MCP_ATTACH_SOCKET=/tmp/tg.sock node harness/login-flow.mjs --attach --resume
 *
 * Exit codes: 0 logged in, 1 failed, 2 needs a human step (code or password),
 *             4 --resume without a usable attach socket.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const SERVER = process.env.MCP_SERVER_ENTRY || path.join(root, "dist", "index.js");

const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`${n}=`));
  return hit ? hit.slice(n.length + 1) : d;
};
const flag = (n) => argv.includes(n);

const PHONE = opt("--phone");
const CODE = opt("--code");
const FORCE = flag("--force");
const RESUME = flag("--resume");
const ATTACH = flag("--attach");
const ATTACH_SOCKET = opt("--socket") ?? process.env.MCP_ATTACH_SOCKET ?? null;
const TIMEOUT_MS = Number(opt("--timeout", "180000"));

/* ------------------------------------------------------------------ client */

class Client {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
    this.junk = [];
    this.child = null;
    this.socket = null;
    /** Where we are talking to — reported so the operator knows which process. */
    this.target = "stdio";
  }

  /** Default: spawn a private server and talk over its stdio (unchanged). */
  start() {
    this.target = SERVER;
    this.child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"], cwd: root });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (c) => this.#onData(c));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (c) => process.stderr.write(`[server] ${c}`));
    this.child.on("exit", (code, sig) => {
      for (const [, p] of this.pending) p.reject(new Error(`server exited code=${code} sig=${sig}`));
      this.pending.clear();
    });
    return this;
  }

  /**
   * Attach to an ALREADY-RUNNING server over a Unix domain socket / named pipe.
   *
   * This is the only way to reach a *pending login* that lives in another
   * process: `telegram_login_start` stores `phoneCodeHash` and the live
   * TelegramClient in module memory (login-tools.ts), so a fresh process can
   * never resume someone else's login — it has no session key and no code hash.
   * Attaching keeps the SAME process that sent the code, which is what makes
   * `--resume` meaningful.
   */
  attach(socketPath) {
    this.target = `socket:${socketPath}`;
    return new Promise((resolve, reject) => {
      this.socket = net.connect(socketPath);
      this.socket.setEncoding("utf8");
      this.socket.once("connect", () => resolve(this));
      this.socket.once("error", (err) => reject(err));
      this.socket.on("data", (c) => this.#onData(c));
      this.socket.on("close", () => {
        for (const [, p] of this.pending) p.reject(new Error("attach socket closed before responding"));
        this.pending.clear();
      });
    });
  }

  #onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.junk.push(line.slice(0, 160));
        continue;
      }
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  }

  #write(payload) {
    if (this.socket) {
      this.socket.write(payload);
      return;
    }
    this.child.stdin.write(payload);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async call(name, args = {}) {
    const res = await this.request("tools/call", { name, arguments: args });
    const text = res.result?.content?.[0]?.text ?? "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
    return { isError: Boolean(res.result?.isError), parsed };
  }

  stop() {
    // Only tear down what we created: detaching must not kill the live server,
    // otherwise the pending login (and the resume) dies with us.
    if (this.socket) {
      this.socket.end();
      this.socket = null;
      return;
    }
    this.child?.kill();
  }
}

/* -------------------------------------------------------------------- util */

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) =>
    rl.question(question, (a) => {
      rl.close();
      r(a.trim());
    }),
  );
}

const say = (s = "") => process.stdout.write(`${s}\n`);

/**
 * Probe for a pending login without consuming it.
 *
 * `telegram_login_code` validates the code with `z.string().min(1)`, then calls
 * `needPending()` BEFORE touching Telegram. So a non-digit payload returns
 * `{error:"The login code must contain digits."}` when a login is pending and
 * throws `No login in progress` when it is not — no code is spent, nothing is
 * sent to Telegram. That is the only read-only way to ask "is a login open?".
 */
async function probePending(c) {
  const res = await c.call("telegram_login_code", { code: "-" });
  const text = `${res.parsed.raw ?? ""}${res.parsed.error ?? ""}${JSON.stringify(res.parsed)}`;
  if (/must contain digits/i.test(text)) return true;
  if (/No login in progress|expired/i.test(text)) return false;
  // Anything else (e.g. a transport failure) is not a "no" we can trust.
  return null;
}

/* -------------------------------------------------------------------- main */

async function main() {
  // ---- attach / resume preconditions -------------------------------------
  if (RESUME && !ATTACH_SOCKET) {
    // Be explicit instead of hanging on a prompt for a login that can never
    // complete: a pending login lives in the memory of the process that called
    // telegram_login_start, and this process cannot reach it.
    say("✗ --resume needs a live server to resume against, and none was given.");
    say("");
    say("  Why: `telegram_login_start` keeps the phoneCodeHash and the open");
    say("  TelegramClient in the memory of the server process. A new process has");
    say("  neither, so it can only start a FRESH login (which sends a new code).");
    say("");
    say("  Use one of:");
    say("    MCP_ATTACH_SOCKET=/path/to/sock node harness/login-flow.mjs --attach --resume");
    say("    node harness/login-flow.mjs --resume --socket=/path/to/sock");
    say("");
    say("  The MCP server speaks stdio only (index.ts wires StdioServerTransport),");
    say("  so an attach socket exists only if something is bridging it — see");
    say("  harness/README.md. Without one, just run without --resume: a fresh");
    say("  code is the only way forward.");
    return 4;
  }
  if (ATTACH && !ATTACH_SOCKET) {
    say("✗ --attach requires a socket path (MCP_ATTACH_SOCKET or --socket=…).");
    return 4;
  }

  let c;
  if (ATTACH_SOCKET) {
    c = new Client();
    try {
      await c.attach(ATTACH_SOCKET);
      say(`→ attached to ${ATTACH_SOCKET}`);
    } catch (err) {
      say(`✗ cannot attach to ${ATTACH_SOCKET}: ${err.message}`);
      say("  Is the server running and is that the right socket path?");
      return 4;
    }
  } else {
    c = new Client().start();
  }

  const cleanup = () => c.stop();

  try {
    say(`→ handshake (${c.target})`);
    await c.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "login-flow", version: "1" },
    });

    say("→ checking current state");
    const before = await c.call("telegram_status", {});
    if (before.parsed.authorized && !FORCE) {
      say(`✓ already logged in as @${before.parsed.account?.username ?? "?"} — nothing to do`);
      say("  (pass --force to replace the session)");
      cleanup();
      return 0;
    }

    // ---- resume: skip login_start, reuse the pending login ----------------
    if (RESUME) {
      const pending = await probePending(c);
      if (pending === false) {
        say("✗ no login is pending on that server — there is nothing to resume.");
        say("  The pending login expires after 10 minutes and dies with the process.");
        say("  Run without --resume to start a new one (Telegram sends a fresh code).");
        cleanup();
        return 2;
      }
      if (pending === null) {
        say("✗ could not confirm a pending login (unexpected reply from the server).");
        cleanup();
        return 1;
      }
      say("✓ pending login found — resuming at the code step (no new code was sent)");
      return await finish(c, cleanup);
    }

    let phone = PHONE;
    if (!phone) {
      const st = await c.call("telegram_login_start", { force: FORCE });
      if (st.parsed.needsPhone) {
        phone = await ask("Phone number (international, +15551234567): ");
        if (!phone) {
          say("✗ no phone number given");
          cleanup();
          return 2;
        }
      } else if (st.parsed.codeSent) {
        // The server had TELEGRAM_PHONE set; the code is already on its way.
        say(`✓ code sent to ${st.parsed.deliveredTo}`);
        return await finish(c, cleanup);
      } else if (st.parsed.alreadyAuthorized) {
        say(`✓ already authorized as @${st.parsed.username ?? "?"}`);
        cleanup();
        return 0;
      } else {
        say(`✗ ${JSON.stringify(st.parsed)}`);
        cleanup();
        return 1;
      }
    }

    say(`→ requesting code for ${phone}`);
    const started = await c.call("telegram_login_start", { phone, force: FORCE });
    if (!started.parsed.codeSent) {
      say(`✗ ${JSON.stringify(started.parsed)}`);
      cleanup();
      return 1;
    }
    say(`✓ code sent to ${started.parsed.deliveredTo}`);

    return await finish(c, cleanup);
  } catch (err) {
    say(`✗ ${err.message}`);
    cleanup();
    return 1;
  }
}

async function finish(c, cleanup) {
  const code = CODE ?? (await ask("Login code from Telegram: "));
  if (!code) {
    say("✗ no code given");
    cleanup();
    return 2;
  }

  say("→ submitting code");
  const res = await c.call("telegram_login_code", { code });

  if (res.parsed.passwordRequired) {
    say("→ two-step verification is enabled");
    const pw = await ask("2FA password (input hidden is not supported here; type carefully): ");
    const pwRes = await c.call("telegram_login_password", { password: pw });
    if (pwRes.parsed.authorized) {
      return report(c, pwRes, cleanup);
    }
    say(`✗ ${JSON.stringify(pwRes.parsed)}`);
    cleanup();
    return 1;
  }

  if (res.parsed.authorized) return report(c, res, cleanup);

  say(`✗ ${JSON.stringify(res.parsed)}`);
  cleanup();
  return 1;
}

async function report(c, res, cleanup) {
  say(`✓ logged in as id=${res.parsed.id} @${res.parsed.username ?? "?"}`);

  const after = await c.call("telegram_status", {});
  if (after.parsed.authorized) {
    say(`✓ status confirms: authorized=true, allowAllChats=${after.parsed.allowAllChats}`);
  } else {
    say("✗ status does not confirm authorization — check the server log");
  }

  const doc = await c.call("telegram_doctor", {});
  say(`✓ doctor healthy=${doc.parsed.healthy}`);
  for (const chk of doc.parsed.checks ?? []) {
    say(`   ${chk.pass ? "PASS" : "FAIL"} ${chk.name} — ${chk.detail}`);
  }

  if (c.junk.length) say(`⚠ ${c.junk.length} non-JSON line(s) on stdout: ${c.junk[0]}`);

  cleanup();
  return after.parsed.authorized ? 0 : 1;
}

main().then((code) => process.exit(code));
