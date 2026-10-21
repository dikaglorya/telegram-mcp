#!/usr/bin/env node
/**
 * MCP stdio test harness.
 *
 * Speaks real MCP JSON-RPC to the built server (`dist/index.js`) over stdin/
 * stdout, so it exercises exactly the path an MCP client (opencode, Codex,
 * Claude Desktop) uses — not a hand-rolled MTProto script.
 *
 * Usage:
 *   node harness/mcp-harness.mjs                 # list + read-only smoke tests
 *   node harness/mcp-harness.mjs --write         # + self-cleaning write round trips
 *   node harness/mcp-harness.mjs --all           # + destructive tools (creates real groups!)
 *   node harness/mcp-harness.mjs --destructive   # allow permanent side effects
 *   node harness/mcp-harness.mjs --cleanup       # reclaim chats left by earlier runs
 *   node harness/mcp-harness.mjs --only=telegram_status,telegram_list_chats
 *   node harness/mcp-harness.mjs --json          # machine-readable report
 *   node harness/mcp-harness.mjs --doctor        # only telegram_doctor, health-gated exit code
 *
 * Exit codes:
 *   0  every executed case passed AND stdout carried JSON-RPC only
 *   1  a case failed, a write was skipped by mistake, or the server wrote non-JSON to
 *      stdout (a protocol violation: stdout must carry JSON-RPC only)
 *   3  --doctor only: the server is reachable but `healthy:false`
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const SERVER = process.env.MCP_SERVER_ENTRY || path.join(root, "dist", "index.js");

// The end-to-end cases need a chat the account can read. A public channel is the
// default so a fresh clone can run the read-only pass; point TELEGRAM_TEST_CHAT
// at your own test chat for a fixed message with an attachment.
const TEST_CHAT = process.env.TELEGRAM_TEST_CHAT ?? "@telegram";
// Renaming, inviting and leaving need a chat this account actually owns. There
// is no safe default: unset means those scenarios report an honest skip.
const ADMIN_TEST_CHAT = process.env.TELEGRAM_HARNESS_CHAT ?? null;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => {
  const hit = argv.find((a) => a.startsWith(`${n}=`));
  return hit ? hit.slice(n.length + 1) : d;
};

const ONLY = opt("--only")?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
const JSON_OUT = flag("--json");
const WITH_WRITES = flag("--write") || flag("--all");
const WITH_DESTRUCTIVE = flag("--destructive") || flag("--all");
const TIMEOUT_MS = Number(opt("--timeout", "60000"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- transport */

/**
 * A JSON-RPC 2.0 frame: `jsonrpc:"2.0"` plus either a `result`/`error` (response)
 * or a `method` (request/notification). Anything else on stdout — a banner, a
 * progress dot, `console.log` output that escaped stream-guard — breaks clients.
 */
function isJsonRpcFrame(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return false;
  if (msg.jsonrpc !== "2.0") return false;
  return "result" in msg || "error" in msg || typeof msg.method === "string";
}

/* ------------------------------------------------------------- debris journal */

/**
 * Every message id a run creates is recorded here the moment it is known, and
 * removed again once the run deletes it. A run killed halfway therefore leaves an
 * exact list of what it made, which is the only safe way to clean up afterwards:
 * `--reclaim` deletes from this list and never from a guess.
 *
 * The file lives next to the project (not in ~/.telegram-mcp) so it is obviously
 * a test artifact and is never mistaken for account state.
 */
const JOURNAL = path.join(root, ".harness-journal.json");

function readJournal() {
  try {
    const parsed = JSON.parse(fs.readFileSync(JOURNAL, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJournal(entries) {
  try {
    if (!entries.length) {
      fs.rmSync(JOURNAL, { force: true });
      return;
    }
    fs.writeFileSync(JOURNAL, JSON.stringify(entries, null, 2) + "\n");
  } catch {
    /* a journal that cannot be written must not fail the run */
  }
}

/** Record a message this run created, so a crash can be cleaned up exactly. */
function journalAdd(chat, id, tool) {
  if (typeof id !== "number") return;
  const entries = readJournal();
  if (entries.some((e) => e.chat === chat && e.id === id)) return;
  entries.push({ chat, id, tool: tool ?? null, at: new Date().toISOString() });
  writeJournal(entries);
}

/** Forget ids this run successfully deleted again. */
function journalRemove(chat, ids) {
  const gone = new Set(ids);
  writeJournal(readJournal().filter((e) => !(e.chat === chat && gone.has(e.id))));
}

/**
 * Is this message one the harness made?
 *
 * A watermark alone is not enough: another client may write to Saved Messages
 * while a run is in progress, and anything newer than the watermark would then be
 * attributed to the harness. That is how a cleanup script once deleted two
 * messages that predated the run. A message counts as debris only if it carries the harness
 * marker text or is a poll/location, which the harness is the only producer of
 * in this chat. Everything else is left alone and reported, never deleted.
 */
function looksLikeHarnessDebris(m) {
  if (/\[harness\]/i.test(String(m.text ?? ""))) return true;
  return ["MessageMediaPoll", "MessageMediaGeo"].includes(m.media?.type);
}

/** Newest message id in Saved Messages, or 0 when it is empty. */
async function newestInSaved(client) {
  const r = await client.callTool("telegram_get_history", { chat: "me", limit: 1 });
  if (!r.ok) return 0;
  try {
    const ids = (JSON.parse(r.text).messages ?? []).map((m) => m.id).filter((n) => typeof n === "number");
    return ids.length ? Math.max(...ids) : 0;
  } catch {
    return 0;
  }
}

/**
 * Message ids in Saved Messages newer than `watermark`.
 *
 * Retries on a rate limit: this runs in the *recovery* path, right after a send
 * was throttled, so a throttle here would return `[]` and silently lose track of
 * a message that really exists. That is how two polls and two locations survived
 * a run while the report said the scenario had simply been skipped.
 *
 * The retry is generous on purpose. Telegram throttles `get_history` in the same
 * burst that throttled the send, so a single retry after 3s still lands inside the
 * window and returns an empty list — which looks exactly like "nothing to clean
 * up". Five attempts with backoff is the difference between a real answer and a
 * reassuring one.
 */
async function newerThan(client, watermark) {
  const waits = [2000, 4000, 8000, 12000, 15000];
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    const r = await client.callTool("telegram_get_history", { chat: "me", limit: 20 });
    if (r.ok) {
      try {
        return (JSON.parse(r.text).messages ?? [])
          .map((m) => m.id)
          .filter((n) => typeof n === "number" && n > watermark);
      } catch {
        return [];
      }
    }
    // Only a throttle is worth waiting out; anything else will not improve.
    if (!isRateLimit(r)) return [];
    if (attempt === waits.length) break;
    const secs = r.meta?.retryAfterSec;
    const hinted = typeof secs === "number" ? secs * 1000 : 0;
    await new Promise((resolve) => setTimeout(resolve, Math.max(hinted, waits[attempt])));
  }
  // Everything was throttled: say so instead of pretending the account is clean.
  return null;
}

class McpClient {
  constructor(entry, env = {}) {
    this.entry = entry;
    // Extra env for the child: `--policy` uses this to install a real allowlist,
    // which every other mode must not have.
    this.extraEnv = env;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = [];
    this.junk = [];
    this.child = null;
  }

  start() {
    this.child = spawn(process.execPath, [this.entry], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: root,
      env: {
        ...process.env,
        TELEGRAM_FLOOD_WAIT_MAX: process.env.TELEGRAM_FLOOD_WAIT_MAX ?? "0",
        // The suite must stay offline and deterministic: the startup update
        // check would otherwise reach the registry and add stderr noise that a
        // scenario asserting on logs could trip over.
        TELEGRAM_UPDATE_CHECK: process.env.TELEGRAM_UPDATE_CHECK ?? "0",
        ...this.extraEnv,
      },
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      // Keep a bounded tail so a crashing server can be diagnosed.
      this.stderr.push(chunk);
      if (this.stderr.length > 200) this.stderr.shift();
    });

    this.child.on("exit", (code, signal) => {
      for (const [, p] of this.pending) {
        p.reject(new Error(`server exited (code=${code} signal=${signal}) before responding`));
      }
      this.pending.clear();
    });

    return this;
  }

  #onData(chunk) {
    this.buffer += chunk;
    let idx;
    // MCP stdio frames are newline-delimited JSON.
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // A non-JSON line on stdout is a protocol violation: stdout must carry
        // JSON-RPC only. Recorded here, turned into a hard failure by the runner.
        this.junk.push({ line: line.slice(0, 300), reason: "not JSON" });
        continue;
      }
      if (!isJsonRpcFrame(msg)) {
        // Parseable JSON that is still not a JSON-RPC frame is just as fatal:
        // the client cannot dispatch it and may drop the server.
        this.junk.push({ line: line.slice(0, 300), reason: "not a JSON-RPC frame" });
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  }

  request(method, params = {}, { id = this.nextId++ } = {}) {
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${TIMEOUT_MS}ms waiting for ${method}`));
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

      this.child.stdin.write(JSON.stringify(payload) + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize() {
    const res = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "mcp-harness", version: "1.0.0" },
    });
    this.notify("notifications/initialized");
    return res;
  }

  async listTools() {
    const res = await this.request("tools/list", {});
    return res.result?.tools ?? [];
  }

  async callTool(name, args = {}) {
    const started = Date.now();
    const res = await this.request("tools/call", { name, arguments: args });
    const ms = Date.now() - started;
    const result = res.result ?? {};
    const text = (result.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    // A JSON-RPC `error` is a *refusal*, and the harness used to score it as a
    // success: `res.result` is undefined, `isError` is undefined, and the text is
    // empty, so `ok: true` with nothing in it. That is how a tool which rejects
    // its arguments could look green — exactly the failure this harness exists to
    // catch. Input validation arrives this way, so it is surfaced as a normal
    // tool error with the protocol message as the text.
    const rpcError = res.error ?? null;
    if (rpcError) {
      return {
        ok: false,
        isError: true,
        text: String(rpcError.message ?? "JSON-RPC error"),
        meta: null,
        ms,
        error: rpcError,
      };
    }

    return {
      ok: !result.isError,
      isError: Boolean(result.isError),
      text,
      meta: result._meta ?? null,
      ms,
      error: null,
    };
  }

  stop() {
    // A partial frame left in the buffer when the server dies is also junk: a
    // real client would hang waiting for a newline or see a truncated line.
    const tail = this.buffer.trim();
    if (tail) this.junk.push({ line: tail.slice(0, 300), reason: "truncated frame (no newline)" });
    this.buffer = "";
    try {
      this.child?.stdin.end();
      this.child?.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------ test catalog */

/**
 * Every tool must appear here. `kind` drives what we expect:
 *   read   - safe to call, must not error
 *   write  - mutates Telegram; only run with --write
 *   expect-error - must return isError (validates error handling)
 */
const CATALOG = {
  telegram_status: { kind: "read", args: {}, expect: /authorized|account|ok/i },
  telegram_doctor: { kind: "read", args: {}, expect: /healthy|checks/i },
  telegram_setup: { kind: "read", args: {}, expect: /written|needs|configured/i },
  telegram_me: { kind: "read", args: {}, expect: /id|username|name/i },
  telegram_full_user: { kind: "read", args: { user: "me" }, expect: /"isSelf":\s*true/ },
  telegram_list_chats: { kind: "read", args: { limit: 5 }, expect: /chats|count/i },
  telegram_get_contacts: { kind: "read", args: { limit: 5 }, expect: /contacts|count/i },
  telegram_list_downloads: { kind: "read", args: { limit: 5 }, expect: /downloads|count/i },
  telegram_search_users: { kind: "read", args: { query: "durov", limit: 3 }, expect: /users|count|results/i },

  telegram_chat_info: { kind: "read", args: { chat: TEST_CHAT }, expect: /"title"|"username"|"type"/i },
  telegram_chat_members: {
    kind: "manual",
    args: { chat: "me", limit: 3 },
    reason: "a public channel hides its member list — covered by the admin scenario (TELEGRAM_HARNESS_CHAT)",
  },
  telegram_get_history: { kind: "read", args: { chat: TEST_CHAT, limit: 3 }, expect: /messages|count|hasMore|nextOffsetId/i },
  telegram_search_messages: { kind: "read", args: { chat: TEST_CHAT, query: "tes", limit: 3 }, expect: /results|count|hasMore|nextOffsetId/i },
  telegram_get_message: {
    kind: "read",
    args: async (client) => ({ chat: TEST_CHAT, messageId: await pickChannelMessage(client) }),
    expect: /"id":\s*\d+/,
  },
  // The message shape must stay complete: a sender *name* (not just an id), the
  // shaped entity list, and the counters. Pinning the keys rather than their
  // values keeps this independent of what happens to be in the channel today,
  // while still failing the moment a field is dropped from shapeMessage again.
  telegram_get_message__full_shape: {
    kind: "read",
    tool: "telegram_get_message",
    args: async (client) => ({ chat: TEST_CHAT, messageId: await pickChannelMessage(client) }),
    expect: /"senderName":[\s\S]*"postAuthor":[\s\S]*"forwards":[\s\S]*"groupedId":[\s\S]*"reactions":[\s\S]*"entitiesCount":/,
  },
  // It writes a file into the export directory, so `artifact: "path"` makes the
  // runner check the file really exists and then delete it — otherwise every
  // read-only pass left one more behind in the user's export directory.
  telegram_export_history: {
    kind: "read",
    args: { chat: TEST_CHAT, limit: 5, format: "json" },
    expect: /exported|path/i,
    artifact: "path",
  },

  // Login flow: driven separately by scripts/login-flow, never auto-fired here
  // (it would send a real code to the user's phone).
  telegram_login_start: { kind: "manual", args: {}, reason: "manual step (sends a real code to the user's phone)" },
  telegram_login_code: { kind: "manual", args: { code: "0" }, reason: "manual step (needs the code from the user)" },
  telegram_login_password: { kind: "manual", args: { password: "0" }, reason: "manual step (needs the 2FA password)" },
  telegram_login_cancel: { kind: "read", args: {}, expect: /cancelled/i },

  // Error-path coverage: these MUST fail cleanly with a structured code.
  telegram_chat_info__bad: {
    kind: "expect-error",
    tool: "telegram_chat_info",
    args: { chat: "@this_username_does_not_exist_zzz9" },
    expect: /UNKNOWN|USERNAME_NOT_OCCUPIED|no chat matched/i,
  },
  // gramJS answers a non-username, non-id string with a fuzzy name search, and
  // that search returned a user named "Message" for "Archive". Accepting it would
  // let an edit or a delete land on a chat nobody named, so the refusal itself is
  // the contract worth pinning.
  telegram_chat_info__refuses_a_guess: {
    kind: "expect-error",
    tool: "telegram_chat_info",
    args: { chat: "Archive" },
    expect: /not what was asked for|no chat matched/i,
  },
  // A missing message id is NOT an error: telegram_get_message returns
  // {found:false}. Kept as a read case so the contract is pinned.
  telegram_get_message__bad: {
    kind: "read",
    tool: "telegram_get_message",
    args: { chat: TEST_CHAT, messageId: 999999999 },
    expect: /"found":\s*false/i,
  },
  // A chat that does not resolve, however, must error.
  telegram_get_message__badchat: {
    kind: "expect-error",
    tool: "telegram_get_message",
    args: { chat: "@this_username_does_not_exist_zzz9", messageId: 1 },
    expect: /UNKNOWN|USERNAME_NOT_OCCUPIED|no chat matched/i,
  },
  telegram_get_history__badargs: {
    kind: "expect-error",
    tool: "telegram_get_history",
    args: { chat: TEST_CHAT, limit: 999 },
    expect: /limit|invalid|isError/i,
  },

  // Mutating tools.
  //
  // `write` cases run a self-contained round trip that leaves no trace: they
  // operate on "me" (Saved Messages) and clean up after themselves. A write case
  // that merely passes `messageId: 0` only ever exercises the error path, which
  // proves nothing about whether the tool can actually write.
  //
  // `destructive` cases mutate the account in a way that cannot be undone from
  // the MCP side (a created group, an added contact, an overwritten profile).
  // They are gated behind --destructive so a normal `npm run test:mcp -- --write`
  // never leaves debris behind.
  // `send_message`, `send_file`, `send_photo` are exercised inside the
  // "attachment round trip" scenario below, which deletes what it sends. They are
  // listed here only so coverage counts them; the scenario marks them verified.
  telegram_send_message: { kind: "write", args: { chat: "me", text: "[harness] ping" } },
  telegram_send_file: { kind: "write", args: { chat: "me", filePath: "/etc/hostname" } },
  telegram_send_photo: { kind: "write", args: { chat: "me", filePath: "/etc/hostname" } },
  // `telegram_mark_read` is pinned below with its read-back assertion.
  telegram_mute_chat: { kind: "write", args: { chat: "me", days: 0 } },

  // Needs a real message id, supplied by the scenario below. The id must be
  // schema-valid (>= 1): `0` is rejected by `positive()` before the tool runs, so
  // a fallback call reported "invalid arguments" instead of anything about the
  // tool itself.
  telegram_edit_message: { kind: "write", args: { chat: "me", messageId: 1, text: "x" } },
  telegram_delete_messages: { kind: "write", args: { chat: "me", messageIds: [1] } },
  telegram_forward_messages: { kind: "write", args: { fromChat: "me", toChat: "me", messageIds: [1] } },
  telegram_pin_message: {
    kind: "write",
    args: { chat: "me", messageId: 1 },
    // A message that does not exist cannot be pinned, so the honest answer is a
    // refusal — but it must be a refusal, never `pinned: true` for a no-op. The
    // real pin/unpin round trip lives in the "chat lifecycle" scenario, on a
    // message this account owns.
    expect: /pinned|not found|no such/i,
  },

  // Leaving a chat is not reversible from the MCP side and "me" is not
  // leavable, so the only honest automated check is that it refuses cleanly
  // instead of half-leaving something. Real leave coverage needs a disposable
  // group, which is out of scope for an unattended run.
  telegram_leave_chat__refuses_self: {
    kind: "expect-error",
    tool: "telegram_leave_chat",
    args: { chat: "me" },
    expect: /only applies to groups|CHAT|PEER/i,
  },

  // Reactions are exercised inside the lifecycle scenario (they need a real
  // channel message and Premium for Saved Messages), so no single-call args here.
  // The `verified` flag is the point: the tool used to report `reacted: true`
  // whether or not the message ended up carrying the reaction.
  telegram_react: {
    kind: "manual",
    args: { chat: "me", messageId: 0, emoji: "👍" },
    reason: "covered by the chat-lifecycle scenario (use --destructive)",
  },

  // Permanent side effects: opt in with --destructive only.
  telegram_join_chat: { kind: "destructive", args: { target: "@telegram" }, idempotent: true },
  // `durov` resolves to a CHANNEL, which add_contact must refuse. A real save
  // needs a second account to be meaningful, so it is a manual step; the bot
  // refusal below is the automatic half of the contract.
  telegram_add_contact: {
    kind: "manual",
    args: { user: "durov", firstName: "harness" },
    reason: "saving a real contact changes the account — verify by hand against a second account",
  },
  // A bot cannot be saved as a contact: Telegram accepts the RPC and ignores it,
  // so this pins that the tool reports the truth instead of `added: true`.
  telegram_add_contact__bot: {
    tool: "telegram_add_contact",
    kind: "expect-error",
    args: { user: "BotFather", firstName: "harness" },
    expect: /not in the contact list|Bots cannot be saved/,
  },
  // Deleting a real contact is a genuine change to the account, so it is never
  // fired automatically. Covered by harness/README.md as a manual step.
  telegram_delete_contacts: {
    kind: "manual",
    args: { users: ["durov"] },
    reason: "manual step (deleting a real contact is a genuine account change)",
  },
  telegram_create_group: { kind: "destructive", args: { title: "harness", users: ["me"] } },
  telegram_create_channel: { kind: "destructive", args: { title: "harness", about: "test" } },
  // Deleting a real chat needs a real target, and there is no safe fixed
  // argument for it: the chat-lifecycle scenario creates one and deletes it.
  // Marked manual so a --write-only run reports an honest skip instead of
  // firing a delete at an arbitrary chat.
  telegram_delete_chat: {
    kind: "manual",
    args: { chat: "me" },
    reason: "needs a chat to delete — proven by the chat-lifecycle scenario (use --destructive)",
  },
  // A no-op patch: with no field set the tool touches nothing, so a fallback
  // run can never rewrite the live profile the way the old `about: "harness"`
  // args did. The real coverage is the self-restoring scenario above.
  telegram_update_profile: { kind: "write", args: {} },
  // A download needs a message that actually carries an attachment, and only the
  // scenario below can supply one. This entry used to be a `write` case pointed at
  // message 1 — the very message the expect-error case below proves has *no*
  // attachment — so it could never pass: whenever the scenario failed, this
  // fallback fired and reported a second, bogus failure on top of it. Marked
  // manual, the same way `telegram_delete_chat` is, so a run that could not
  // exercise the scenario reports an honest skip instead.
  // Covered end-to-end by the "download round trip" scenario, which downloads,
  // lists, re-downloads (asserting no duplicate index row) and deletes. The
  // no-attachment error path is pinned separately below.
  telegram_download_media: {
    kind: "manual",
    args: { chat: "me", messageId: 0 },
    reason: "covered end-to-end by the download scenario (use --write)",
  },

  // ---- tools added after the first catalogue pass -------------------------
  // Read-only: safe to fire on every run.
  telegram_user_photos: { kind: "read", args: { user: "me", limit: 2 }, expect: /"count"/ },
  telegram_list_blocked: { kind: "read", args: { limit: 5 }, expect: /blocked|count/i },
  telegram_audit_summary: { kind: "read", args: {}, expect: /calls|path/i },
  telegram_audit_log: { kind: "read", args: { limit: 2 }, expect: /entries|exists|path/i },

  // `unblock:true` on an account that is not blocked is a no-op, so the pair is
  // harmless; blocking for real is covered by the reversible round trip in
  // harness/README.md, not by an automatic case.
  telegram_block_user: {
    kind: "manual",
    args: { user: "BotFather", unblock: true },
    reason: "blocking is a real account change — verified manually as a block/unblock round trip",
  },
  // The read-back path: unblocking someone who is not blocked must still report
  // `verified: true` and leave the block list unchanged. This is the check that
  // would have caught the tool echoing the request instead of the account.
  telegram_block_user__unblock_is_verified: {
    kind: "read",
    tool: "telegram_block_user",
    args: { user: "BotFather", unblock: true },
    expect: /"verified":\s*true/,
  },

  // Writes that clean up after themselves.
  telegram_typing: { kind: "write", args: { chat: "me", action: "cancel" }, expect: /"typing":\s*false/ },
  // Both of these used to echo the request back. The pin now demands the
  // read-back field, so a regression that drops GetDialogs/GetNotifySettings
  // fails here instead of passing on a cheerful lie.
  telegram_archive_chat: {
    kind: "write",
    args: { chat: "me", archived: false },
    expect: /"archived":\s*false[\s\S]*"verified":\s*true/,
  },
  telegram_mark_read: {
    kind: "write",
    args: { chat: "me" },
    expect: /"read":\s*true[\s\S]*"verified":\s*true/,
  },
  telegram_pin_chat: { kind: "write", args: { chat: "me", pinned: false }, expect: /"pinned":\s*false/ },
  // Both are proven by the "chat edit + invite round trip" scenario, which puts
  // the original title back and only uses the non-revoking invite form. The
  // fallback args are deliberately no-ops so a run that skips the scenario
  // cannot rename anything.
  telegram_edit_chat: {
    kind: "manual",
    args: { chat: "me" },
    reason: "renames a real chat — covered by the admin scenario (TELEGRAM_HARNESS_CHAT)",
  },
  telegram_export_invite_link: {
    kind: "manual",
    args: { chat: "me" },
    reason: "needs a chat this account administers (TELEGRAM_HARNESS_CHAT)",
  },
  telegram_clear_history: {
    kind: "manual",
    args: { chat: "me" },
    reason: "destroys message history irreversibly — never fired automatically",
  },
  telegram_unpin_all: { kind: "write", args: { chat: "me" }, expect: /unpinned|count/i },
  telegram_delete_download: {
    kind: "expect-error",
    args: { id: "no-such-record" },
    expect: /no download record/i,
  },

  // ---- session, admin and message tools added in the second pass ----------
  // Read-only, safe on every run.
  telegram_common_chats: { kind: "read", args: { user: "me", limit: 3 }, expect: /"count"/ },
  telegram_pinned_messages: { kind: "read", args: { chat: TEST_CHAT, limit: 3 }, expect: /"count"/ },
  telegram_search_global: { kind: "read", args: { query: "telegram", limit: 3 }, expect: /"count"|totalMatches|hasMore|nextOffsetRate/i },
  telegram_list_sessions: { kind: "read", args: {}, expect: /"sessions"|count/i },
  telegram_message_link: {
    kind: "read",
    args: async (client) => ({ chat: TEST_CHAT, messageId: await pickChannelMessage(client) }),
    expect: /t\.me|tg:\/\//,
  },

  // The current photo is deleted first and restored from a scratch file after;
  // that restore is a real upload, so it is not fired automatically.
  telegram_set_my_photo: {
    kind: "manual",
    args: { remove: true },
    reason: "removes a real profile photo — the delete/restore round trip is a manual step",
  },
  // Revoking a session is irreversible and `all:true` would cut off the agent's
  // own phone. The refusal paths are pinned below; the success path is manual.
  telegram_logout_session: {
    kind: "manual",
    args: { hash: "0" },
    reason: "revoking a real session is irreversible — the refusal paths are pinned below",
  },
  telegram_logout_session__no_args: {
    kind: "expect-error",
    tool: "telegram_logout_session",
    args: {},
    expect: /pass hash|all=true/i,
  },
  telegram_logout_session__unknown_hash: {
    kind: "expect-error",
    tool: "telegram_logout_session",
    args: { hash: "999999999999" },
    expect: /no session with that hash/i,
  },
  // Pins the most important safety property of this tool: it must never revoke
  // the session it is running on, or the agent cuts itself off mid-call.
  telegram_logout_session__refuses_self: {
    kind: "expect-error",
    tool: "telegram_logout_session",
    args: { hash: "0" },
    expect: /refusing to revoke the session running this server/i,
  },

  // Polls and contact cards are real messages; the send/delete round trip is a
  // manual step, the argument validation is pinned here.
  // Polls, contact cards and locations are real messages: the "media senders
  // round trip" scenario sends and deletes each one, so they are not manual.
  telegram_send_poll: { kind: "write", args: { chat: "me", question: "[harness] poll", answers: ["a", "b"] } },
  telegram_send_poll__needs_two_answers: {
    kind: "expect-error",
    tool: "telegram_send_poll",
    args: { chat: "me", question: "q", answers: ["only-one"] },
    // zod rejects it before the handler runs, so the message is the schema's.
    expect: /answers|too small|at least 2|validation/i,
  },
  telegram_send_contact: { kind: "write", args: { chat: "me", phone: "+15551234567", firstName: "harness" } },
  telegram_send_location: { kind: "write", args: { chat: "me", lat: -6.2, long: 106.8 } },

  // Membership changes on a real chat. `kick_member`/`promote_admin` on a user
  // target must refuse before touching anything, which is what these pin.
  telegram_invite_members: {
    kind: "manual",
    args: { chat: ADMIN_TEST_CHAT ?? "me", users: ["me"] },
    reason:
      "adding members changes real membership — the already-member path is proven " +
      "by hand and pinned below; the add path needs a second account",
  },
  // Inviting an existing member used to answer `invited: 1`, because
  // InviteToChannel counts the member it did not have to add. Against a chat this
  // account created, inviting yourself must now report `alreadyMembers`.
  telegram_invite_members__already_member: {
    kind: ADMIN_TEST_CHAT ? "read" : "manual",
    tool: "telegram_invite_members",
    args: { chat: ADMIN_TEST_CHAT ?? "me", users: ["me"] },
    // The id is deliberately not hardcoded: this file ships publicly, and the
    // account's own id has no business in it. Any numeric id proves the point.
    expect: /"alreadyMembers":\s*\[\s*"\d{5,}"/,
    ...(ADMIN_TEST_CHAT
      ? {}
      : { reason: "needs TELEGRAM_HARNESS_CHAT — a chat this account created" }),
  },
  telegram_promote_admin: {
    kind: "manual",
    args: { chat: ADMIN_TEST_CHAT ?? "me", user: "me", preset: "moderator" },
    reason:
      "promoting/demoting a real member changes real permissions — the creator " +
      "cases are proven by the chat-lifecycle scenario and pinned below",
  },
  telegram_kick_member: {
    kind: "manual",
    args: { chat: ADMIN_TEST_CHAT ?? "me", user: "me" },
    reason:
      "removing a real member is destructive — the creator refusal is proven by " +
      "the chat-lifecycle scenario and pinned below",
  },
  telegram_kick_member__refuses_user_chat: {
    kind: "expect-error",
    tool: "telegram_kick_member",
    args: { chat: "me", user: "BotFather", unban: true },
    expect: /is a user, not a group or channel/i,
  },
  // A creator cannot be demoted or removed. Telegram accepts EditAdmin/EditBanned
  // and changes nothing (or answers a bare PARTICIPANT_ID_INVALID), so the tool
  // reads the member's real role back and refuses with a plain explanation. Both
  // paths are pinned here against a chat this account created.
  telegram_promote_admin__refuses_creator_demotion: {
    kind: ADMIN_TEST_CHAT ? "expect-error" : "manual",
    tool: "telegram_promote_admin",
    args: { chat: ADMIN_TEST_CHAT ?? "me", user: "me", preset: "none" },
    expect: /created the chat|cannot be promoted or demoted/i,
    ...(ADMIN_TEST_CHAT
      ? {}
      : { reason: "needs TELEGRAM_HARNESS_CHAT — a chat this account created" }),
  },
  telegram_kick_member__refuses_creator: {
    kind: ADMIN_TEST_CHAT ? "expect-error" : "manual",
    tool: "telegram_kick_member",
    args: { chat: ADMIN_TEST_CHAT ?? "me", user: "me" },
    expect: /created the chat|cannot be removed/i,
    ...(ADMIN_TEST_CHAT
      ? {}
      : { reason: "needs TELEGRAM_HARNESS_CHAT — a chat this account created" }),
  },
  telegram_promote_admin__refuses_user_chat: {
    kind: "expect-error",
    tool: "telegram_promote_admin",
    args: { chat: "me", user: "BotFather", preset: "none" },
    expect: /is a user, not a group or channel/i,
  },
  telegram_set_chat_photo: {
    kind: "manual",
    args: { chat: "me", remove: true },
    reason: "changes a real chat photo — the set/restore round trip is a manual step",
  },

  // ---- third catalogue pass: extras added by a later session ---------------
  // Message ids rot, so this one takes a real id from a live read. The scenario
  // below does the same thing against the newest text message it can find.
  telegram_translate__from_chat: {
    kind: "read",
    tool: "telegram_translate",
    args: async (client) => ({
      chat: TEST_CHAT,
      messageId: await pickChannelMessage(client, TEST_CHAT, (m) => !m.media),
      targetLang: "en",
    }),
    expect: /"targetLang"|translated/,
  },
  telegram_translate__needs_target: {
    kind: "expect-error",
    tool: "telegram_translate",
    args: {},
    expect: /pass text|chat \+ messageId/i,
  },

  // Message 1 of this channel exists and carries no attachment. The tool used to
  // write a 0-byte file and report `downloaded: true` for exactly this input;
  // a success here would mean the check regressed.
  telegram_download_media__no_media: {
    kind: "expect-error",
    tool: "telegram_download_media",
    args: async (client) => ({
      chat: TEST_CHAT,
      messageId: await pickChannelMessage(client, TEST_CHAT, (m) => !m.media),
    }),
    expect: /has no attachment/i,
  },

  // ---- third pass: read-only extras ---------------------------------------
  // Every one of these is a read, so they run on every invocation.
  telegram_chat_admins: {
    kind: "manual",
    args: { chat: "me", limit: 10 },
    reason: "a public channel hides its admin list — covered by the admin scenario (TELEGRAM_HARNESS_CHAT)",
  },
  telegram_chat_admins__refuses_user_chat: {
    kind: "expect-error",
    tool: "telegram_chat_admins",
    args: { chat: "me" },
    expect: /is a user, not a group or channel/i,
  },
  telegram_scheduled_messages: { kind: "read", args: { chat: "me", limit: 5 }, expect: /"count"|messages/ },
  telegram_folders: { kind: "read", args: {}, expect: /folders|"count"/ },
  telegram_translate: {
    kind: "read",
    args: { text: "selamat pagi dunia", targetLang: "en" },
    expect: /"translated":\s*"[^"]+"/,
  },
  // An empty translation used to be reported as success with `translated: null`;
  // the handler now fails instead, and this pins that it does.
  telegram_translate__needs_input: {
    kind: "expect-error",
    tool: "telegram_translate",
    args: {},
    expect: /pass text=|chat \+ messageId/i,
  },
};

/* --------------------------------------------------------------- scenarios */

/**
 * Resolve a real message id from a live chat through the MCP server itself.
 * Hardcoding an id makes the test rot the moment that message is deleted; asking
 * the server keeps the scenario honest across runs.
 */
async function pickChannelMessage(client, chat = TEST_CHAT, predicate = () => true) {
  const res = await client.callTool("telegram_get_history", { chat, limit: 20 });
  if (!res.ok) return 1;
  try {
    const parsed = JSON.parse(res.text);
    const id = parsed.messages?.find((m) => m?.id && predicate(m))?.id;
    return id ?? 1;
  } catch {
    return 1;
  }
}

/**
 * A scenario exercises tools the way a caller actually uses them: the output of
 * one call feeds the next. Single-call write tests with `messageId: 0` only ever
 * prove that the error path works — they never touch the success path, so a
 * broken edit/pin/delete would pass forever.
 *
 * Every scenario below runs against "me" (Saved Messages) and deletes what it
 * created, so a full run leaves the account exactly as it found it.
 */
const SCENARIOS = [
  {
    name: "pagination",
    // Read-only, so it runs on every pass. Paging is a property of two calls:
    // a single-call case can only see the first page, and every way paging has
    // broken here looked fine on page one. `telegram_search_global` used to pass
    // `offsetPeer: <bare id>` while hardcoding `offsetRate: 0`, the peer failed
    // to resolve, the failure was swallowed, and the search restarted from the
    // top — returning page one again as if it had gone deeper.
    readOnly: true,
    covers: ["telegram_search_global", "telegram_get_history"],
    async run(client) {
      const steps = [];
      const notes = [];
      // A scenario that throws loses every step it had already collected: the
      // runner's catch builds `steps: []`, so the report shows one opaque FAIL
      // and the evidence that led there is gone. Returning the failure instead
      // keeps each call visible next to the reason.
      const bad = (reason) => ({ steps, ok: false, reason });

      // --- search_global: the cursor must actually advance ----------------
      const s1 = await client.callTool("telegram_search_global", { query: "telegram", limit: 4 });
      steps.push({ tool: "telegram_search_global", res: s1 });
      if (!s1.ok) return bad(`search_global failed: ${s1.text.slice(0, 200)}`);
      const page1 = JSON.parse(s1.text);
      const keyOf = (r) => `${r.chat?.id ?? r.chat}:${r.id}`;
      const k1 = (page1.results ?? []).map(keyOf);

      if (page1.nextOffsetRate == null) {
        // Honest skip: a query with a single page cannot prove paging.
        notes.push("search_global returned one page only, so no cursor to follow");
      } else if (!k1.length) {
        notes.push("search_global returned no rows to page");
      } else {
        const s2 = await client.callTool("telegram_search_global", {
          query: "telegram",
          limit: 4,
          offsetRate: page1.nextOffsetRate,
          offsetId: page1.nextOffsetId,
        });
        steps.push({ tool: "telegram_search_global", res: s2 });
        if (!s2.ok) return bad(`search_global page 2 failed: ${s2.text.slice(0, 200)}`);
        const page2 = JSON.parse(s2.text);
        const k2 = (page2.results ?? []).map(keyOf);
        const repeated = k2.filter((k) => k1.includes(k));
        if (repeated.length) {
          return bad(`search_global page 2 repeated page 1 rows (${repeated.join(", ")}) — the cursor did not advance`);
        }
        if (!k2.length && page2.hasMore) {
          return bad("search_global said hasMore but page 2 came back empty");
        }
        notes.push(`search_global advanced from ${k1.length} to ${k2.length} rows with no overlap`);
      }

      // --- get_history: offsetId must move strictly backwards -------------
      const chat = TEST_CHAT;
      const h1 = await client.callTool("telegram_get_history", { chat, limit: 3 });
      steps.push({ tool: "telegram_get_history", res: h1 });
      if (!h1.ok) return bad(`get_history failed: ${h1.text.slice(0, 200)}`);
      const hist1 = JSON.parse(h1.text);
      const ids1 = (hist1.messages ?? []).map((m) => Number(m.id));
      if (ids1.length >= 2) {
        const oldest = ids1[ids1.length - 1];
        const h2 = await client.callTool("telegram_get_history", { chat, limit: 3, offsetId: oldest });
        steps.push({ tool: "telegram_get_history", res: h2 });
        if (!h2.ok) return bad(`get_history page 2 failed: ${h2.text.slice(0, 200)}`);
        const ids2 = (JSON.parse(h2.text).messages ?? []).map((m) => Number(m.id));
        const forward = ids2.filter((id) => id >= oldest);
        if (forward.length) {
          return bad(`get_history offsetId=${oldest} returned ids that are not older: ${forward.join(", ")}`);
        }
        notes.push(`get_history paged strictly older than ${oldest}`);
      } else {
        notes.push("get_history returned fewer than two messages, so paging was not exercised");
      }

      return { steps, ok: true, ...(notes.length ? { note: notes.join("; ") } : {}) };
    },
  },
  {
    name: "argument contract",
    // Two bugs lived here, and both produced a *successful* answer about the
    // wrong thing, which no output-shape assertion can catch:
    //   1. an undeclared argument was stripped by the SDK's z.object() wrapper,
    //      so a caller that asked about another user got its own profile back;
    //   2. `telegram_full_user` advertised no arguments and hardcoded "me".
    // The contract is now explicit: a stray key is an error, and a declared key
    // changes the subject.
    covers: ["telegram_full_user", "telegram_status"],
    async run(client) {
      const steps = [];
      const bad = (reason) => ({ steps, ok: false, reason });

      const self = await client.callTool("telegram_full_user", { user: "me" });
      steps.push({ tool: "telegram_full_user", res: self });
      if (!self.ok) return bad(`full_user(user:"me") failed: ${self.text.slice(0, 200)}`);
      const selfBody = JSON.parse(self.text);
      if (selfBody.user?.isSelf !== true) {
        return bad(`full_user(user:"me") did not label the answer as self: ${self.text.slice(0, 200)}`);
      }

      // An undeclared argument must be refused, not ignored. If it is ignored the
      // call succeeds and the caller never learns its request did nothing.
      const stray = await client.callTool("telegram_status", { bogusArgument: 1 });
      steps.push({
        tool: "telegram_status",
        res: stray,
        expectError: /unrecognized|unknown|invalid/i,
      });
      if (stray.ok) {
        return bad("telegram_status accepted an undeclared argument instead of refusing it");
      }
      if (!/unrecognized|unknown|invalid/i.test(stray.text)) {
        return bad(`stray-argument refusal did not name the problem: ${stray.text.slice(0, 200)}`);
      }

      return { steps, ok: true };
    },
  },
  {
    name: "message write lifecycle",
    covers: ["telegram_send_message", "telegram_edit_message", "telegram_get_message", "telegram_delete_messages", "telegram_react"],
    async run(client) {
      const steps = [];
      const sent = await client.callTool("telegram_send_message", { chat: "me", text: "[harness] lifecycle" });
      steps.push({ tool: "telegram_send_message", res: sent });
      const id = sent.ok ? JSON.parse(sent.text).messageId : null;
      if (!id) return { steps, ok: false, reason: "send_message did not return a messageId" };
      journalAdd("me", id, "telegram_send_message");

      const edited = await client.callTool("telegram_edit_message", { chat: "me", messageId: id, text: "[harness] lifecycle edited" });
      steps.push({ tool: "telegram_edit_message", res: edited });

      const got = await client.callTool("telegram_get_message", { chat: "me", messageId: id });
      steps.push({ tool: "telegram_get_message", res: got });

      // The edit must be observable: this is what proves editMessage wrote.
      const editLanded = got.ok && got.text.includes("lifecycle edited");

      const del = await client.callTool("telegram_delete_messages", { chat: "me", messageIds: [id] });
      steps.push({ tool: "telegram_delete_messages", res: del });
      if (del.ok) journalRemove("me", [id]);

      // Reactions need Telegram Premium. On a non-Premium account the tool is
      // still correct — it surfaces a clean PREMIUM_ACCOUNT_REQUIRED code — so
      // the step is recorded as account-limited rather than a failure. Silently
      // passing it would hide a real regression, so the limitation is reported.
      // Reactions need Telegram Premium for Saved Messages specifically; on a
      // channel they work on a normal account. Use a real channel message so the
      // success path is exercised, and report a Premium block as a limitation.
      const react = await client.callTool("telegram_react", {
        chat: TEST_CHAT,
        messageId: await pickChannelMessage(client),
        emoji: "👍",
      });
      steps.push({
        tool: "telegram_react",
        res: react,
        tolerate: /PREMIUM_ACCOUNT_REQUIRED/,
        limitation: "account is not Premium",
      });

      // Cleanup must be confirmed: a message left behind is debris in the user's
      // real account, so a failed delete is a failure, not a warning.
      const gone = await client.callTool("telegram_get_message", { chat: "me", messageId: id });
      const deleted = gone.ok && /"found":\s*false/.test(gone.text);

      return {
        steps,
        ok: edited.ok && editLanded && del.ok && deleted,
        reason: !edited.ok
          ? "edit_message failed"
          : !editLanded
            ? "edit was not observable in get_message"
            : !del.ok
              ? "delete_messages failed"
              : !deleted
                ? "message still exists after delete"
                : null,
      };
    },
  },
  {
    name: "forward and pin",
    covers: ["telegram_send_message", "telegram_forward_messages", "telegram_pin_message", "telegram_delete_messages"],
    async run(client) {
      const steps = [];
      const src = await client.callTool("telegram_send_message", { chat: "me", text: "[harness] forward-src" });
      steps.push({ tool: "telegram_send_message", res: src });
      const srcId = src.ok ? JSON.parse(src.text).messageId : null;
      if (!srcId) return { steps, ok: false, reason: "send_message did not return a messageId" };

      const fwd = await client.callTool("telegram_forward_messages", { fromChat: "me", toChat: "me", messageIds: [srcId] });
      steps.push({ tool: "telegram_forward_messages", res: fwd });

      // Without the new message id there is nothing to delete, and the old check
      // only ever looked at the source: a forwarded copy could be left behind
      // while the scenario still reported a clean round trip. An unreadable id is
      // now a failure, not a shrug.
      let fwdId = null;
      if (fwd.ok) {
        try {
          fwdId = JSON.parse(fwd.text).messageIds?.[0] ?? null;
        } catch {
          fwdId = null;
        }
      }

      const pin = await client.callTool("telegram_pin_message", { chat: "me", messageId: srcId, notify: false });
      steps.push({ tool: "telegram_pin_message", res: pin });

      // Unpin before deleting so the pin state is not left behind.
      await client.callTool("telegram_pin_message", { chat: "me", messageId: srcId, notify: false, unpin: true }).catch(() => null);

      const ids = [srcId, ...(fwdId ? [fwdId] : [])];
      for (const id of ids) journalAdd("me", id, "telegram_forward_messages");
      const del = await client.callTool("telegram_delete_messages", { chat: "me", messageIds: ids });
      steps.push({ tool: "telegram_delete_messages", res: del });
      if (del.ok) journalRemove("me", ids);

      // Both created messages must actually be gone: leaving either behind is how
      // earlier runs accumulated "[harness] forward-src" in Saved Messages, and
      // the forwarded copy is the one that used to slip through unnoticed.
      const check = await client.callTool("telegram_get_message", { chat: "me", messageId: srcId });
      const srcGone = check.ok && /"found":\s*false/.test(check.text);
      let copyGone = true;
      if (fwdId) {
        const copyCheck = await client.callTool("telegram_get_message", { chat: "me", messageId: fwdId });
        copyGone = copyCheck.ok && /"found":\s*false/.test(copyCheck.text);
      }

      return {
        steps,
        ok: fwd.ok && fwdId !== null && pin.ok && del.ok && srcGone && copyGone,
        reason: !fwd.ok
          ? "forward failed"
          : fwdId === null
            ? "forward did not report the new message id, so the copy could not be cleaned up"
            : !pin.ok
              ? "pin failed"
              : !del.ok
                ? "cleanup delete failed"
                : !srcGone
                  ? "source message still exists after delete"
                  : !copyGone
                    ? "the forwarded copy still exists after delete"
                    : null,
      };
    },
  },
  {
    name: "chat lifecycle",
    // Creates two real chats and deletes them again. A crash between the two
    // halves would leave a chat behind, so it is opt-in like every other
    // permanent side effect.
    destructive: true,
    covers: [
      "telegram_create_channel",
      "telegram_create_group",
      "telegram_delete_chat",
      // Admin-only tools: only a chat this account owns can prove them, so they
      // are exercised here rather than with a fake id.
      "telegram_edit_chat",
      "telegram_export_invite_link",
      "telegram_clear_history",
      "telegram_promote_admin",
      "telegram_kick_member",
      "telegram_chat_admins",
      // Chat-state writes that need a chat this account may freely change. Each
      // is read back or reversed inside the scenario.
      "telegram_pin_chat",
      "telegram_mute_chat",
      "telegram_archive_chat",
      "telegram_mark_read",
      "telegram_chat_members",
      "telegram_search_messages",
      // Message lifecycle inside the disposable chat: send, read back, link,
      // pin, list pins, unpin, export, edit, translate, react, delete.
      "telegram_send_message",
      "telegram_get_message",
      "telegram_message_link",
      "telegram_pin_message",
      "telegram_pinned_messages",
      "telegram_unpin_all",
      "telegram_export_history",
      "telegram_edit_message",
      "telegram_translate",
      "telegram_react",
      "telegram_delete_messages",
    ],
    async run(client) {
      const steps = [];
      const creations = [
        ["telegram_create_channel", { title: "[harness] lifecycle tmp", about: "temporary" }],
        ["telegram_create_group", { title: "[harness] lifecycle tmp", users: ["me"] }],
      ];
      for (const [tool, args] of creations) {
        const created = await client.callTool(tool, args);
        steps.push({ tool, res: created });
        const id = created.ok ? JSON.parse(created.text).id : null;
        if (!id) return { steps, ok: false, reason: `${tool} did not return an id` };

        // Prove the admin tools on the chat that was just created, while it is
        // disposable. Each one is read back or reversed, never left dangling.
        const renamed = await client.callTool("telegram_edit_chat", {
          chat: id,
          title: "[harness] lifecycle renamed",
          about: "renamed by the harness",
        });
        steps.push({ tool: "telegram_edit_chat", res: renamed });
        if (!renamed.ok) return { steps, ok: false, reason: `edit_chat failed on ${id}` };

        // A title change that the API accepted but did not apply would be a silent
        // failure, so read it back.
        const info = await client.callTool("telegram_chat_info", { chat: id });
        steps.push({ tool: "telegram_chat_info", res: info });
        let titleNow = null;
        try {
          titleNow = JSON.parse(info.text).title ?? null;
        } catch {
          titleNow = null;
        }
        if (titleNow !== "[harness] lifecycle renamed") {
          return { steps, ok: false, reason: `edit_chat reported success but the title is ${JSON.stringify(titleNow)}` };
        }

        // Mint an invite, then rotate it: the second call revokes the first link and
        // returns a new one, so the chat stays joinable and nothing is left behind.
        const invite = await client.callTool("telegram_export_invite_link", { chat: id });
        steps.push({ tool: "telegram_export_invite_link", res: invite });
        if (!invite.ok) return { steps, ok: false, reason: `export_invite_link failed on ${id}` };
        const rotated = await client.callTool("telegram_export_invite_link", { chat: id, revoke: true });
        steps.push({ tool: "telegram_export_invite_link", res: rotated });
        if (!rotated.ok) return { steps, ok: false, reason: `revoking the invite failed on ${id}` };

        // Clear the history of a chat that is about to be deleted anyway: this is
        // the only honest place to prove a destructive tool with no undo.
        const cleared = await client.callTool("telegram_clear_history", { chat: id });
        steps.push({ tool: "telegram_clear_history", res: cleared });
        if (!cleared.ok) return { steps, ok: false, reason: `clear_history failed on ${id}` };

        // Admin tools, exercised on a chat this account owns and is about to
        // delete. Promoting yourself is a no-op Telegram accepts silently (a
        // creator is already everything), so the interesting assertion is the
        // read-back: the tool must report `verified` and the role it actually sees.
        const promoted = await client.callTool("telegram_promote_admin", {
          chat: id,
          user: "me",
          preset: "moderator",
        });
        steps.push({ tool: "telegram_promote_admin", res: promoted });
        if (!promoted.ok) return { steps, ok: false, reason: `promote_admin failed on ${id}` };
        let promotedBody = null;
        try {
          promotedBody = JSON.parse(promoted.text);
        } catch {
          promotedBody = null;
        }
        // The chat is ours, so we are its creator; the role must say so rather than
        // echoing whatever preset was requested.
        if (promotedBody && promotedBody.role && promotedBody.role !== "creator") {
          return { steps, ok: false, reason: `promote_admin reported role ${promotedBody.role}, expected creator` };
        }

        // Demoting a creator cannot work. The tool must refuse with a plain reason
        // instead of claiming success — this is the bug that made it lie.
        const demote = await client.callTool("telegram_promote_admin", { chat: id, user: "me", preset: "none" });
        steps.push({ tool: "telegram_promote_admin", res: demote, tolerate: /created the chat/i });
        if (demote.ok) return { steps, ok: false, reason: `demoting the creator of ${id} was reported as success` };

        // Kicking the owner must also refuse, before touching anything.
        const kick = await client.callTool("telegram_kick_member", { chat: id, user: "me" });
        steps.push({ tool: "telegram_kick_member", res: kick, tolerate: /created the chat/i });
        if (kick.ok) return { steps, ok: false, reason: `kicking the creator of ${id} was reported as success` };

        // The admin list must agree with all of the above.
        const admins = await client.callTool("telegram_chat_admins", { chat: id, limit: 10 });
        steps.push({ tool: "telegram_chat_admins", res: admins });
        if (!admins.ok) return { steps, ok: false, reason: `chat_admins failed on ${id}` };

        // Chat-state tools that need a chat this account can freely change. Each
        // one is read back or reversed, so the chat ends where it started and the
        // delete below is still a clean delete. They live here rather than in the
        // catalog because a real owned chat is the only honest place to prove
        // them — a fake id proves nothing.
        const stateChecks = [
          // Pin the dialog, then unpin: ToggleDialogPin is a toggle, so the pair
          // is only safe if the tool reports the account rather than the request.
          ["telegram_pin_chat", { chat: id, pinned: true }, /"pinned":\s*true/],
          ["telegram_pin_chat", { chat: id, pinned: false }, /"pinned":\s*false/],
          // Mute for a day, then unmute. A channel this account owns can be muted.
          ["telegram_mute_chat", { chat: id, days: 1 }, /"muted":\s*true/],
          ["telegram_mute_chat", { chat: id, days: 0 }, /"muted":\s*false/],
          // Archive into folder 1 and back to 0.
          ["telegram_archive_chat", { chat: id, archived: true }, /"archived":\s*true/],
          ["telegram_archive_chat", { chat: id, archived: false }, /"archived":\s*false/],
        ];
        for (const [tool, args, expect] of stateChecks) {
          const res = await client.callTool(tool, args);
          steps.push({ tool, res });
          if (!res.ok) return { steps, ok: false, reason: `${tool} failed on ${id}` };
          if (!expect.test(res.text)) {
            return { steps, ok: false, reason: `${tool} answered without the expected state: ${res.text.slice(0, 160)}` };
          }
          // `verified:false` is not a failure of the tool (the read-back may be
          // unavailable), but a run that claims to prove the write should know.
          if (/"verified":\s*false/.test(res.text)) {
            return { steps, ok: false, reason: `${tool} could not read its own change back on ${id}` };
          }
        }

        // Marking a chat read is only meaningful if it is first unread. The
        // created chat has no messages, so this is a no-op that still exercises
        // the read-back path.
        const marked = await client.callTool("telegram_mark_read", { chat: id });
        steps.push({ tool: "telegram_mark_read", res: marked });
        if (!marked.ok) return { steps, ok: false, reason: `mark_read failed on ${id}` };

        // Members and message search on a real chat, so the tools see a real
        // participant list rather than an error path.
        const members = await client.callTool("telegram_chat_members", { chat: id, limit: 10 });
        steps.push({ tool: "telegram_chat_members", res: members });
        if (!members.ok) return { steps, ok: false, reason: `chat_members failed on ${id}` };

        const search = await client.callTool("telegram_search_messages", { chat: id, query: "harness", limit: 5 });
        steps.push({ tool: "telegram_search_messages", res: search });
        if (!search.ok) return { steps, ok: false, reason: `search_messages failed on ${id}` };

        // Send a message into the disposable chat, then prove the read path and
        // the message-link builder against a real message id. Both are deleted
        // with the chat, so nothing is left behind.
        const sent = await client.callTool("telegram_send_message", { chat: id, text: "[harness] lifecycle message" });
        steps.push({ tool: "telegram_send_message", res: sent });
        let sentId = null;
        if (sent.ok) {
          try {
            sentId = JSON.parse(sent.text).messageId ?? null;
          } catch {
            sentId = null;
          }
        }
        if (sent.ok && !sentId) {
          return { steps, ok: false, reason: `send_message into ${id} returned no messageId` };
        }
        if (sentId) {
          const readBack = await client.callTool("telegram_get_message", { chat: id, messageId: sentId });
          steps.push({ tool: "telegram_get_message", res: readBack });
          if (!readBack.ok || !/"found":\s*true/.test(readBack.text)) {
            return { steps, ok: false, reason: `the message sent into ${id} could not be read back` };
          }
          // The sender field is the one that used to come out as
          // "[object Object]" for channel posts. In a channel this account owns,
          // the message is a channel post — exactly the broken case.
          if (/"senderId":\s*"\[object Object\]"/.test(readBack.text)) {
            return { steps, ok: false, reason: `get_message still stringifies the sender object in ${id}` };
          }

          const link = await client.callTool("telegram_message_link", { chat: id, messageId: sentId });
          steps.push({ tool: "telegram_message_link", res: link });
          if (!link.ok) return { steps, ok: false, reason: `message_link failed on ${id}` };

          const pinnedMsg = await client.callTool("telegram_pin_message", { chat: id, messageId: sentId });
          steps.push({ tool: "telegram_pin_message", res: pinnedMsg });
          if (!pinnedMsg.ok) return { steps, ok: false, reason: `pin_message failed on ${id}` };

          const pins = await client.callTool("telegram_pinned_messages", { chat: id, limit: 5 });
          steps.push({ tool: "telegram_pinned_messages", res: pins });
          if (!pins.ok) return { steps, ok: false, reason: `pinned_messages failed on ${id}` };
          // The pinned list must contain the message that was just pinned —
          // otherwise pin_message reported success for nothing.
          if (!new RegExp(`"id":\\s*${sentId}\\b`).test(pins.text)) {
            return { steps, ok: false, reason: `pinned_messages does not list ${sentId} after pinning it in ${id}` };
          }

          const unpin = await client.callTool("telegram_unpin_all", { chat: id });
          steps.push({ tool: "telegram_unpin_all", res: unpin });
          if (!unpin.ok) return { steps, ok: false, reason: `unpin_all failed on ${id}` };

          const exported = await client.callTool("telegram_export_history", { chat: id, limit: 10, format: "jsonl" });
          steps.push({ tool: "telegram_export_history", res: exported, artifact: "path" });
          if (!exported.ok) return { steps, ok: false, reason: `export_history failed on ${id}` };

          // Edit the message, then read it back: the same "accepted but ignored"
          // trap applies to messages.EditMessage.
          const edited = await client.callTool("telegram_edit_message", {
            chat: id,
            messageId: sentId,
            text: "[harness] lifecycle edited",
          });
          steps.push({ tool: "telegram_edit_message", res: edited });
          if (!edited.ok) return { steps, ok: false, reason: `edit_message failed on ${id}` };
          const afterEdit = await client.callTool("telegram_get_message", { chat: id, messageId: sentId });
          steps.push({ tool: "telegram_get_message", res: afterEdit });
          if (!/lifecycle edited/.test(afterEdit.text)) {
            return { steps, ok: false, reason: `edit_message reported success but the text did not change in ${id}` };
          }

          // Translate reads a real message and needs no send. It answers either a
          // translation or a clean "not available"; both are fine, an error is not.
          const translated = await client.callTool("telegram_translate", {
            chat: id,
            messageId: sentId,
            targetLang: "en",
          });
          steps.push({ tool: "telegram_translate", res: translated });
          if (!translated.ok) return { steps, ok: false, reason: `translate failed on ${id}` };

          // A reaction needs a real message. This account is not Premium, so a
          // refusal is the honest answer for Saved Messages — but a channel this
          // account owns accepts it, which is why this check lives here.
          const reacted = await client.callTool("telegram_react", {
            chat: id,
            messageId: sentId,
            emoji: "\u{1F44D}",
          });
          steps.push({ tool: "telegram_react", res: reacted, tolerate: /premium/i });
          if (!reacted.ok && !/premium/i.test(reacted.text)) {
            return { steps, ok: false, reason: `react failed on a real channel message in ${id}` };
          }

          const delMsg = await client.callTool("telegram_delete_messages", { chat: id, messageIds: [sentId] });
          steps.push({ tool: "telegram_delete_messages", res: delMsg });
          if (!delMsg.ok) return { steps, ok: false, reason: `delete_messages failed on ${id}` };
        }

        // Delete what was just created. Creating chats in a real account without
        // cleaning up is how 15 empty "[harness]" channels accumulated.
        const del = await client.callTool("telegram_delete_chat", { chat: id });
        steps.push({ tool: "telegram_delete_chat", res: del });
        if (!del.ok) {
          return {
            steps,
            ok: false,
            reason:
              `delete_chat failed after ${tool}, so ${id} was left behind — ` +
              `run --cleanup once any flood wait expires`,
          };
        }
      }
      const failed = steps.filter((s) => !s.res.ok);
      return { steps, ok: failed.length === 0, reason: failed.length ? `${failed[0].tool} failed` : null };
    },
  },
  {
    name: "attachment round trip",
    covers: ["telegram_send_file", "telegram_send_photo"],
    async run(client) {
      const steps = [];
      // /etc/hostname is a tiny real file present on any Linux box; the point is
      // to exercise the upload path, not the content.
      for (const tool of ["telegram_send_file", "telegram_send_photo"]) {
        const sent = await client.callTool(tool, { chat: "me", filePath: "/etc/hostname" });
        steps.push({ tool, res: sent });
        let id = null;
        if (sent.ok) {
          try {
            id = JSON.parse(sent.text).messageId;
          } catch {
            id = null;
          }
        }
        // A successful send with no readable id is a leak, not a pass: the old
        // shape skipped the delete silently and still reported the round trip
        // clean, which is exactly how messages accumulate.
        if (sent.ok && !id) {
          return { steps, ok: false, reason: `${tool} sent a file but reported no messageId to clean up` };
        }
        if (id) {
          // Record before deleting: a throttled delete must still leave a trail
          // that --reclaim can follow exactly.
          journalAdd("me", id, tool);
          // Delete immediately: an attachment left in "me" is debris in a real
          // account, and the old single-call tests left 16 messages behind.
          const del = await client.callTool("telegram_delete_messages", { chat: "me", messageIds: [id] });
          steps.push({ tool: "telegram_delete_messages", res: del });
          if (del.ok) journalRemove("me", [id]);
          const check = await client.callTool("telegram_get_message", { chat: "me", messageId: id });
          const gone = check.ok && /"found":\s*false/.test(check.text);
          steps.push({ tool: "telegram_get_message", res: check });
          if (!gone) return { steps, ok: false, reason: `the attachment from ${tool} still exists after delete` };
        }
      }
      const failed = steps.filter((s) => !s.res.ok);
      return { steps, ok: failed.length === 0, reason: failed.length ? `${failed[0].tool} failed` : null };
    },
  },
  {
    name: "media senders round trip",
    // Polls, contact cards and locations are all `messages.SendMedia` under the
    // hood, and all three used to be `manual` — which meant nothing verified that
    // the media actually landed. Each is sent to Saved Messages, checked for a
    // readable messageId, then deleted; a send that reports success but yields no
    // id is a leak and fails here rather than being quietly skipped.
    covers: ["telegram_send_poll", "telegram_send_contact", "telegram_send_location"],
    async run(client) {
      const steps = [];
      // Everything this scenario creates is newer than this, so the final sweep
      // can tell its own debris from the account's real messages.
      const scenarioWatermark = await newestInSaved(client);
      const cases = [
        ["telegram_send_poll", { chat: "me", question: "[harness] poll", answers: ["one", "two"] }],
        ["telegram_send_contact", { chat: "me", phone: "+15551234567", firstName: "[harness]", lastName: "Card" }],
        ["telegram_send_location", { chat: "me", lat: -6.2, long: 106.8 }],
      ];
      for (const [tool, args] of cases) {
        // Watermark first. A send can create the message and *then* be throttled,
        // so the tool returns FLOOD for a message that now exists — the exact case
        // that left two attachments behind and made a "delete recent media" script
        // dangerous. Anything newer than this watermark during this scenario was
        // created by this scenario, so it can be reclaimed precisely.
        const before = await newestInSaved(client);
        const sent = await client.callTool(tool, args);
        steps.push({ tool, res: sent });
        let id = null;
        if (sent.ok) {
          try {
            id = JSON.parse(sent.text).messageId;
          } catch {
            id = null;
          }
        }
        if (!sent.ok) {
          // Recover whatever the failed call actually created.
          const orphans = await newerThan(client, before);
          if (orphans === null) {
            return {
              steps,
              ok: false,
              reason: `${tool} was throttled and the recovery read was throttled too — a message may exist`,
            };
          }
          for (const orphan of orphans) journalAdd("me", orphan, `${tool} (send reported failure)`);
          continue;
        }
        if (!id) {
          return { steps, ok: false, reason: `${tool} sent but reported no messageId to clean up` };
        }
        // Record before deleting: if the delete is throttled, --reclaim can still
        // find this exact message instead of guessing from "has media".
        journalAdd("me", id, tool);
        const del = await client.callTool("telegram_delete_messages", { chat: "me", messageIds: [id] });
        steps.push({ tool: "telegram_delete_messages", res: del });
        if (del.ok) journalRemove("me", [id]);
        const check = await client.callTool("telegram_get_message", { chat: "me", messageId: id });
        steps.push({ tool: "telegram_get_message", res: check });
        if (!(check.ok && /"found":\s*false/.test(check.text))) {
          return { steps, ok: false, reason: `the message from ${tool} still exists after delete` };
        }
      }
      const failed = steps.filter((s) => !s.res.ok);
      // Final sweep: whatever this scenario created and did not manage to delete
      // (a send that was throttled *after* the message existed, a delete that was
      // throttled) is reclaimed here by watermark, and only here — anything older
      // than the first watermark belongs to the account, not to this run.
      const leftover = await newerThan(client, scenarioWatermark);
      let swept = [];
      // A null answer means every read was throttled. That is not "clean" — it is
      // "unknown", and calling it clean is how debris survived earlier runs.
      if (leftover === null) {
        return { steps, ok: false, reason: "could not read Saved Messages to sweep leftovers (throttled)" };
      }
      if (leftover.length) {
        const del = await client.callTool("telegram_delete_messages", { chat: "me", messageIds: leftover });
        steps.push({ tool: "telegram_delete_messages", res: del, note: "sweep" });
        if (del.ok) {
          journalRemove("me", leftover);
          swept = leftover;
        }
      }
      return {
        steps,
        ok: failed.length === 0 && swept.length === leftover.length,
        reason: failed.length
          ? `${failed[0].tool} failed`
          : swept.length !== leftover.length
            ? `could not sweep ${leftover.length - swept.length} leftover message(s)`
            : null,
        swept,
      };
    },
  },
  {
    name: "profile field preservation",
    // Self-restoring: it writes a marker, checks the untouched field survived,
    // and always puts the original values back. It covers the bug where a
    // partial account.UpdateProfile silently erased a field the caller never
    // mentioned — sending `lastName: ""` alongside an explicit `firstName`.
    covers: ["telegram_update_profile"],
    async run(client) {
      const steps = [];
      const read = async () => {
        const r = await client.callTool("telegram_full_user", {});
        steps.push({ tool: "telegram_full_user", res: r });
        if (!r.ok) throw new Error(`telegram_full_user failed: ${r.text.slice(0, 200)}`);
        return JSON.parse(r.text);
      };
      const write = async (args) => {
        const r = await client.callTool("telegram_update_profile", args);
        steps.push({ tool: "telegram_update_profile", res: r });
        if (!r.ok) throw new Error(`telegram_update_profile failed: ${r.text.slice(0, 200)}`);
        return r;
      };

      const before = await read();
      const orig = {
        firstName: before.user.firstName ?? "",
        lastName: before.user.lastName ?? "",
      };

      // A previous run may have died between writing the marker and restoring it.
      // Treating that leftover as the "original" would faithfully restore the
      // pollution on every subsequent run — which is exactly how HARNESSTMP
      // ended up stuck to a real account. The marker is never a real last name,
      // so it is dropped and the run says so instead of preserving it.
      const healed = orig.lastName === "HARNESSTMP";
      if (healed) {
        orig.lastName = "";
        steps.push({
          tool: "telegram_update_profile",
          res: { ok: true, ms: 0, text: "cleared a leftover HARNESSTMP from a previous run" },
        });
      }

      try {
        // A marker is required: this account has no last name, so "" and null are
        // indistinguishable and a clobber would be invisible.
        await write({ firstName: orig.firstName, lastName: "HARNESSTMP" });
        await write({ firstName: orig.firstName });
        const mid = await read();
        if (mid.user.lastName !== "HARNESSTMP") {
          return {
            steps,
            ok: false,
            reason: `a firstName-only update erased lastName (now ${JSON.stringify(mid.user.lastName)})`,
          };
        }
        return {
          steps,
          ok: true,
          reason: null,
          note: healed ? "healed a leftover HARNESSTMP from a previous crash" : null,
        };
      } finally {
        // Restore no matter how the assertions above went; the finally body runs
        // before the return value is handed back, and `steps` is a reference.
        await write({ firstName: orig.firstName, lastName: orig.lastName });
      }
    },
  },
  {
    name: "chat edit + invite round trip",
    requiresEnv: "TELEGRAM_HARNESS_CHAT",
    // Renaming a channel and minting an invite link were both `manual`, so neither
    // had ever been executed by a test. Both are reversible: the title is set to a
    // marker and put back in a finally block, and the link export is the
    // non-revoking form, which only reads (it does not invalidate the old link).
    covers: [
      "telegram_edit_chat",
      "telegram_export_invite_link",
      "telegram_chat_members",
      "telegram_chat_admins",
    ],
    async run(client) {
      const steps = [];
      // Renaming and minting invite links need a chat this account actually
      // administers. There is no safe default, so the scenario is gated on
      // TELEGRAM_HARNESS_CHAT and reports a skip when it is unset.
      const CHAT = ADMIN_TEST_CHAT;

      const info = await client.callTool("telegram_chat_info", { chat: CHAT });
      steps.push({ tool: "telegram_chat_info", res: info });
      if (!info.ok) return { steps, ok: false, reason: "could not read the channel info" };
      const original = JSON.parse(info.text).title;

      // The member and admin lists need a chat whose participants this account
      // may enumerate; the same chat proves both in one place.
      const members = await client.callTool("telegram_chat_members", { chat: CHAT, limit: 3 });
      steps.push({ tool: "telegram_chat_members", res: members });
      if (!members.ok) return { steps, ok: false, reason: "listing members failed on an administered chat" };
      const admins = await client.callTool("telegram_chat_admins", { chat: CHAT, limit: 3 });
      steps.push({ tool: "telegram_chat_admins", res: admins });
      if (!admins.ok) return { steps, ok: false, reason: "listing admins failed on an administered chat" };

      // An invite export with no revoke must yield a t.me link and must not
      // invalidate anything: it is the read-only half of this tool.
      const invite = await client.callTool("telegram_export_invite_link", { chat: CHAT });
      steps.push({ tool: "telegram_export_invite_link", res: invite });
      if (!invite.ok) return { steps, ok: false, reason: "exporting the invite link failed" };
      const link = JSON.parse(invite.text).link;
      if (!/^https:\/\/t\.me\//.test(String(link))) {
        return { steps, ok: false, reason: `invite link is not a t.me URL: ${link}` };
      }

      try {
        const marker = `${original} [harness]`;
        const set = await client.callTool("telegram_edit_chat", { chat: CHAT, title: marker });
        steps.push({ tool: "telegram_edit_chat", res: set });
        if (!set.ok) {
          // A flood is not a defect: the call never happened. Report it as a
          // throttle so the run ends INCOMPLETE_RATE_LIMITED instead of pinning a
          // failure on working code. The finally block below still restores the
          // title, which is why a throttled run leaves nothing behind.
          if (isRateLimit(set)) return { steps, ok: false, reason: "throttled", throttled: true };
          return { steps, ok: false, reason: "renaming the channel failed" };
        }

        // Read back: the tool reports the title it read, but the real question is
        // whether Telegram stored it.
        const after = await client.callTool("telegram_chat_info", { chat: CHAT });
        steps.push({ tool: "telegram_chat_info", res: after });
        const now = after.ok ? JSON.parse(after.text).title : null;
        if (now !== marker) {
          return { steps, ok: false, reason: `title did not change (still ${JSON.stringify(now)})` };
        }
        return { steps, ok: true, reason: null };
      } finally {
        // Always put the real title back, even if the assertions above failed.
        await client.callTool("telegram_edit_chat", { chat: CHAT, title: original });
      }
    },
  },
  {
    name: "download round trip",
    // download_media changes nothing on Telegram's side — it reads a message and
    // writes one local file — so it is safe to exercise. The file AND its index
    // record are both removed again through the toolset, so the run ends with the
    // downloads index exactly as it began: no dead rows, no orphan files.
    covers: ["telegram_download_media", "telegram_list_downloads", "telegram_delete_download"],
    async run(client) {
      const steps = [];
      const history = await client.callTool("telegram_get_history", { chat: TEST_CHAT, limit: 30 });
      steps.push({ tool: "telegram_get_history", res: history });
      if (!history.ok) return { steps, ok: false, reason: "could not read the channel history" };

      let target;
      try {
        target = (JSON.parse(history.text).messages ?? []).find((m) => m.media);
      } catch (err) {
        return { steps, ok: false, reason: `history was not JSON: ${String(err.message ?? err)}` };
      }
      if (!target) return { steps, ok: false, reason: "no message with an attachment to download" };

      const dl = await client.callTool("telegram_download_media", {
        chat: TEST_CHAT,
        messageId: target.id,
      });
      steps.push({ tool: "telegram_download_media", res: dl });
      if (!dl.ok) return { steps, ok: false, reason: "download failed" };

      let payload;
      try {
        payload = JSON.parse(dl.text);
      } catch (err) {
        return { steps, ok: false, reason: `download returned non-JSON: ${String(err.message ?? err)}` };
      }

      const listing = await client.callTool("telegram_list_downloads", { limit: 5 });
      steps.push({ tool: "telegram_list_downloads", res: listing });

      // Downloading the same message a second time must update that one record, not
      // append another. The index used to grow by a row per run — 18 rows for one
      // message, every one of them pointing at a file an earlier run had removed.
      const again = await client.callTool("telegram_download_media", {
        chat: TEST_CHAT,
        messageId: target.id,
      });
      steps.push({ tool: "telegram_download_media", res: again });

      const relist = await client.callTool("telegram_list_downloads", { limit: 5 });
      steps.push({ tool: "telegram_list_downloads", res: relist });

      const rowsOf = (res) => {
        try {
          return JSON.parse(res.text).downloads ?? [];
        } catch {
          return null;
        }
      };
      const before = rowsOf(listing);
      const after = rowsOf(relist);
      const countFor = (rows) => (rows ?? []).filter((d) => d.messageId === target.id).length;
      const deduped = !!after && countFor(after) === countFor(before);

      let exists = false;
      try {
        exists = fs.statSync(payload.path).size > 0;
      } catch {
        exists = false;
      }

      // Remove the local file: leaving one per run accumulates junk in
      // ~/.telegram-mcp/media with no way to prune it from the toolset. Both paths
      // are removed so a dedupe regression leaves no orphan behind.
      let secondPath = "";
      try {
        secondPath = JSON.parse(again.text)?.path ?? "";
      } catch {
        secondPath = "";
      }
      let removed = false;
      try {
        fs.rmSync(payload.path, { force: true });
        if (secondPath && secondPath !== payload.path) fs.rmSync(secondPath, { force: true });
        removed = !fs.existsSync(payload.path) && (!secondPath || !fs.existsSync(secondPath));
      } catch {
        removed = false;
      }

      const indexed =
        listing.ok &&
        before !== null &&
        before.some((d) => d.messageId === target.id);

      // Remove the record through the tool under test, which also unlinks the file.
      // Then the index is back to its pre-run size: the only way a run can honestly
      // claim it left nothing behind.
      const record = (before ?? []).find((d) => d.messageId === target.id);
      let removedRecord = false;
      if (record) {
        const del = await client.callTool("telegram_delete_download", { id: record.id, deleteFile: true });
        steps.push({ tool: "telegram_delete_download", res: del });
        removedRecord = del.ok && JSON.parse(del.text || "{}").deleted === true;
      }

      const finalList = await client.callTool("telegram_list_downloads", { limit: 100 });
      steps.push({ tool: "telegram_list_downloads", res: finalList });
      const afterDelete = rowsOf(finalList) ?? [];
      const gone = record ? !afterDelete.some((d) => d.id === record.id) : false;

      return {
        steps,
        ok: exists && removedRecord && gone && indexed && deduped && again.ok,
        reason: !exists
          ? `file ${payload.path} was not written`
          : !indexed
            ? "the download is missing from telegram_list_downloads"
            : !deduped
              ? `re-downloading one message added index rows: ${countFor(before)} -> ${countFor(after)}`
              : !again.ok
                ? "the second download failed"
                : !removedRecord
                  ? "telegram_delete_download did not report deleted:true"
                  : !gone
                    ? "the record is still listed after telegram_delete_download"
                    : null,
      };
    },
  },
];

/**
 * Run a tool call, optionally backing off when Telegram rate-limits it.
 *
 * Retrying is OFF by default and must be opted into per case, because the server
 * deliberately does not retry writes: replaying a `send` after a wait can send
 * the same message twice, and the changelog documents that as the reason
 * `retryAfterSec` is handed back to the caller instead of slept on. Only cases
 * that are provably idempotent (joining a chat you are already in) ask for it.
 */
async function callToolPaced(client, toolName, args, retries = 0) {
  let res = await client.callTool(toolName, args);
  // Use the same predicate as the reporter. A looser inline `/FLOOD/i` here
  // would also match a chat *title* containing "flood" in an unrelated error,
  // and retry a case that was never rate-limited.
  for (let attempt = 1; attempt <= retries && isRateLimit(res); attempt++) {
    await new Promise((r) => setTimeout(r, 12000 * attempt));
    res = await client.callTool(toolName, args);
  }
  return res;
}

/** True when a tool result is a Telegram rate limit rather than a defect. */
function isRateLimit(res) {
  if (!res?.isError) return false;
  // The bare `FLOOD` form carries no wait time and is the one Telegram returns
  // for channel deletion; `^FLOOD\b` covers it on a line of its own.
  return /\[FLOOD_WAIT\]|FLOOD_WAIT|^FLOOD\b|SLOWMODE_WAIT/im.test(res.text);
}

/**
 * Verify that a tool which claims to have written a file really wrote one, then
 * delete it.
 *
 * Both halves matter. A tool can answer `exported: true, path: <somewhere>`
 * without touching the disk, and the only way to tell is to look. And the file
 * it does write is *this run's* debris: `telegram_export_history` ran as a plain
 * read case, so every pass left another file in the user's export directory —
 * 218 of them had accumulated in a directory nobody thinks to check. The unlink
 * is deliberately narrow: the path must resolve inside the export directory, so
 * a tool returning any other path can never make the harness delete it.
 */
function verifyArtifact(spec, res) {
  const bad = (reason) => ({ ok: false, reason });
  if (!res.ok) return bad("the call failed, so there is no artifact to check");
  let body;
  try {
    body = JSON.parse(res.text);
  } catch {
    return bad("output is not JSON, so the artifact path cannot be read");
  }
  const claimed = body?.[spec.artifact];
  if (typeof claimed !== "string" || !claimed) return bad(`no "${spec.artifact}" in the output`);

  const stateDir = process.env.TELEGRAM_STATE_DIR ?? path.join(os.homedir(), ".telegram-mcp");
  const exportRoot = path.resolve(process.env.TELEGRAM_EXPORT_DIR ?? path.join(stateDir, "exports"));
  const resolved = path.resolve(claimed);
  if (!resolved.startsWith(exportRoot + path.sep)) {
    return bad(`claimed artifact ${resolved} is outside the export directory ${exportRoot} — refusing to touch it`);
  }

  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    return bad(`it answered with ${resolved}, but that file does not exist`);
  }
  if (!st.isFile()) return bad(`${resolved} is not a file`);
  const remove = () => {
    try {
      fs.unlinkSync(resolved);
      return true;
    } catch {
      return false;
    }
  };
  if (st.size === 0) {
    remove();
    return bad(`${resolved} exists but is empty`);
  }
  const removed = remove();
  return {
    ok: true,
    note: `verified ${resolved} (${st.size} bytes)${removed ? " and removed it" : " — could not remove it"}`,
  };
}

/* ------------------------------------------------------------------ runner */
function duration(ns) {
  return `${Math.round(ns / 1e6)}ms`;
}

async function main() {
  const report = { startedAt: new Date().toISOString(), server: SERVER, tools: [], cases: [], summary: {} };

  const client = new McpClient(SERVER).start();

  // 1. Handshake — the single most important check: does the MCP server speak?
  let initOk = false;
  try {
    const init = await client.initialize();
    initOk = Boolean(init.result?.serverInfo);
    report.serverInfo = init.result?.serverInfo ?? null;
    report.protocolVersion = init.result?.protocolVersion ?? null;
  } catch (err) {
    report.initError = String(err.message ?? err);
  }

  if (!initOk) {
    report.summary = { verdict: "SERVER_DID_NOT_INITIALIZE", stderr: client.stderr.join("").slice(-4000) };
    client.stop();
    emit(report);
    process.exitCode = 1;
    return;
  }

  // 2. tools/list — compare what the server advertises against the catalog.
  //    Coverage is measured in TOOL names, not catalog keys: `foo__bad` and
  //    `foo` both cover the tool `foo`. Counting keys made the numbers match by
  //    accident and would have masked a genuinely untested tool.
  const tools = await client.listTools();
  report.tools = tools.map((t) => ({ name: t.name, title: t.title, hasInputSchema: Boolean(t.inputSchema) }));
  const advertised = new Set(tools.map((t) => t.name));
  const catalogued = new Set(Object.entries(CATALOG).map(([k, c]) => c.tool ?? k));

  report.coverage = {
    advertised: advertised.size,
    catalogued: catalogued.size,
    untested: [...advertised].filter((n) => !catalogued.has(n)),
    missing: [...catalogued].filter((n) => !advertised.has(n)),
  };

  // 3. Run scenarios first: they exercise the success path of tools that need a
  //    real message id, and they clean up after themselves. Their results also
  //    mark those tools as verified so the single-call cases below don't report
  //    a misleading pass on an error path only.
  const scenarioVerified = new Set();

  // Watermark for the cleanliness check at the end of the run. A scenario, a
  // single-call case, and — this is the one that bit — a case that *executed*
  // and was then reported as skipped all leave messages in Saved Messages. The
  // report could claim a clean skip while the account had a new "[harness] ping"
  // in it, so the harness now asks the account instead of trusting itself.
  let meWatermark = null;
  if (WITH_WRITES || WITH_DESTRUCTIVE) {
    const newest = await client.callTool("telegram_get_history", { chat: "me", limit: 1 });
    if (newest.ok) {
      try {
        const id = JSON.parse(newest.text).messages?.[0]?.id;
        if (typeof id === "number") meWatermark = id;
      } catch {
        meWatermark = null;
      }
    }
  }
  // `--destructive` alone must run the scenarios too: the chat-lifecycle one is
  // the only thing that deletes the chats the create cases make. Gating them on
  // --write meant a destructive run created chats and left them behind. Each
  // destructive scenario still checks WITH_DESTRUCTIVE for itself below.
  //
  // A `readOnly: true` scenario runs on every pass, including a plain read-only
  // run: it is the only place a multi-call property can be checked (paging has
  // to see two pages to know whether the second one repeated the first), and a
  // read-only check that only runs with --write is a check that mostly does not
  // run.
  for (const scenario of SCENARIOS) {
    const relevant = !ONLY || scenario.covers.some((t) => ONLY.includes(t));
    if (!relevant) continue;
    if (scenario.requiresEnv && !process.env[scenario.requiresEnv]) {
      for (const toolName of scenario.covers) {
        report.cases.push({
          key: `scenario:${scenario.name}:${toolName}`,
          tool: toolName,
          status: "SKIPPED",
          reason: `needs ${scenario.requiresEnv}`,
        });
      }
      report.cases.push({
        key: `scenario:${scenario.name}`,
        tool: "(scenario)",
        status: "SKIPPED",
        reason: `needs ${scenario.requiresEnv}`,
      });
      continue;
    }
    if (!scenario.readOnly && !WITH_WRITES && !WITH_DESTRUCTIVE) {
      for (const toolName of scenario.covers) {
        report.cases.push({
          key: `scenario:${scenario.name}:${toolName}`,
          tool: toolName,
          status: "SKIPPED",
          reason: "writes to the account (use --write)",
        });
      }
      report.cases.push({
        key: `scenario:${scenario.name}`,
        tool: "(scenario)",
        status: "SKIPPED",
        reason: "writes to the account (use --write)",
      });
      continue;
    }
    {
      // Scenarios that create real chats delete what they create, but a failure
      // in between leaves a permanent chat behind — and every create/delete is
      // flood-limited. They stay opt-in, exactly like destructive single calls.
      if (scenario.destructive && !WITH_DESTRUCTIVE) {
        report.cases.push({
          key: `scenario:${scenario.name}`,
          tool: "(scenario)",
          status: "SKIPPED",
          reason: "creates real chats (use --destructive)",
        });
        for (const toolName of scenario.covers) {
          report.cases.push({
            key: `scenario:${scenario.name}:${toolName}`,
            tool: toolName,
            status: "SKIPPED",
            reason: "creates real chats (use --destructive)",
          });
        }
        continue;
      }
      let result;
      try {
        result = await scenario.run(client);
      } catch (err) {
        result = { ok: false, reason: String(err.message ?? err), steps: [] };
      }
      for (const step of result.steps ?? []) {
        // `tolerate` marks an account limitation (no Premium, no permission)
        // rather than a code defect. It is reported distinctly so a real
        // regression is still visible, but a non-Premium account does not fail
        // the run.
        const tolerated = step.tolerate && !step.res.ok && step.tolerate.test(step.res.text);
        // A step that Telegram throttled is not a broken tool. The catalog cases
        // already report `RATE_LIMITED` (item 47); a scenario step has to do the
        // same, or one flood inside a round trip turns the whole scenario into a
        // code defect — and then its fallback case fires on top of that.
        const throttled = !step.res.ok && isRateLimit(step.res);
        // Some steps assert a *refusal*: the tool must reject the call, with a
        // message matching the regex. Without this the runner scores a correct
        // refusal as "step failed" and a wrong success as a pass — backwards.
        const expectedError = Boolean(step.expectError);
        const refused = expectedError && !step.res.ok && step.expectError.test(step.res.text);
        const refusedBadly = expectedError && !refused;
        const artifact = step.artifact ? verifyArtifact(step, step.res) : null;
        const artifactBad = Boolean(artifact && !artifact.ok);
        const status = expectedError
          ? refused
            ? "PASS"
            : "FAIL"
          : step.res.ok && !artifactBad
            ? "PASS"
            : tolerated
              ? "LIMITED"
              : throttled
                ? "RATE_LIMITED"
                : "FAIL";
        report.cases.push({
          key: `scenario:${scenario.name}:${step.tool}`,
          tool: step.tool,
          status,
          detail: step.res.text.slice(0, 300),
          ms: step.res.ms,
          ...(refusedBadly
            ? {
                reason: step.res.ok
                  ? "expected this call to be refused, but it succeeded"
                  : `refusal did not match ${step.expectError}`,
              }
            : artifactBad
              ? { reason: artifact.reason }
              : step.res.ok || tolerated || throttled
                ? {}
                : { reason: "step failed" }),
          ...(artifact && artifact.ok && artifact.note ? { note: artifact.note } : {}),
          ...(tolerated ? { limitation: step.limitation } : {}),
        });
      }
      const throttledScenario = !result.ok && (result.steps ?? []).some((s) => !s.res.ok && isRateLimit(s.res));
      report.cases.push({
        key: `scenario:${scenario.name}`,
        tool: "(scenario)",
        status: result.ok ? "PASS" : result.skipped ? "SKIPPED" : throttledScenario ? "RATE_LIMITED" : "FAIL",
        detail: result.reason ?? "round trip clean",
        // A passing scenario can still have something worth saying — e.g. it
        // repaired a marker a crashed earlier run left on the real account.
        ...(result.note ? { note: result.note } : {}),
      });
      if (result.ok && !result.skipped) for (const t of scenario.covers) scenarioVerified.add(t);
    }
  }

  // 4. Execute single-call cases.
  for (const [key, spec] of Object.entries(CATALOG)) {
    const toolName = spec.tool ?? key;
    if (ONLY && !ONLY.includes(toolName) && !ONLY.includes(key)) continue;
    if (spec.kind === "manual") {
      report.cases.push({
        key,
        tool: toolName,
        status: "SKIPPED",
        reason: spec.reason ?? "manual step — needs a human decision",
      });
      continue;
    }
    if (spec.kind === "write" && !WITH_WRITES) {
      report.cases.push({ key, tool: toolName, status: "SKIPPED", reason: "write tool (use --write)" });
      continue;
    }
    if (spec.kind === "destructive" && !WITH_DESTRUCTIVE) {
      report.cases.push({
        key,
        tool: toolName,
        status: "SKIPPED",
        reason: "permanent side effect (use --destructive)",
      });
      continue;
    }

    // A scenario already proved this tool end-to-end, so re-running it with fake
    // ids would only re-test the error path. That decision has to be made BEFORE
    // the call: for a long time this check sat after it, so every "skipped" write
    // still ran — each --write run really sent "[harness] ping" and re-uploaded
    // /etc/hostname to Saved Messages, then reported a clean skip and cleaned up
    // nothing. Never do the work and then decide you were not going to.
    if ((spec.kind === "write" || spec.kind === "destructive") && scenarioVerified.has(toolName)) {
      report.cases.push({
        key,
        tool: toolName,
        status: "SKIPPED",
        reason: "covered end-to-end by scenario",
      });
      continue;
    }

    let res;
    try {
      const args = typeof spec.args === "function" ? await spec.args(client) : spec.args;
      res = await callToolPaced(client, toolName, args, spec.idempotent ? 3 : 0);
    } catch (err) {
      report.cases.push({ key, tool: toolName, status: "FAIL", error: String(err.message ?? err) });
      continue;
    }

    // A rate limit means the call never ran, so it is neither a pass nor a
    // defect. It is reported as its own status and makes the verdict INCOMPLETE:
    // calling it a pass would hide an unverified tool, and calling it a failure
    // would blame the code for Telegram throttling a burst of test calls.
    if (isRateLimit(res)) {
      report.cases.push({
        key,
        tool: toolName,
        status: "RATE_LIMITED",
        detail: res.text.split("\n")[0].slice(0, 200),
      });
      continue;
    }

    // Auth is a precondition, not a tool bug. Report it once as BLOCKED and
    // stop flogging every tool with the same "not authorized" text.
    if (/^\[(NOT_AUTHORIZED|NO_SESSION|AUTH_KEY_DUPLICATED|AUTH_KEY_UNREGISTERED)\]/m.test(res.text)) {
      report.authBlocked = report.authBlocked ?? res.text.split("\n")[0];
      report.cases.push({ key, tool: toolName, status: "BLOCKED", detail: "session not authorized" });
      continue;
    }

    if (spec.kind === "expect-error") {
      // Both halves matter: the tool must set isError AND the message must name
      // a real code. Without the second check a typo'd expectation silently
      // "passed" forever because `expect` was never consulted.
      const isError = res.isError;
      const matched = spec.expect ? spec.expect.test(res.text) : true;
      const pass = isError && matched;
      report.cases.push({
        key,
        tool: toolName,
        status: pass ? "PASS" : "FAIL",
        detail: res.text.slice(0, 400),
        ms: res.ms,
        ...(pass
          ? {}
          : { reason: !isError ? "expected isError, got success" : `error text did not match ${spec.expect}` }),
      });
      continue;
    }

    if (spec.kind === "write" || spec.kind === "destructive") {
      // A write must actually succeed. Accepting a structured error as a pass
      // would let a permanently broken tool look green, which is how the
      // InputNotifyPeer bug in telegram_mute_chat survived: the call failed with
      // a structured code and the harness called it a pass.
      report.cases.push({
        key,
        tool: toolName,
        status: res.ok ? "PASS" : "FAIL",
        isError: res.isError,
        detail: res.text.slice(0, 300),
        ms: res.ms,
        ...(res.ok ? {} : { reason: "write failed" }),
      });
      continue;
    }

    const matched = spec.expect ? spec.expect.test(res.text) : true;
    // A tool that claims it wrote a file must have written one; the file is then
    // this run's debris and is removed. Without the first half a tool could
    // answer "exported" for a file that was never created, and without the
    // second the user's export directory fills with one file per harness pass.
    const artifact = spec.artifact ? verifyArtifact(spec, res) : null;
    report.cases.push({
      key,
      tool: toolName,
      status: res.ok && matched && (!artifact || artifact.ok) ? "PASS" : "FAIL",
      isError: res.isError,
      ms: res.ms,
      detail: res.text.slice(0, 400),
      ...(matched ? {} : { reason: `output did not match ${spec.expect}` }),
      ...(artifact && !artifact.ok ? { reason: artifact.reason } : {}),
      ...(artifact && artifact.ok && artifact.note ? { note: artifact.note } : {}),
    });
  }

  // 4. Cleanliness: the account is the only witness that cannot be fooled by a
  //    case that performed a write and then reported itself skipped. Anything
  //    newer than the watermark is debris this run created and did not remove.
  //    Asking the account costs a round trip, so this must run before the server
  //    is stopped.
  if (meWatermark !== null) {
    // `get_history` right after a send can return a list that does not yet include
    // it — the account has the message, the read has not caught up. That staleness
    // is why a sweep inside a scenario reported `leftover: []` while three
    // messages were sitting in the chat. A short pause before the final read, plus
    // a second read if the first disagrees with a sweep, makes the answer honest.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    let recent = await client.callTool("telegram_get_history", { chat: "me", limit: 50 });
    let created = [];
    try {
      created = (JSON.parse(recent.text).messages ?? []).filter(
        (m) => typeof m.id === "number" && m.id > meWatermark && looksLikeHarnessDebris(m),
      );
    } catch {
      created = [];
    }

    // If anything survived, remove it through the toolset and read again. The
    // report should say what happened, not merely that it happened — a run that
    // cleans up after itself is worth more than one that only complains.
    let reclaimed = [];
    if (created.length) {
      const ids = created.map((m) => m.id);
      const del = await client.callTool("telegram_delete_messages", { chat: "me", messageIds: ids, revoke: true });
      if (del.ok) {
        reclaimed = ids;
        journalRemove("me", ids);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const again = await client.callTool("telegram_get_history", { chat: "me", limit: 50 });
        try {
          created = (JSON.parse(again.text).messages ?? []).filter(
            (m) => typeof m.id === "number" && m.id > meWatermark && looksLikeHarnessDebris(m),
          );
        } catch {
          created = [];
        }
      }
    }
    // Anything newer than the watermark that is NOT harness debris was written by
    // another client during the run. It is never deleted and
    // never counted as this run's fault — but it is reported, so a run does not
    // silently attribute someone else's message to itself.
    let foreign = [];
    try {
      foreign = (JSON.parse(recent.text).messages ?? []).filter(
        (m) => typeof m.id === "number" && m.id > meWatermark && !looksLikeHarnessDebris(m),
      );
    } catch {
      foreign = [];
    }
    report.cleanliness = { watermark: meWatermark, leftover: created.length };
    if (foreign.length) {
      report.cleanliness.foreignMessages = foreign.map((m) => ({ id: m.id, text: (m.text ?? "").slice(0, 60) }));
    }
    if (reclaimed.length) report.cleanliness.reclaimed = reclaimed;
    if (created.length) {
      // This is the one place that knows, with certainty, which messages did not
      // exist before the run: anything newer than the watermark was created by it.
      // Journal them so `--reclaim` can delete exactly these and nothing else.
      // Recovery at the point of failure was not enough — the follow-up lookup was
      // itself throttled, so the ids were never recorded and debris survived a run
      // that reported the journal empty.
      for (const m of created) journalAdd("me", m.id, "leftover from a run that did not clean up");
      report.cleanliness.leftoverMessages = created.map((m) => ({
        id: m.id,
        text: (m.text ?? "").slice(0, 60),
        hasMedia: Boolean(m.media),
      }));
      report.cases.push({
        key: "__left_no_debris",
        tool: "(run cleanliness)",
        status: "FAIL",
        reason:
          `${created.length} message(s) survived the run in Saved Messages — ` +
          `run \`node harness/mcp-harness.mjs --reclaim\` to delete exactly these (they are journaled)`,
        detail: created
          .map((m) => `${m.id}: ${m.text ? m.text.slice(0, 50) : "(attachment)"}`)
          .join(" | "),
      });
    } else {
      report.cases.push({
        key: "__left_no_debris",
        tool: "(run cleanliness)",
        status: "PASS",
        detail: `no messages newer than ${meWatermark} in Saved Messages`,
      });
    }
  }

  // 5. Stop the server: a partial frame left in the pipe at exit is also a
  //    protocol violation and must be counted before the verdict is computed.
  client.stop();

  // 6. Sanity: stdout must carry JSON-RPC only. This is a HARD failure, not a
  //    warning: a single stray line makes real MCP clients drop the server, so a
  //    run that saw one must never report success.
  if (client.junk.length) {
    report.stdoutProtocolViolations = client.junk.slice(0, 5);
    report.cases.push({
      key: "__stdout_purity",
      tool: "(transport)",
      status: "FAIL",
      reason: "stdout must carry JSON-RPC only",
      detail: client.junk
        .slice(0, 5)
        .map((j) => `[${j.reason}] ${j.line}`)
        .join("\n"),
    });
  }

  // If anything is journaled, say so in the verdict line: the remedy is a single
  // command and the ids are already recorded, so there is no reason to guess.
  const journalLeft = readJournal().length;
  if (journalLeft) report.journalPending = { file: JOURNAL, ids: journalLeft };

  const counts = report.cases.reduce(
    (acc, c) => ((acc[c.status] = (acc[c.status] ?? 0) + 1), acc),
    { PASS: 0, FAIL: 0, SKIPPED: 0, BLOCKED: 0, LIMITED: 0, RATE_LIMITED: 0 },
  );

  // Coverage gaps are failures too: a tool the agent cannot reach through this
  // harness is a tool nobody verifies. `untested` = advertised but not in the
  // catalog; `missing` = catalogued but the server no longer advertises it.
  const coverageGap = report.coverage.untested.length > 0 || report.coverage.missing.length > 0;

  const verdict =
    counts.FAIL > 0
      ? "FAILURES_PRESENT"
      : coverageGap
        ? "COVERAGE_GAP"
        : counts.BLOCKED > 0
          ? "BLOCKED_BY_AUTH"
          : counts.RATE_LIMITED > 0
            ? "INCOMPLETE_RATE_LIMITED"
            : "ALL_EXECUTED_PASS";
  report.summary = {
    ...counts,
    authBlocked: report.authBlocked ?? null,
    stdoutPurity: client.junk.length === 0 ? "PURE" : "VIOLATED",
    coverageGap,
    verdict,
    stderrTail: client.stderr.join("").slice(-1500) || null,
  };

  emit(report);
  process.exitCode = counts.FAIL === 0 && !coverageGap && counts.RATE_LIMITED === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ doctor */

/**
 * `--doctor`: one call to `telegram_doctor`, health-gated exit code.
 *
 * Exit 0 = healthy:true, 3 = healthy:false (reachable but something is wrong),
 * 1 = harness/transport error (no handshake, tool crashed, stdout polluted).
 * The distinct 3 lets an agent branch on "needs fixing" vs "harness broken"
 * without parsing prose.
 */
/**
 * `--cleanup` — reclaim chats left behind by earlier destructive runs.
 *
 * The chat-lifecycle scenario creates a group and a channel and deletes both, so
 * a normal run leaves nothing. But a run that dies between "create" and "delete"
 * (or any run from before this tool existed) leaves a real chat behind. Without
 * a way to reclaim them, test debris accumulates silently in the account — which
 * is exactly how 15 empty "[harness]" channels piled up.
 *
 * Safety: only chats whose title matches the harness pattern *exactly* and that
 * have no public username are touched. A real chat that merely contains the word
 * "harness", or any chat with a username, is reported and skipped.
 */
/**
 * Titles this project's own test runs create. Matched exactly (after trim) so a
 * user's genuine chat named "harness walter" is never reclaimed — only the
 * "[harness] …" and bare "harness" names the harness and its ad-hoc probes make.
 */
const DEBRIS_TITLE = /^(?:\[(?:harness|trace|probe)\].*|harness)$/i;

/**
 * `--reclaim` — remove exactly the messages a run created and failed to delete.
 *
 * This exists because of a real mistake: a run was throttled halfway through the
 * media scenario, two attachments were left in Saved Messages, and a hand-written
 * "delete anything recent with media" script took eight messages with it — six
 * of them harness debris, two of them messages that predated the run. Guessing
 * from "looks like debris" is not safe in a chat the user also writes to.
 *
 * So this mode does not guess. A run records every message id it creates in
 * `.harness-journal.json` (see `journalAdd`), and `--reclaim` deletes only ids in
 * that journal, only in the chat they were recorded for. Anything else is
 * reported and left alone.
 */
async function reclaim() {
  const report = { startedAt: new Date().toISOString(), server: SERVER, mode: "reclaim", journal: JOURNAL, entries: [], deleted: [], skipped: [], failed: [] };
  const entries = readJournal();
  report.entries = entries;
  if (!entries.length) {
    report.note = "the journal is empty — nothing to reclaim";
    emitReclaim(report);
    return 0;
  }

  const client = new McpClient(SERVER).start();
  try {
    const init = await client.initialize();
    if (!init.result?.serverInfo) {
      report.error = "server did not initialize";
      client.stop();
      emitReclaim(report);
      return 1;
    }

    // Group by chat so one call removes all of a chat's leftovers.
    const byChat = new Map();
    for (const e of entries) {
      if (!byChat.has(e.chat)) byChat.set(e.chat, []);
      byChat.get(e.chat).push(e.id);
    }

    for (const [chat, ids] of byChat) {
      const res = await client.callTool("telegram_delete_messages", { chat, messageIds: ids, revoke: true });
      if (res.ok) {
        report.deleted.push({ chat, ids });
        // Only drop the ids that were actually accepted.
        journalRemove(chat, ids);
      } else {
        report.failed.push({ chat, ids, detail: res.text.slice(0, 200) });
      }
    }
  } finally {
    client.stop();
  }

  emitReclaim(report);
  return report.failed.length ? 1 : 0;
}

function emitReclaim(report) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  console.log(`reclaim -> ${report.server}`);
  console.log(`journal: ${report.journal}\n`);
  if (report.note) {
    console.log(report.note);
    return;
  }
  for (const e of report.entries) console.log(`  recorded ${e.chat} #${e.id} (${e.tool ?? "?"})`);
  console.log(`\n${report.deleted.length} chat(s) cleaned, ${report.failed.length} failed`);
  for (const f of report.failed) console.log(`  ⚠️  ${f.chat}: ${f.detail}`);
}

async function cleanup() {
  const report = { startedAt: new Date().toISOString(), server: SERVER, mode: "cleanup", found: [], deleted: [], skipped: [], failed: [] };
  const client = new McpClient(SERVER).start();

  try {
    const init = await client.initialize();
    report.serverInfo = init.result?.serverInfo ?? null;
    if (!report.serverInfo) {
      report.error = "server did not initialize";
      report.stderrTail = client.stderr.join("").slice(-2000) || null;
      client.stop();
      emitCleanup(report);
      return 1;
    }

    // includeAll + a high limit: debris is often archived or beyond the default page.
    const listed = await client.callTool("telegram_list_chats", { limit: 500, includeAll: true });
    if (!listed.ok) {
      report.error = `telegram_list_chats failed: ${listed.text.slice(0, 300)}`;
      client.stop();
      emitCleanup(report);
      return 1;
    }

    let chats = [];
    try {
      chats = JSON.parse(listed.text).chats ?? [];
    } catch (err) {
      report.error = `could not parse chat list: ${String(err.message ?? err)}`;
      client.stop();
      emitCleanup(report);
      return 1;
    }

    report.scanned = chats.length;
    const candidates = chats.filter((c) => DEBRIS_TITLE.test((c.title ?? "").trim()));
    report.found = candidates.map((c) => ({ id: c.id, title: c.title, username: c.username ?? null, type: c.type }));

    // Deleting channels back-to-back trips flood protection, and once Telegram
    // says FLOOD every remaining delete fails the same way. Space the calls and
    // stop at the first flood: reporting "3 deleted, 2 flooded" is useful,
    // hammering out five identical failures is not.
    const PACE_MS = Number(opt("--pace") ?? 2500);
    let flooded = false;

    for (const c of candidates) {
      // A username means it is a real, publicly addressable chat. Never delete
      // one on the strength of a title match alone.
      if (c.username) {
        report.skipped.push({ id: c.id, title: c.title, reason: "has a public username" });
        continue;
      }
      if (flooded) {
        report.skipped.push({ id: c.id, title: c.title, reason: "not attempted after flood wait" });
        continue;
      }
      const del = await client.callTool("telegram_delete_chat", { chat: c.id });
      if (del.ok) report.deleted.push({ id: c.id, title: c.title });
      else {
        report.failed.push({ id: c.id, title: c.title, error: del.text.slice(0, 200) });
        if (/FLOOD|SLOWMODE/i.test(del.text)) flooded = true;
      }
      await sleep(PACE_MS);
    }

    client.stop();
    emitCleanup(report);
    return report.failed.length === 0 ? 0 : 1;
  } catch (err) {
    report.error = String(err.message ?? err);
    client.stop();
    emitCleanup(report);
    return 1;
  }
}

function emitCleanup(report) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  console.log(`debris cleanup -> ${report.server}`);
  if (report.error) {
    console.log(`\n❌ ${report.error}`);
    if (report.stderrTail) console.log(`\n${report.stderrTail}`);
    return;
  }

  console.log(`scanned ${report.scanned} chats, ${report.found.length} match the harness title pattern`);
  for (const d of report.deleted) console.log(`  🗑  deleted ${d.id} — ${d.title}`);
  for (const s of report.skipped) console.log(`  ⏭  skipped ${s.id} — ${s.title} (${s.reason})`);
  for (const f of report.failed) console.log(`  ❌ failed ${f.id} — ${f.title}: ${f.error}`);
  if (report.found.length === 0) console.log("  nothing to clean");
  console.log(`\n${report.deleted.length} deleted, ${report.skipped.length} skipped, ${report.failed.length} failed`);
  if (report.failed.length) console.log("Re-run --cleanup after the flood wait expires to finish the job.");
}

async function doctor() {
  const report = { startedAt: new Date().toISOString(), server: SERVER, mode: "doctor", checks: [] };
  const client = new McpClient(SERVER).start();

  try {
    const init = await client.initialize();
    report.serverInfo = init.result?.serverInfo ?? null;
    if (!report.serverInfo) {
      report.error = "server did not initialize";
      report.stderrTail = client.stderr.join("").slice(-2000) || null;
      client.stop();
      emitDoctor(report);
      return 1;
    }

    const res = await client.callTool("telegram_doctor", {});
    report.ms = res.ms;

    if (res.isError) {
      // The doctor is designed never to throw for a bad session; an isError here
      // means the call itself broke, which is a harness-level failure.
      report.error = res.text.slice(0, 1000);
      client.stop();
      emitDoctor(report);
      return 1;
    }

    let payload;
    try {
      payload = JSON.parse(res.text);
    } catch {
      report.error = `telegram_doctor returned non-JSON text: ${res.text.slice(0, 300)}`;
      client.stop();
      emitDoctor(report);
      return 1;
    }

    report.healthy = Boolean(payload.healthy);
    report.account = payload.account ?? null;
    report.checks = (payload.checks ?? []).map((c) => ({
      name: c.name,
      pass: Boolean(c.pass),
      detail: c.detail ?? "",
    }));

    if (client.junk.length) {
      report.stdoutProtocolViolations = client.junk.slice(0, 5);
      report.error = "stdout must carry JSON-RPC only";
    }

    client.stop();
    emitDoctor(report);
    if (client.junk.length) return 1;
    return report.healthy ? 0 : 3;
  } catch (err) {
    report.error = String(err.message ?? err);
    report.stderrTail = client.stderr.join("").slice(-2000) || null;
    client.stop();
    emitDoctor(report);
    return 1;
  }
}

function emitDoctor(report) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  console.log(`telegram_doctor -> ${report.server}`);
  if (report.error) {
    console.log(`\n❌ ${report.error}`);
    if (report.stderrTail) console.log(`\n${report.stderrTail}`);
    return;
  }

  for (const c of report.checks) {
    console.log(`${c.pass ? "✅" : "❌"} ${c.name} — ${c.detail}`);
  }
  if (report.account) {
    console.log(`\naccount: id=${report.account.id} @${report.account.username ?? "?"}`);
  }
  console.log(`\n${report.healthy ? "healthy" : "unhealthy"} (${report.checks.length} checks)`);
  if (report.stdoutProtocolViolations) {
    console.log("\n⚠ stdout carried non-JSON lines (protocol violation):");
    for (const j of report.stdoutProtocolViolations) console.log(`   [${j.reason}] ${j.line}`);
  }
}


/**
 * `--policy` — prove the allowlist actually blocks, which no other mode can do.
 *
 * The gate is only as strong as its weakest tool, and a tool that resolves its
 * target by hand instead of through `requireChat`/`enforce` will answer anyway.
 * `telegram_user_photos` did exactly that and no test noticed, because every
 * other mode runs with allowAll. This mode starts the server with a one-entry
 * allowlist and probes a chat that is NOT on it; any answer is a bypass.
 *
 * Read-only by construction: the probes are chosen so that even a bypassed call
 * cannot mutate the account (a cancel-typing, a limit-1 history read, and so on).
 */
async function policy() {
  const ALLOW = opt("--allow") ?? TEST_CHAT;
  const DENY = opt("--deny") ?? "me";
  const report = { startedAt: new Date().toISOString(), mode: "policy", server: SERVER, allow: ALLOW, deny: DENY, probes: [], leaks: [] };

  const client = new McpClient(SERVER, { TELEGRAM_ALLOWED_CHATS: ALLOW }).start();
  try {
    const init = await client.initialize();
    if (!init.result?.serverInfo) {
      report.error = "server did not initialize";
      report.stderrTail = client.stderr.join("").slice(-2000) || null;
      client.stop();
      return 1;
    }

    // Every tool that takes a `chat` or `user` target must appear here, and the
    // mode fails if one does not: a new tool cannot be added without deciding how
    // it should behave under a deny. All args are read-only or a no-op
    // (unblocking something that is not blocked), so a bypass cannot mutate
    // anything.
    const PROBES = {
      telegram_chat_info: { chat: DENY },
      telegram_get_history: { chat: DENY, limit: 1 },
      telegram_get_message: { chat: DENY, messageId: 1 },
      telegram_search_messages: { chat: DENY, query: "x", limit: 1 },
      telegram_chat_members: { chat: DENY, limit: 1 },
      telegram_export_history: { chat: DENY, limit: 1, format: "json" },
      telegram_message_link: { chat: DENY, messageId: 1 },
      telegram_pinned_messages: { chat: DENY, limit: 1 },
      telegram_typing: { chat: DENY, action: "cancel" },
      telegram_mark_read: { chat: DENY },
      telegram_mute_chat: { chat: DENY, days: 0 },
      telegram_pin_chat: { chat: DENY, pinned: false },
      telegram_archive_chat: { chat: DENY, archived: false },
      telegram_send_message: { chat: DENY, text: "policy probe" },
      telegram_delete_messages: { chat: DENY, messageIds: [1] },
      telegram_pin_message: { chat: DENY, messageId: 1 },
      telegram_clear_history: { chat: DENY },
      telegram_unpin_all: { chat: DENY },
      telegram_leave_chat: { chat: DENY },
      telegram_delete_chat: { chat: DENY },
      telegram_edit_chat: { chat: DENY, title: "policy probe" },
      telegram_export_invite_link: { chat: DENY },
      telegram_set_chat_photo: { chat: DENY, remove: true },
      telegram_invite_members: { chat: DENY, users: [DENY] },
      telegram_promote_admin: { chat: DENY, user: DENY, preset: "none" },
      telegram_kick_member: { chat: DENY, user: DENY, unban: true },
      telegram_create_group: { title: "policy probe", users: [DENY] },
      telegram_user_photos: { user: DENY, limit: 1 },
      telegram_common_chats: { user: DENY, limit: 1 },
      telegram_full_user: { user: DENY },
      telegram_block_user: { user: DENY, unblock: true },
      telegram_add_contact: { user: DENY, firstName: "policy-probe" },
      telegram_delete_contacts: { users: [DENY] },
      telegram_edit_message: { chat: DENY, messageId: 1, text: "policy probe" },
      telegram_react: { chat: DENY, messageId: 1, emoji: "\u{1F44D}" },
      telegram_send_poll: { chat: DENY, question: "policy probe", answers: ["a", "b"] },
      telegram_send_contact: { chat: DENY, phone: "+15551234567", firstName: "x" },
      telegram_send_location: { chat: DENY, lat: 0, long: 0 },
      telegram_send_file: { chat: DENY, filePath: "/etc/hostname" },
      telegram_send_photo: { chat: DENY, filePath: "/etc/hostname" },
      telegram_download_media: { chat: DENY, messageId: 1 },
      telegram_chat_admins: { chat: DENY, limit: 1 },
      telegram_scheduled_messages: { chat: DENY, limit: 1 },
      telegram_translate: { chat: DENY, messageId: 1, targetLang: "en" },
      // join_chat takes `target`, not `chat` — and its invite branch used to skip
      // the allowlist entirely. Probing a public username (not a real invite, so
      // no join is attempted) proves the refusal comes from the policy.
      telegram_join_chat: { target: DENY },
    };

    // Discover the real surface from the server rather than trusting the map:
    // any advertised tool with a chat/user property that has no probe is a hole
    // in this test, not a pass.
    const listed = await client.listTools();
    const takesTarget = (t) => {
      const props = Object.keys(t.inputSchema?.properties ?? {});
      // `target` counts: telegram_join_chat takes an @username or an invite link
      // under that name, so a scan that only looked for chat/user skipped the one
      // tool that was actually bypassing the allowlist.
      return (
        props.includes("chat") ||
        props.includes("user") ||
        props.includes("users") ||
        props.includes("target")
      );
    };
    const uncovered = listed.filter((t) => takesTarget(t) && !PROBES[t.name]).map((t) => t.name);
    report.uncovered = uncovered;

    // A server with no credentials answers every call with a config error, which
    // is neither a refusal nor a bypass. Counting those as leaks turned a missing
    // .env into 40 alarming "policy bypass" reports — the worst possible false
    // positive, because it sends someone hunting a security bug that is not there.
    const authFailure = /TELEGRAM_API_ID|TELEGRAM_API_HASH|NO_SESSION|NOT_AUTHORIZED|AUTH_KEY|re-authorize/i;

    const probes = Object.entries(PROBES);
    for (const [name, args] of probes) {
      const res = await client.callTool(name, args);
      const detail = res.text.replace(/\s+/g, " ").slice(0, 200);
      if (res.isError && authFailure.test(res.text)) {
        report.probes.push({ tool: name, status: "BLOCKED", detail });
        continue;
      }
      const refused = res.isError && /not allow|allowlist|blocked by|not permitted/i.test(res.text);
      report.probes.push({ tool: name, status: refused ? "REFUSED" : "LEAK", refused, detail });
      if (!refused) report.leaks.push({ tool: name, detail });
    }
    report.blocked = report.probes.filter((p) => p.status === "BLOCKED").length;
    if (report.blocked && !report.leaks.length) {
      report.error =
        "the server could not reach Telegram, so the allowlist was never exercised — " +
        "set TELEGRAM_API_ID/TELEGRAM_API_HASH and log in, then re-run";
    }
  } finally {
    client.stop();
  }

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    console.log(`allowlist probe -> ${report.server}`);
    console.log(`allow: ${report.allow}   deny: ${report.deny}\n`);
    for (const p of report.probes) {
      if (p.status === "BLOCKED") console.log(`⏭ ${p.tool}: not reached (${p.detail.slice(0, 70)})`);
      else console.log(`${p.refused ? "✅" : "⚠️ "} ${p.tool}${p.refused ? ": refused" : `: NOT refused -> ${p.detail}`}`);
    }
    if (report.blocked) console.log(`\n${report.blocked}/${report.probes.length} probe(s) never reached the gate.`);
    if (report.uncovered?.length) {
      console.log(`\n⚠️  ${report.uncovered.length} chat/user tool(s) have no probe: ${report.uncovered.join(", ")}`);
      console.log("   Add them to PROBES in policy() so a new tool cannot skip this test.");
    }
    console.log(`\n${report.leaks.length} bypass(es)`);
    if (report.leaks.length) {
      console.log("\nA tool that answers for a denied chat is a policy bypass. Route it through");
      console.log("resolveChat() + enforce() (or requireChat()) like every other chat tool.");
    }
  }
  const clean = report.leaks.length === 0 && !report.uncovered?.length && !report.error;
  return clean ? 0 : 1;
}

function emit(report) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }

  console.log(`MCP harness -> ${report.server}`);
  if (report.serverInfo) console.log(`server: ${report.serverInfo.name}@${report.serverInfo.version}`);
  if (report.serverInfo === undefined) {
    console.log(`\n❌ SERVER DID NOT INITIALIZE\n${report.summary?.stderr ?? report.initError ?? ""}`);
    return;
  }

  console.log(`\ntools advertised: ${report.coverage.advertised}`);
  if (report.coverage.untested.length) {
    console.log(`  ❌ advertised but not in the CATALOG: ${report.coverage.untested.join(", ")}`);
  }
  if (report.coverage.missing.length) {
    console.log(`  ❌ in the CATALOG but not advertised: ${report.coverage.missing.join(", ")}`);
  }

  console.log("");
  for (const c of report.cases) {
    const icon =
      c.status === "PASS"
        ? "✅"
        : c.status === "FAIL"
          ? "❌"
          : c.status === "BLOCKED"
            ? "🔒"
            : c.status === "RATE_LIMITED"
              ? "🚦"
              : "⏭";
    const note = c.reason ? ` — ${c.reason}` : c.note ? ` — ${c.note}` : "";
    const timing = c.ms ? ` (${duration(c.ms)})` : "";
    console.log(`${icon} ${c.tool}${timing}${note}`);
    if ((c.status === "FAIL" || c.status === "RATE_LIMITED") && c.detail)
      console.log(`     ${c.detail.split("\n").slice(0, 4).join("\n     ")}`);
  }

  if (report.stdoutProtocolViolations) {
    console.log(`\n❌ PROTOCOL VIOLATION — stdout must carry JSON-RPC only.`);
    console.log("   A real MCP client drops the server on the first stray line. Fix the writer");
    console.log("   (usually a console.log that escaped stream-guard.ts) before shipping.");
    for (const j of report.stdoutProtocolViolations) console.log(`   [${j.reason}] ${j.line}`);
  }

  const s = report.summary;
  if (report.authBlocked) {
    console.log(`\n🔒 ${s.BLOCKED} tools blocked: ${report.authBlocked}`);
    console.log("   Fix: call telegram_login_start over MCP, or run `npm run login`.");
  }
  console.log(
    `\n${s.PASS} passed, ${s.FAIL} failed, ${s.SKIPPED} skipped, ${s.BLOCKED} blocked` +
      `${s.RATE_LIMITED ? `, ${s.RATE_LIMITED} rate-limited` : ""} -> ${s.verdict}`,
  );
  if (s.RATE_LIMITED) {
    console.log("   Telegram throttled those calls, so they were never verified. Wait a few");
    console.log("   minutes and re-run — the verdict stays red until they actually execute.");
  }
  if (report.journalPending) {
    console.log(`\n🧹 ${report.journalPending.ids} message id(s) recorded in ${report.journalPending.file}`);
    console.log("   Run `node harness/mcp-harness.mjs --reclaim` to delete exactly those.");
  }
}

const MODE_DOCTOR = flag("--doctor");
const MODE_CLEANUP = flag("--cleanup");
const MODE_POLICY = flag("--policy");
const MODE_RECLAIM = flag("--reclaim");

(MODE_DOCTOR ? doctor() : MODE_CLEANUP ? cleanup() : MODE_POLICY ? policy() : MODE_RECLAIM ? reclaim() : main())
  .then((code) => {
    if (typeof code === "number") process.exitCode = code;
  })
  .catch((err) => {
    console.error("harness crashed:", err);
    process.exitCode = 1;
  });
