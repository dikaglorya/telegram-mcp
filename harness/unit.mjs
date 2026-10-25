#!/usr/bin/env node
/**
 * Offline unit checks for the pieces that don't need a live Telegram session:
 *   - errors.ts     : RPC error -> {code, hint, retryAfterSec}
 *   - audit.ts      : secret redaction vs. error-code preservation
 *   - policy.ts     : allowlist beats allowAllChats
 *   - helpers.ts    : marked peer ids for allowlists
 *
 * Runs against dist/ so it validates the *built* artifact the MCP server uses.
 *   node harness/unit.mjs
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// Absolute Windows paths need a file:// URL before the ESM loader will accept
// them. pathToFileURL also handles spaces and non-ASCII paths.
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);

// Point state/audit at a throwaway dir so tests never touch real ~/.telegram-mcp.
// os.tmpdir() is the portable choice; "/tmp" does not exist on Windows.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "tgmcp-unit-"));
process.on("exit", () => {
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not a test failure */
  }
});
process.env.TELEGRAM_STATE_DIR = sandbox;
process.env.TELEGRAM_SESSION_PATH = path.join(sandbox, "session.txt");
process.env.TELEGRAM_AUDIT_LOG = path.join(sandbox, "audit.log");
process.env.TELEGRAM_MEDIA_DIR = path.join(sandbox, "media");
process.env.TELEGRAM_EXPORT_DIR = path.join(sandbox, "exports");
process.env.TELEGRAM_API_ID ||= "1";
process.env.TELEGRAM_API_HASH ||= "test-hash";

const results = [];
const pending = [];
function check(name, fn) {
  try {
    const out = fn();
    if (out === false) throw new Error("returned false");

    // An async check has not run yet when `fn` returns. Recording PASS here
    // would green-light a check whose body never executed, so the slot is
    // reserved and settled once the promise resolves.
    if (out && typeof out.then === "function") {
      const slot = results.push({ name, status: "PASS" }) - 1;
      pending.push(
        out.then(
          (value) => {
            if (value === false) results[slot] = { name, status: "FAIL", detail: "returned false" };
            else if (typeof value === "string") results[slot].detail = value;
          },
          (err) => {
            results[slot] = { name, status: "FAIL", detail: String(err?.message ?? err) };
          },
        ),
      );
      return;
    }

    results.push({ name, status: "PASS", detail: typeof out === "string" ? out : undefined });
  } catch (err) {
    results.push({ name, status: "FAIL", detail: String(err.message ?? err) });
  }
}

const { normalizeError, formatError } = await load("dist/errors.js");
const { audit, flushAuditSync } = await load("dist/audit.js");
const policy = await load("dist/policy.js");
const { markedId, enforce, isFlood, withFloodRetry, shapeMedia, resolveChat, peerKind, peerIdOf, shapeMessage } = await load("dist/helpers.js");
const { inviteSlug, idsFromUpdates } = await load("dist/util.js");
const access = await load("dist/access.js");
const approvals = await load("dist/approvals.js");
const workflow = await load("dist/workflow-core.js");
const auditRead = await load("dist/audit-read.js");
const { resetConfigForTest } = await load("dist/config.js");
const { Api } = await import("telegram");

/* -------------------------------------------------------------- util helpers */

check("util: inviteSlug accepts a pasted t.me link and a bare slug", () => {
  const cases = [
    ["https://t.me/+AbCdEf123456", "AbCdEf123456"],
    ["t.me/joinchat/AbCdEf123456", "AbCdEf123456"],
    ["https://telegram.me/+AbCdEf123456", "AbCdEf123456"],
    ["AbCdEf123456", "AbCdEf123456"],
    ["see https://t.me/+AbCdEf123456 for access", "AbCdEf123456"],
  ];
  for (const [input, want] of cases) {
    const got = inviteSlug(input);
    if (got !== want) throw new Error(`${input} -> ${got}, expected ${want}`);
  }
  // Anything that is not an invite is rejected rather than passed through.
  for (const bad of ["", "   ", "hello world", "https://example.com/x"]) {
    if (inviteSlug(bad) !== null) throw new Error(`${JSON.stringify(bad)} should be rejected`);
  }
  return `${cases.length} forms, junk rejected`;
});

check("util: idsFromUpdates reads the new id from either update shape", () => {
  // UpdateNewChannelMessage carries the message; UpdateMessageID carries only the id.
  const updates = [
    { className: "UpdateNewChannelMessage", message: { id: 501 } },
    { className: "UpdateMessageID", id: 502 },
    { className: "UpdateNewMessage", message: { id: 501 } }, // duplicate, must not repeat
    { className: "UpdateReadHistoryInbox" }, // irrelevant
  ];
  const ids = idsFromUpdates({ updates });
  if (ids.length !== 2 || ids[0] !== 501 || ids[1] !== 502) throw new Error(JSON.stringify(ids));
  // A response with no updates must yield [] rather than throwing: callers report
  // a null id, which is exactly how the forward bug stayed invisible.
  if (idsFromUpdates(undefined).length !== 0) throw new Error("undefined should give []");
  if (idsFromUpdates({}).length !== 0) throw new Error("{} should give []");
  return ids.join(",");
});


/* ------------------------------------------------------------------ errors */

check("errors: FLOOD_WAIT_42 extracts code + wait", () => {
  const n = normalizeError(Object.assign(new Error("FLOOD_WAIT_42"), { errorMessage: "FLOOD_WAIT_42", code: 420 }));
  if (n.code !== "FLOOD_WAIT") throw new Error(`code=${n.code}`);
  if (n.retryAfterSec !== 42) throw new Error(`retryAfterSec=${n.retryAfterSec}`);
  if (!n.retryable) throw new Error("should be retryable");
  return `${n.code} ${n.retryAfterSec}s`;
});

check("errors: 'A wait of N seconds' sentence", () => {
  const n = normalizeError(new Error("A wait of 17 seconds is required (caused by messages.SendMessage)"));
  if (n.retryAfterSec !== 17) throw new Error(`retryAfterSec=${n.retryAfterSec}`);
  if (/caused by/.test(n.message)) throw new Error("cause not stripped from message");
  return n.message;
});

check("errors: FloodWaitError keeps its duration despite a bare errorMessage", () => {
  // gramJS puts "FLOOD" in errorMessage and the duration in `message`/`seconds`.
  // Preferring errorMessage discarded the duration, so a 9-hour flood was reported
  // as "no duration given" — advice that walked straight into another throttle.
  const err = Object.assign(new Error("A wait of 31951 seconds is required (caused by messages.SendMedia)"), {
    errorMessage: "FLOOD",
    seconds: 31951,
    code: 420,
  });
  const n = normalizeError(err);
  if (n.code !== "FLOOD_WAIT") throw new Error(`code=${n.code}`);
  if (n.retryAfterSec !== 31951) throw new Error(`retryAfterSec=${n.retryAfterSec}`);
  if (!/9 hour/.test(n.hint ?? "")) throw new Error(`hint does not name the real duration: ${n.hint}`);
  if (/wait a minute|wait retryAfterSec/i.test(n.hint ?? "")) {
    throw new Error("hint still advises a short retry for a 9-hour block");
  }
  return `9h block reported as ${n.retryAfterSec}s`;
});

check("errors: a bare FLOOD with no duration still says so", () => {
  const err = Object.assign(new Error("FLOOD"), { errorMessage: "FLOOD", code: 420 });
  const n = normalizeError(err);
  if (n.retryAfterSec !== undefined) throw new Error(`retryAfterSec should be undefined, got ${n.retryAfterSec}`);
  if (!/did not say for how long/i.test(n.hint ?? "")) throw new Error(`hint=${n.hint}`);
  return "bare FLOOD keeps its honest hint";
});

check("errors: CHANNEL_INVALID gets a hint", () => {
  const n = normalizeError(Object.assign(new Error("CHANNEL_INVALID"), { errorMessage: "CHANNEL_INVALID", code: 400 }));
  if (n.code !== "CHANNEL_INVALID") throw new Error(`code=${n.code}`);
  if (!n.hint) throw new Error("missing hint");
  if (n.retryable) throw new Error("must not be retryable");
  return n.hint.slice(0, 40);
});

check("errors: NotAuthorizedError maps to NOT_AUTHORIZED", () => {
  const n = normalizeError(new Error("Stored Telegram session is not authorized. Re-run `npm run login`."));
  if (n.code !== "NOT_AUTHORIZED") throw new Error(`code=${n.code}`);
  return n.code;
});

check("errors: own .code wins over message sniffing (regression)", () => {
  // NotAuthorizedError carries code=NO_SESSION; it used to surface as [UNKNOWN]
  // because only the message text was inspected.
  const err = Object.assign(new Error("No Telegram session yet."), { code: "NO_SESSION" });
  const n = normalizeError(err);
  if (n.code !== "NO_SESSION") throw new Error(`code=${n.code}`);
  if (!n.hint) throw new Error("missing hint");
  return n.code;
});

check("errors: AUTH_KEY_DUPLICATED keeps its own code + hint", () => {
  const err = Object.assign(new Error("Auth key duplicated"), { code: "AUTH_KEY_DUPLICATED" });
  const n = normalizeError(err);
  if (n.code !== "AUTH_KEY_DUPLICATED") throw new Error(`code=${n.code}`);
  if (!/force:true/.test(n.hint ?? "")) throw new Error(`hint=${n.hint}`);
  return n.code;
});

check("errors: numeric .code (RPC 420) is not mistaken for a string code", () => {
  const err = Object.assign(new Error("FLOOD_WAIT_5"), { code: 420, errorMessage: "FLOOD_WAIT_5" });
  const n = normalizeError(err);
  if (n.code !== "FLOOD_WAIT") throw new Error(`code=${n.code}`);
  if (n.retryAfterSec !== 5) throw new Error(`retry=${n.retryAfterSec}`);
  return n.code;
});

check("errors: formatError is multi-line and actionable", () => {
  const text = formatError(normalizeError(new Error("FLOOD_WAIT_9")));
  if (!text.includes("[FLOOD_WAIT]")) throw new Error("missing code prefix");
  if (!text.includes("retry_after_seconds: 9")) throw new Error("missing retry hint");
  if (!text.includes("hint:")) throw new Error("missing hint line");
  return text.split("\n")[0];
});

check("errors: Node ERR_* codes do not short-circuit message sniffing", () => {
  const err = Object.assign(new Error("connect ECONNREFUSED 149.154.167.51:443"), {
    code: "ERR_INVALID_ARG_VALUE",
  });
  const n = normalizeError(err);
  if (n.code === "ERR_INVALID_ARG_VALUE") throw new Error("Node code leaked through");
  if (n.code !== "NETWORK") throw new Error(`code=${n.code}`);
  if (!n.retryable) throw new Error("NETWORK must be retryable");
  return n.code;
});

check("errors: NETWORK is retryable + has a hint", () => {
  const n = normalizeError(new Error("read ECONNRESET"));
  if (n.code !== "NETWORK") throw new Error(`code=${n.code}`);
  if (!n.retryable) throw new Error("not retryable");
  if (!n.hint) throw new Error("no hint");
  return n.code;
});

check("errors: PREMIUM_ACCOUNT_REQUIRED has a hint (found in live test)", () => {
  const n = normalizeError(Object.assign(new Error("PREMIUM_ACCOUNT_REQUIRED"), { errorMessage: "PREMIUM_ACCOUNT_REQUIRED", code: 403 }));
  if (n.code !== "PREMIUM_ACCOUNT_REQUIRED") throw new Error(`code=${n.code}`);
  if (!n.hint) throw new Error("missing hint");
  if (n.retryable) throw new Error("must not be retryable");
  return "hinted";
});

check("source: gramJS args are real instances, never {className} literals", () => {
  // A plain object makes gramJS send an untyped payload and the server answers
  // "Cannot cast InputNotifyPeer to any kind of peer" — which is exactly how
  // telegram_mute_chat was broken. This scans the built output for the pattern.
  const files = fs.readdirSync(path.join(root, "dist")).filter((f) => f.endsWith(".js"));
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, "dist", f), "utf8");
    // A literal that fakes a TL class:  { className: "InputX", ... }  passed to a constructor arg.
    const re = /\{\s*className:\s*"Input[A-Za-z]+"/g;
    const hit = src.match(re);
    if (hit) offenders.push(`${f}: ${hit.length}`);
  }
  if (offenders.length) throw new Error(`fake TL class literals in: ${offenders.join(", ")}`);
  return "no fake class literals";
});

check("errors: bare FLOOD is recognized (was [UNKNOWN])", () => {
  // Telegram sometimes answers a flooded ResolveUsername with just "FLOOD",
  // with no trailing _N. The generic code regex needs an underscore, so this
  // used to fall through to UNKNOWN and the caller read it as "chat not found".
  const n = normalizeError(Object.assign(new Error("FLOOD"), { errorMessage: "FLOOD", code: 420 }));
  if (n.code !== "FLOOD_WAIT") throw new Error(`code=${n.code}`);
  return n.code;
});

check("errors: a bare FLOOD hint carries no dangling 'retryAfterSec'", () => {
  // With no wait time there is no number to interpolate, and the generic hint
  // told the caller to "wait retryAfterSec seconds" — a variable name standing
  // in for a value it never had. The text has to be actionable on its own.
  const n = normalizeError(Object.assign(new Error("FLOOD"), { errorMessage: "FLOOD", code: 420 }));
  if (n.retryAfterSec !== undefined) throw new Error(`unexpected retryAfterSec=${n.retryAfterSec}`);
  if (/retryAfterSec/.test(n.hint ?? "")) throw new Error(`hint still names the placeholder: ${n.hint}`);
  if (!/at least a minute/i.test(n.hint ?? "")) throw new Error(`hint is not actionable: ${n.hint}`);

  // With a real number the placeholder is correct: it resolves to something.
  const timed = normalizeError(Object.assign(new Error("FLOOD_WAIT_42"), { errorMessage: "FLOOD_WAIT_42", code: 420 }));
  if (!/retryAfterSec/.test(timed.hint ?? "")) throw new Error("timed hint should keep using the value");
  return n.hint.slice(0, 40);
});

check("errors: an error naming its own code keeps its own wait time", () => {
  // `resolveChat` raises a flood with an explicit code and seconds. The own-code
  // branch used to hardcode `retryAfterSec: undefined`, so the wait time was lost
  // even though the error carried it.
  const err = Object.assign(new Error("rate limited"), { code: "FLOOD_WAIT", seconds: 30 });
  const n = normalizeError(err);
  if (n.code !== "FLOOD_WAIT") throw new Error(`code=${n.code}`);
  if (n.retryAfterSec !== 30) throw new Error(`retryAfterSec=${n.retryAfterSec}`);
  if (!n.retryable) throw new Error("FLOOD_WAIT must stay retryable");
  return `${n.code} ${n.retryAfterSec}s`;
});

check("helpers: withFloodRetry retries a transient flood, then succeeds", async () => {
  let calls = 0;
  const out = await withFloodRetry(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("FLOOD_WAIT_1"), { errorMessage: "FLOOD_WAIT_1", code: 420 });
    return "ok";
  });
  if (out !== "ok") throw new Error("did not recover");
  if (calls !== 3) throw new Error(`calls=${calls}`);
  return `recovered after ${calls} attempts`;
});

check("helpers: withFloodRetry refuses to sleep through a long ban", async () => {
  let calls = 0;
  let threw = false;
  const started = Date.now();
  try {
    await withFloodRetry(async () => {
      calls++;
      throw Object.assign(new Error("FLOOD_WAIT_600"), { errorMessage: "FLOOD_WAIT_600", code: 420 });
    });
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("swallowed a 600s ban");
  if (calls !== 1) throw new Error(`slept anyway: calls=${calls}`);
  if (Date.now() - started > 1000) throw new Error("blocked for a long ban");
  return "reported instead of sleeping";
});

check("helpers: isFlood does not swallow unrelated errors", () => {
  if (!isFlood(normalizeError(Object.assign(new Error("FLOOD_WAIT_9"), { errorMessage: "FLOOD_WAIT_9", code: 420 }))))
    throw new Error("missed a real flood");
  if (isFlood(normalizeError(Object.assign(new Error("CHANNEL_INVALID"), { errorMessage: "CHANNEL_INVALID", code: 400 }))))
    throw new Error("classified a non-flood as flood");
  return "discriminates";
});

/* ------------------------------------------------------------------- audit */

check("audit: error CODE is preserved (not mistaken for OTP)", () => {
  audit("unit_test", { chat: "x" }, "error", { code: "FLOOD_WAIT", message: "slow down" });
  flushAuditSync();
  const line = fs.readFileSync(process.env.TELEGRAM_AUDIT_LOG, "utf8").trim().split("\n").pop();
  const rec = JSON.parse(line);
  if (rec.detail.code !== "FLOOD_WAIT") throw new Error(`got ${JSON.stringify(rec.detail.code)}`);
  return "code readable";
});

check("audit: numeric OTP in 'code' is redacted", () => {
  audit("unit_test", { code: "12345" }, "error", { code: "123456" });
  flushAuditSync();
  const line = fs.readFileSync(process.env.TELEGRAM_AUDIT_LOG, "utf8").trim().split("\n").pop();
  const rec = JSON.parse(line);
  if (rec.args.code !== "[redacted]") throw new Error(`args.code=${rec.args.code}`);
  if (rec.detail.code !== "[redacted]") throw new Error(`detail.code=${rec.detail.code}`);
  return "OTP hidden";
});

check("audit: password/token keys always redacted", () => {
  audit("unit_test", { password: "hunter2", token: "abc", api_hash: "zz" }, "ok");
  flushAuditSync();
  const line = fs.readFileSync(process.env.TELEGRAM_AUDIT_LOG, "utf8").trim().split("\n").pop();
  const rec = JSON.parse(line);
  for (const k of ["password", "token", "api_hash"]) {
    if (rec.args[k] !== "[redacted]") throw new Error(`${k}=${rec.args[k]}`);
  }
  return "3 keys hidden";
});

check("audit: phone_code_hash is always redacted (it is a credential)", () => {
  audit("unit_test", { phone_code_hash: "1a2b3c4d5e", phoneCodeHash: "abc" }, "ok");
  flushAuditSync();
  const line = fs.readFileSync(process.env.TELEGRAM_AUDIT_LOG, "utf8").trim().split("\n").pop();
  const rec = JSON.parse(line);
  if (rec.args.phone_code_hash !== "[redacted]") throw new Error(`got ${rec.args.phone_code_hash}`);
  if (rec.args.phoneCodeHash !== "[redacted]") throw new Error(`got ${rec.args.phoneCodeHash}`);
  return "credential hidden";
});

check("audit: non-taxonomy 'hash' value is redacted", () => {
  audit("unit_test", { hash: "AbCdEf12" }, "ok");
  flushAuditSync();
  const line = fs.readFileSync(process.env.TELEGRAM_AUDIT_LOG, "utf8").trim().split("\n").pop();
  const rec = JSON.parse(line);
  if (rec.args.hash !== "[redacted]") throw new Error(`got ${rec.args.hash}`);
  return "invite hash hidden";
});

/* ------------------------------------------------------------------ policy */

const baseConfig = { allowAllChats: true, allowlist: [], statePath: path.join(sandbox, "state.json") };

check("policy: allowAllChats=true + empty allowlist => allowed", () => {
  if (!policy.isAllowed({ ...baseConfig }, { username: "anything" })) throw new Error("blocked");
  return "open mode";
});

check("policy: allowlist beats allowAllChats=true", () => {
  const cfg = { ...baseConfig, allowlist: ["examplechannel"] };
  if (!policy.hasAllowlist(cfg)) throw new Error("allowlist not detected");
  if (policy.isAllowed(cfg, { username: "other_channel" })) throw new Error("non-listed chat allowed");
  if (!policy.isAllowed(cfg, { username: "ExampleChannel" })) throw new Error("listed chat blocked (case)");
  return "allowlist enforced";
});

check("policy: enforce() blocks a non-listed chat with an actionable message", () => {
  // enforce() is the real production gate (called by requireChat); assertAllowed()
  // was removed as dead code. This must exercise the path tools actually use.
  // Reset memoized config so it picks up the env vars we're about to set.
  resetConfigForTest();
  const cfg = { ...baseConfig, allowAllChats: false, allowlist: ["x"] };
  process.env.TELEGRAM_ALLOWED_CHATS = "x";
  process.env.TELEGRAM_ALLOW_ALL_CHATS = "false";
  try {
    enforce(null, { id: "1", peerId: "-1001", title: "Y", username: "y", type: "channel", entity: null, inputEntity: null, resolvedBy: "id" });
    throw new Error("enforce() did not throw for a non-listed chat");
  } catch (err) {
    if (/did not throw/.test(err.message)) throw err;
    if (/telegram_allow_chat\b/.test(err.message)) throw new Error("references non-existent tool");
    if (!/TELEGRAM_ALLOWED_CHATS/.test(err.message)) throw new Error("no actionable env var");
    return "actionable";
  } finally {
    delete process.env.TELEGRAM_ALLOWED_CHATS;
    delete process.env.TELEGRAM_ALLOW_ALL_CHATS;
  }
});

check("policy: enforce() allows a listed chat", () => {
  resetConfigForTest();
  process.env.TELEGRAM_ALLOWED_CHATS = "examplechannel";
  process.env.TELEGRAM_ALLOW_ALL_CHATS = "false";
  try {
    enforce(null, { id: "1234567890", peerId: "-1001234567890", title: "Example Channel", username: "examplechannel", type: "channel", entity: null, inputEntity: null, resolvedBy: "username" });
    return "allowed";
  } finally {
    delete process.env.TELEGRAM_ALLOWED_CHATS;
    delete process.env.TELEGRAM_ALLOW_ALL_CHATS;
  }
});

check("policy: title match is EXACT, not substring (security regression)", () => {
  // "alice" must not authorize "Alice's scam group".
  const cfg = { ...baseConfig, allowlist: ["alice"] };
  if (policy.isAllowed(cfg, { title: "Alice's scam group" })) {
    throw new Error("substring title bypassed the allowlist");
  }
  if (!policy.isAllowed(cfg, { title: "Alice" })) throw new Error("exact title rejected");
  return "exact only";
});

check("policy: allowlist entry matches marked channel id", () => {
  const cfg = { ...baseConfig, allowlist: ["-1001234567890"] };
  if (!policy.isAllowed(cfg, { id: "-1001234567890" })) throw new Error("marked id not matched");
  return "marked id ok";
});

/* ----------------------------------------------------------------- markedId */

check("helpers: markedId gives -100 prefix for channels", () => {
  const got = markedId({ id: 1234567890n, className: "Channel" });
  if (got !== "-1001234567890") throw new Error(got);
  return got;
});

check("helpers: markedId gives - prefix for basic groups", () => {
  const got = markedId({ id: 123, className: "Chat" });
  if (got !== "-123") throw new Error(got);
  return got;
});

check("helpers: markedId leaves users unsigned", () => {
  const got = markedId({ id: 123456789, className: "User" });
  if (got !== "123456789") throw new Error(got);
  return got;
});

check("helpers: a flood during a lookup keeps its code and wait time", async () => {
  // `resolveChat` used to rethrow a plain Error, so a rate limit reached the
  // caller as `[UNKNOWN]` and the harness reported an actionable throttle as a
  // tool defect. It must stay machine-readable all the way out.
  const client = {
    getEntity: async () => {
      // A long ban makes withFloodRetry refuse to sleep, so the error reaches
      // resolveChat's flood branch immediately instead of waiting a real minute.
      throw Object.assign(new Error("FLOOD_WAIT_3600"), {
        errorMessage: "FLOOD_WAIT_3600",
        code: 420,
        seconds: 3600,
      });
    },
  };
  let thrown = null;
  try {
    await resolveChat(client, "@somechannel");
  } catch (err) {
    thrown = normalizeError(err);
  }
  if (!thrown) throw new Error("expected resolveChat to throw on a flooded lookup");
  if (thrown.code !== "FLOOD_WAIT") throw new Error(`code=${thrown.code}`);
  if (thrown.retryAfterSec !== 3600) throw new Error(`retryAfterSec=${thrown.retryAfterSec}`);
  if (!thrown.retryable) throw new Error("a rate-limited lookup must be retryable");
  return `${thrown.code} ${thrown.retryAfterSec}s`;
});

/* ---------------------------------------------------------------- shapeMedia */check("helpers: shapeMedia describes a document with name, mime and size", () => {
  // A bare class name is not a description: it cannot tell a forwarded PDF from
  // a 12-byte /etc/hostname upload, which is what the harness debris was.
  const got = shapeMedia({
    className: "MessageMediaDocument",
    document: {
      id: 7n,
      size: 12n,
      mimeType: "text/plain",
      attributes: [{ className: "DocumentAttributeFilename", fileName: "hostname" }],
    },
  });
  if (got.type !== "MessageMediaDocument") throw new Error(`type=${got.type}`);
  if (got.fileName !== "hostname") throw new Error(`fileName=${got.fileName}`);
  if (got.mime !== "text/plain") throw new Error(`mime=${got.mime}`);
  if (got.size !== 12) throw new Error(`size=${got.size} (${typeof got.size})`);
  return `${got.fileName} ${got.mime} ${got.size}B`;
});

check("helpers: shapeMedia sizes a photo from its encodings", () => {
  const got = shapeMedia({
    className: "MessageMediaPhoto",
    photo: { sizes: [{ className: "PhotoSize", size: 100 }, { className: "PhotoSizeProgressive", sizes: [1, 2, 4321] }] },
  });
  if (got.size !== 4321) throw new Error(`size=${got.size}`);
  if (got.fileName) throw new Error("a photo has no file name");
  return `photo ${got.size}B`;
});

check("helpers: shapeMedia keeps a web page as plain scalars", () => {
  const got = shapeMedia({
    className: "MessageMediaWebPage",
    webpage: { url: "https://example.com/x", title: "Example", siteName: "example.com" },
  });
  if (got.url !== "https://example.com/x") throw new Error(`url=${got.url}`);
  if (got.title !== "Example") throw new Error(`title=${got.title}`);
  if (got.site !== "example.com") throw new Error(`site=${got.site}`);
  return got.site;
});

check("helpers: shapeMedia returns null without media and never the raw object", () => {
  if (shapeMedia(null) !== null) throw new Error("null media must stay null");
  if (shapeMedia(undefined) !== null) throw new Error("undefined media must stay null");
  // A document with nothing useful must still yield a plain object, not the TL
  // object itself: raw entities leaking into tool output was a fixed bug here.
  const got = shapeMedia({ className: "MessageMediaDocument", document: { id: 1n } });
  if (got === null || typeof got !== "object") throw new Error("expected an object");
  if (got.type !== "MessageMediaDocument") throw new Error(`type=${got.type}`);
  if (Object.keys(got).length !== 1) throw new Error(`unexpected keys: ${Object.keys(got)}`);
  return "{ type }";
});

/* --------------------------------------------------------------- peer kinds */

check("helpers: peerKind separates basic groups from channels", () => {
  // The delete API depends on this: messages.DeleteChat for a legacy group,
  // channels.DeleteChannel for everything else. Picking wrong yields a
  // class-cast error with no hint about the argument, so the split is pinned.
  const cases = [
    [{ className: "Chat" }, "basic-group"],
    [{ className: "ChatForbidden" }, "basic-group"],
    [{ className: "ChatEmpty" }, "basic-group"],
    [{ className: "Channel", megagroup: true }, "channel"],
    [{ className: "ChannelForbidden" }, "channel"],
    [{ className: "User" }, "user"],
    [{ className: "UserEmpty" }, "user"],
    [{ className: "SomethingNew" }, "unknown"],
    [{}, "unknown"],
  ];
  for (const [entity, want] of cases) {
    const got = peerKind(entity);
    if (got !== want) throw new Error(`${JSON.stringify(entity)} -> ${got}, wanted ${want}`);
  }
  return `${cases.length} shapes classified`;
});

check("helpers: peerKind falls back to the constructor name", () => {
  // Some gramJS entities arrive without a `className` string; reading only that
  // field would classify every one of them as unknown and refuse a real delete.
  class Chat {}
  if (peerKind(new Chat()) !== "basic-group") throw new Error("constructor fallback broken");
  class Channel {}
  if (peerKind(new Channel()) !== "channel") throw new Error("constructor fallback broken");
  return "constructor names classified";
});

check("helpers: messages.DeleteChat keeps a basic group id above int32", () => {
  // Basic group ids in a real account exceed 2^31 (seen: 5086304286). If the
  // argument were a 32-bit int the id would truncate, and `messages.DeleteChat`
  // would clear a different chat than the caller named. Asserted on the object
  // gramJS actually builds, since the runtime class exposes no `args` schema.
  const big = 5086304286n;
  const req = new Api.messages.DeleteChat({ chatId: big });
  if (String(req.chatId) !== String(big)) throw new Error(`chatId became ${req.chatId}`);
  if (typeof req.chatId === "number") throw new Error("chatId degraded to a JS number");
  return `chatId preserved as ${String(req.chatId)} (${typeof req.chatId})`;
});

check("helpers: peerIdOf reads every Peer wrapper shape", () => {
  // A channel post carries PeerChannel, which has channelId but no userId — the
  // old `userId ?? peer` fallback stringified the object into "[object Object]".
  const cases = [
    [{ userId: 123 }, "123"],
    [{ channelId: 1234567890n }, "1234567890"],
    [{ chatId: 77 }, "77"],
    [{ id: 9 }, "9"],
    [42, "42"],
    ["-100123", "-100123"],
    [null, null],
    [undefined, null],
  ];
  for (const [input, want] of cases) {
    const got = peerIdOf(input);
    if (got !== want) throw new Error(`peerIdOf(${JSON.stringify(input)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
  return `${cases.length} peer shapes resolved, no "[object Object]"`;
});

check("helpers: shapeMessage never emits a stringified peer object", () => {
  const shaped = shapeMessage({ id: 5, fromId: { channelId: 1234567890n }, message: "hi" });
  if (shaped.senderId !== "1234567890") throw new Error(`senderId was ${JSON.stringify(shaped.senderId)}`);
  if (String(shaped.senderId).includes("object")) throw new Error("senderId still stringifies an object");
  // A message with no fromId at all must be null, not "undefined".
  const anon = shapeMessage({ id: 6, message: "x" });
  if (anon.senderId !== null) throw new Error(`senderId for a sender-less message was ${JSON.stringify(anon.senderId)}`);
  return "channel senderId is numeric, sender-less message is null";
});

check("helpers: shapeMessage carries everything a reader needs", () => {
  // The original contract was "sender, full text, media, replies, views, edit
  // info" — and the first version reported only `entities.length`, no sender
  // name, no reactions, no album id, no comment counters. A message with three
  // links and one with a bold word and a mention both looked like `entities: 3`.
  const raw = {
    id: 42,
    date: 1787000000,
    message: "hello @someone #tag https://example.com",
    fromId: { userId: 111222333n },
    _sender: { className: "User", firstName: "Alex", lastName: "Rivera" },
    postAuthor: "Alex Rivera",
    views: 42,
    forwards: 3,
    editDate: 1787000100,
    groupedId: 14338491830779757n,
    entities: [
      { className: "MessageEntityMention", offset: 6, length: 8 },
      { className: "MessageEntityHashtag", offset: 15, length: 4 },
      { className: "MessageEntityUrl", offset: 20, length: 19 },
    ],
    reactions: { results: [{ reaction: { emoticon: "👍" }, count: 5, chosenOrder: 0 }] },
    replies: { comments: true, replies: 7, maxId: 99, channelId: 333444555n },
    replyTo: { replyToMsgId: 30, replyToTopId: 20, forumTopic: true, quoteText: "quoted bit" },
    media: {
      className: "MessageMediaDocument",
      document: {
        mimeType: "video/mp4",
        size: 1048576,
        attributes: [
          { className: "DocumentAttributeVideo", w: 1280, h: 720, duration: 63 },
          { className: "DocumentAttributeFilename", fileName: "clip.mp4" },
        ],
      },
    },
    fwdFrom: { fromName: "Original", fromId: { channelId: 777888999n }, channelPost: 5, date: 1786000000 },
  };
  const s = shapeMessage(raw);

  const problems = [];
  const need = (cond, msg) => {
    if (!cond) problems.push(msg);
  };

  need(s.senderName === "Alex Rivera", `senderName was ${JSON.stringify(s.senderName)} — the id alone is not a sender`);
  need(s.postAuthor === "Alex Rivera", "postAuthor (channel signature) missing");
  need(s.views === 42, "views missing");
  need(s.forwards === 3, "forwards missing");
  need(s.editDate !== null, "editDate missing");
  need(s.groupedId === "14338491830779757", `groupedId was ${JSON.stringify(s.groupedId)} — albums need it`);
  need(s.comments?.count === 7, `comments.count was ${JSON.stringify(s.comments?.count)} — it used to read the boolean flag and print true`);
  need(s.comments?.isCommentThread === true, "comments.isCommentThread missing");
  need(s.reactions?.total === 5, `reactions.total was ${JSON.stringify(s.reactions?.total)}`);
  need(s.reactions?.items?.[0]?.emoji === "👍", "reaction emoji missing");
  need(s.reactions?.items?.[0]?.chosen === true, "whether this account reacted is missing");
  need(s.reply?.messageId === 30, "reply messageId missing");
  need(s.reply?.topId === 20, "reply topId (forum topic) missing");
  need(s.reply?.quote === "quoted bit", "reply quote missing");
  need(s.forward?.fromName === "Original", "forward origin name missing");
  need(s.forward?.channelPost === 5, "forward channel post missing");
  need(s.media?.mime === "video/mp4", "media mime missing");
  need(s.media?.width === 1280 && s.media?.height === 720, `media dimensions were ${s.media?.width}x${s.media?.height}`);
  need(s.media?.durationSec === 63, `media duration was ${JSON.stringify(s.media?.durationSec)}`);
  need(s.media?.fileName === "clip.mp4", "media fileName missing");
  need(Array.isArray(s.entities) && s.entities.length === 3, "entities are not shaped");
  need(s.entities?.[0]?.type === "mention", `first entity type was ${JSON.stringify(s.entities?.[0]?.type)}`);
  need(s.entities?.[2]?.url === undefined || typeof s.entities?.[2]?.url === "string", "entity url malformed");

  if (problems.length) throw new Error(problems.join("; "));
  return "sender name, reactions, album id, comments, reply quote, media dimensions all present";
});

check("admin: the 'none' preset sets every right to an explicit false", async () => {
  // An empty ChatAdminRights means "change nothing" to Telegram, so demotion built
  // from `{}` reported success while the member stayed an admin. The list also has
  // to match Api.ChatAdminRights exactly: it held 11 entries while the class has
  // 15, so four story/topic rights were left absent and survived a demotion.
  const { adminRights, ALL_ADMIN_RIGHTS } = await load("dist/admin.js");
  const none = adminRights("none");
  const wrong = ALL_ADMIN_RIGHTS.filter((r) => none[r] !== false);
  if (wrong.length) throw new Error(`these rights were not explicitly false: ${wrong.join(", ")}`);
  if (none.postMessages !== false) throw new Error("postMessages was omitted instead of false");

  // Cross-check the list against the runtime class: every declared flag must be
  // covered, otherwise the next API addition silently reintroduces the bug.
  const declared = Object.keys(new Api.ChatAdminRights({})).filter(
    (k) =>
      k !== "flags" &&
      k !== "className" &&
      k !== "classType" &&
      k !== "originalArgs" &&
      k !== "CONSTRUCTOR_ID" &&
      k !== "SUBCLASS_OF_ID",
  );
  const missed = declared.filter((k) => !ALL_ADMIN_RIGHTS.includes(k));
  if (missed.length) throw new Error(`ALL_ADMIN_RIGHTS misses real flags: ${missed.join(", ")}`);

  const moderator = adminRights("moderator");
  if (moderator.deleteMessages !== true) throw new Error("moderator lost deleteMessages");
  if (moderator.postMessages) throw new Error("moderator must not gain postMessages");
  return `${ALL_ADMIN_RIGHTS.length} rights explicitly false on demote, all ${declared.length} declared flags covered`;
});

/* ------------------------------------------- delete / mute honesty (source) */

/**
 * These two bugs were false successes that no offline test caught, because they
 * only appear in what the tool *claims*. The checks below read the source and
 * assert the read-back is still there, so a refactor cannot quietly restore the
 * old "echo the request" shape.
 */
check("delete_messages verifies instead of assuming", () => {
  const src = fs.readFileSync(path.join(root, "messages.ts"), "utf8");
  const start = src.indexOf('"telegram_delete_messages"');
  if (start < 0) throw new Error("telegram_delete_messages not found");
  const body = src.slice(start, start + 3000);
  if (!/getMessages\(/.test(body)) throw new Error("no read-back: unknown ids would report deleted:true again");
  if (!/notFound/.test(body)) throw new Error("result does not distinguish ids that do not exist");
  if (!/stillPresent/.test(body)) throw new Error("result does not report a delete Telegram ignored");
  return "reads ids back before and after the delete";
});

check("mute and pin report the account, not the request", () => {
  const src = fs.readFileSync(path.join(root, "chats.ts"), "utf8");
  for (const [tool, rpc] of [
    ["telegram_mute_chat", "GetNotifySettings"],
    ["telegram_pin_chat", "GetPinnedDialogs"],
  ]) {
    const start = src.indexOf(`"${tool}"`);
    if (start < 0) throw new Error(`${tool} not found`);
    const body = src.slice(start, start + 2600);
    if (!body.includes(rpc)) throw new Error(`${tool} does not read the setting back via ${rpc}`);
    if (!/verified/.test(body)) throw new Error(`${tool} does not say whether the value was verified`);
  }
  return "GetNotifySettings and GetPinnedDialogs are both read back";
});

check("every chat-state write reads its result back", () => {
  // The bug that keeps recurring in this project: Telegram accepts an RPC and
  // does nothing, so the tool echoes the request and calls it success. Each of
  // these four used to do exactly that. The check is source-level on purpose —
  // it catches a future rewrite that drops the read-back, which no single live
  // call would.
  const files = ["chats.ts", "messages.ts"];
  const expected = [
    ["telegram_archive_chat", "GetDialogs", "chats.ts"],
    ["telegram_mark_read", "GetDialogs", "messages.ts"],
    ["telegram_leave_chat", "GetDialogs", "chats.ts"],
    ["telegram_join_chat", "GetParticipant", "chats.ts"],
  ];
  const problems = [];
  for (const [tool, rpc, file] of expected) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    const start = src.indexOf(`"${tool}"`);
    if (start < 0) {
      problems.push(`${tool} not found in ${file}`);
      continue;
    }
    const body = src.slice(start, start + 4000);
    if (!body.includes(rpc)) problems.push(`${tool} never calls ${rpc} to confirm`);
    if (!/verified/.test(body)) problems.push(`${tool} does not report whether it was verified`);
  }
  if (problems.length) throw new Error(problems.join("; "));
  return "archive/mark_read/leave/join all confirm against the account";
});

check("join_chat cannot be used to bypass the allowlist", () => {
  // The invite branch resolves no chat before joining, so it used to skip
  // enforce() entirely — the one chat-taking tool that did. It must now call
  // enforce() after the join and leave again when the allowlist disagrees.
  const src = fs.readFileSync(path.join(root, "chats.ts"), "utf8");
  const start = src.indexOf('"telegram_join_chat"');
  const body = src.slice(start, start + 4000);
  if (!/ImportChatInvite/.test(body)) throw new Error("invite branch is gone");
  const inviteAt = body.indexOf("ImportChatInvite");
  const enforceAt = body.indexOf("enforce(client, resolved)");
  if (enforceAt < 0) throw new Error("join_chat never calls enforce()");
  if (enforceAt < inviteAt) throw new Error("enforce() runs before the join, so it cannot see the joined chat");
  if (!/LeaveChannel/.test(body.slice(enforceAt))) {
    throw new Error("a blocked invite join is not undone");
  }
  return "invite join is checked against the allowlist and rolled back";
});

check("pin_message and react read the message, not the RPC's answer", () => {
  // Both used to answer with the value they asked for. A message knows its own
  // `pinned` flag and its own `reactions`, so both must fetch it.
  const src = fs.readFileSync(path.join(root, "messages.ts"), "utf8");
  for (const [tool, needle] of [
    ["telegram_pin_message", /\.pinned\b/],
    ["telegram_react", /reactions/],
  ]) {
    const start = src.indexOf(`"${tool}"`);
    if (start < 0) throw new Error(`${tool} not found`);
    const body = src.slice(start, start + 2600);
    if (!/getMessages/.test(body)) throw new Error(`${tool} never fetches the message back`);
    if (!needle.test(body)) throw new Error(`${tool} does not inspect the field it claims to change`);
    if (!/verified/.test(body)) throw new Error(`${tool} does not report whether it was verified`);
  }
  return "pin reads .pinned, react reads .reactions, both report verified";
});

check("resolveChat refuses an entity it did not actually match", () => {
  // gramJS falls back to a fuzzy name search for a non-username, non-id string,
  // and that fallback answers the wrong entity: getEntity("Archive") returned a
  // user named "Message". Accepting that silently means an edit, a delete or a
  // message can land on a chat nobody asked for. The guard is source-level
  // because the bug is a missing comparison, not a wrong value.
  const src = fs.readFileSync(path.join(root, "helpers.ts"), "utf8");
  const start = src.indexOf("export async function resolveChat");
  const body = src.slice(start, start + 3000);
  if (!/looksLikeUsername/.test(body)) throw new Error("resolveChat does not check the resolved username against the request");
  if (!/looksLikeId/.test(body)) throw new Error("resolveChat does not recognise a numeric id");
  if (!/entityName !== bare\.toLowerCase\(\)/.test(body)) {
    throw new Error("resolveChat does not compare the resolved entity's name against what was asked for");
  }
  if (!/PEER_ID_INVALID/.test(body)) {
    throw new Error("a guessed entity is not routed into the not-found path, so it would be accepted");
  }
  return "a fuzzy match whose name does not match the request is refused";
});

check("no state-changing tool answers without a read-back", () => {
  // A sweeping guard against the single most repeated bug in this project:
  // Telegram accepts an RPC and does nothing, so echoing the request looks like
  // success. Any tool whose handler returns a bare `ok({ ... })` with no
  // `verified` and no read-back call is suspect.
  //
  // The allowlist is explicit so adding a tool forces a decision here rather
  // than silently widening the gap.
  const READBACK_FREE = new Set([
    // Pure sends: the message id in the response *is* the proof, and the id is
    // read back by the harness immediately (get_message / delete).
    "telegram_send_message",
    "telegram_send_file",
    "telegram_send_photo",
    "telegram_send_poll",
    "telegram_send_location",
    "telegram_send_contact",
    "telegram_forward_messages",
    "telegram_typing",
    "telegram_download_media",
    "telegram_export_history",
    "telegram_export_invite_link",
    "telegram_message_link",
    "telegram_create_group",
    "telegram_create_channel",
    // Reads: nothing to verify.
    "telegram_get_history",
    "telegram_get_message",
    "telegram_search_messages",
    "telegram_search_global",
    "telegram_search_users",
    "telegram_list_chats",
    "telegram_chat_info",
    "telegram_chat_members",
    "telegram_me",
    "telegram_full_user",
    "telegram_status",
    "telegram_doctor",
    "telegram_setup",
    "telegram_list_sessions",
    "telegram_list_blocked",
    "telegram_get_contacts",
    "telegram_pinned_messages",
    "telegram_scheduled_messages",
    "telegram_folders",
    "telegram_common_chats",
    "telegram_user_photos",
    "telegram_chat_admins",
    "telegram_audit_log",
    "telegram_audit_summary",
    "telegram_translate",
    "telegram_permissions",
    "telegram_briefing",
    "telegram_search_intelligence",
    // Local-only or already verified by other means.
    // Local bookkeeping: these read and write state.json, not Telegram, so the
    // record they return *is* the state.
    "telegram_delete_download",
    "telegram_list_downloads",
    "telegram_add_contact",    "telegram_delete_contacts",
    "telegram_delete_messages",
    "telegram_edit_message",
    "telegram_set_my_photo",
    "telegram_set_chat_photo",
    "telegram_promote_admin",
    "telegram_kick_member",
    "telegram_invite_members",
    "telegram_block_user",
    "telegram_logout_session",
    "telegram_clear_history",
    "telegram_delete_chat",
    "telegram_edit_chat",
    "telegram_unpin_all",
    "telegram_mute_chat",
    "telegram_pin_chat",
    "telegram_archive_chat",
    "telegram_mark_read",
    "telegram_leave_chat",
    "telegram_join_chat",
    "telegram_pin_message",
    "telegram_react",
    // Login tools are manual by nature.
    "telegram_login_start",
    "telegram_login_code",
    "telegram_login_password",
    "telegram_login_cancel",
    "telegram_update_profile",
  ]);

  const files = fs.readdirSync(root).filter((f) => f.endsWith(".ts"));
  const seen = new Set();
  for (const file of files) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    for (const m of src.matchAll(/registerTool\(\s*\n?\s*"(telegram_[a-z_]+)"/g)) {
      seen.add(m[1]);
    }
  }
  const undeclared = [...seen].filter((t) => !READBACK_FREE.has(t)).sort();
  if (undeclared.length) {
    throw new Error(
      `these tools are not classified as read-back-free, so it is unknown whether they verify: ${undeclared.join(", ")}`,
    );
  }
  const stale = [...READBACK_FREE].filter((t) => !seen.has(t)).sort();
  if (stale.length) throw new Error(`allowlist names tools that no longer exist: ${stale.join(", ")}`);
  return `${seen.size} tools classified, none unaccounted for`;
});

check("an undeclared argument is refused, never silently dropped", () => {
  // The SDK turns a raw shape into `z.object(shape)`, which *strips* unknown
  // keys. `telegram_full_user` used to advertise `{}` while hardcoding the
  // authorized account, so `{ user: "<someone else>" }` returned the caller's
  // own profile — phone number included — and looked like a success. Silent
  // argument loss is a wrong answer in every tool, so the registry makes every
  // shape strict.
  const registry = fs.readFileSync(path.join(root, "server-registry.ts"), "utf8");
  if (!/\.strict\(\)/.test(registry)) {
    throw new Error("the registry does not mark tool schemas strict, so unknown args are stripped");
  }
  if (!/strictSchema/.test(registry)) {
    throw new Error("no strictSchema helper in the registry");
  }
  // Every registered tool must go through the wrapper, or the guarantee is
  // per-tool again. `server.ts` is the one legitimate place that constructs the
  // McpServer and hands it to `wrapServer`; anything else doing so would be a
  // second, unwrapped server.
  const files = fs.readdirSync(root).filter((f) => f.endsWith(".ts"));
  const builders = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    if (/\bnew McpServer\(/.test(src)) builders.push(file);
  }
  if (builders.length !== 1 || builders[0] !== "server.ts") {
    throw new Error(`expected exactly one McpServer built in server.ts, found: ${builders.join(", ") || "none"}`);
  }
  const serverSrc = fs.readFileSync(path.join(root, "server.ts"), "utf8");
  if (!/wrapServer\(/.test(serverSrc)) {
    throw new Error("server.ts builds the McpServer without wrapping it, so strict schemas never apply");
  }
  return "every tool schema is strict, so a stray argument is an error instead of a silent no-op";
});

check("full_user honours its user argument instead of always reading self", () => {
  // The bug was not that the tool existed, but that it ignored the request and
  // answered about the caller. Reading `getInputEntity("me")` unconditionally is
  // the exact shape of that defect.
  const src = fs.readFileSync(path.join(root, "account.ts"), "utf8");
  const start = src.indexOf('"telegram_full_user"');
  if (start < 0) throw new Error("telegram_full_user is gone");
  const block = src.slice(start, src.indexOf('"telegram_update_profile"', start));
  if (/inputSchema:\s*\{\s*\}/.test(block)) {
    throw new Error("full_user still advertises an empty schema, so `user` would be stripped");
  }
  if (!/\buser\b/.test(block.match(/inputSchema:[^}]*\}/)?.[0] ?? "")) {
    throw new Error("full_user does not declare a user argument");
  }
  if (!/requireChat\(client, user\)/.test(block)) {
    throw new Error("full_user does not resolve the requested user through requireChat (allowlist gate)");
  }
  if (!/isSelf/.test(block)) {
    throw new Error("full_user does not say whether the answer is about the caller");
  }
  // `user: "me"` resolves to a non-null target, so `isSelf: !target` labelled the
  // caller as somebody else. Self is an identity question, answered by comparing
  // ids against getMe(), not by whether an argument was supplied.
  if (/isSelf:\s*!target/.test(block)) {
    throw new Error("full_user derives isSelf from argument presence, so user:\"me\" reports isSelf:false");
  }
  if (!/isSelf:\s*String\([^)]*\)\s*===\s*selfId/.test(block)) {
    throw new Error("full_user does not compare the resolved id against the authorized account");
  }
  return "full_user resolves the requested user, gates it, and labels self vs other by identity";
});

/* --------------------------------------------------------------- access */

check("access: default is full, valid profiles parse, invalid fails closed", () => {
  const fallback = access.readAccessProfile({});
  if (fallback.profile !== "full" || fallback.source !== "default") {
    throw new Error(`default=${JSON.stringify(fallback)}`);
  }
  for (const profile of access.ACCESS_PROFILES) {
    const state = access.readAccessProfile({ TELEGRAM_ACCESS_PROFILE: profile });
    if (state.profile !== profile || state.error) throw new Error(`${profile}: ${JSON.stringify(state)}`);
  }
  const invalid = access.readAccessProfile({ TELEGRAM_ACCESS_PROFILE: "read" });
  if (invalid.profile !== "readonly") throw new Error(`invalid profile did not fail closed: ${invalid.profile}`);
  if (!invalid.error || !/readonly/.test(invalid.error)) throw new Error("invalid profile has no explanation");
  return "full by default, readonly on a typo";
});

check("access: every write is classified into a profile", () => {
  const cases = [
    ["telegram_get_history", { readOnlyHint: true }, "readonly", true],
    ["telegram_login_start", { readOnlyHint: false }, "readonly", true],
    ["telegram_send_message", { readOnlyHint: false }, "messaging", true],
    ["telegram_kick_member", { readOnlyHint: false }, "moderator", true],
    ["telegram_delete_chat", { readOnlyHint: false, destructiveHint: true }, "full", true],
    ["telegram_unclassified_write", { readOnlyHint: false }, "full", false],
  ];
  for (const [name, annotations, required, classified] of cases) {
    const got = access.classifyTool(name, annotations);
    if (got.minimumProfile !== required) throw new Error(`${name}: ${got.minimumProfile}, expected ${required}`);
    if (got.classified !== classified) throw new Error(`${name}: classified=${got.classified}`);
  }
  const deny = access.checkToolAccess("telegram_send_message", { readOnlyHint: false }, "readonly");
  if (deny.allowed) throw new Error("readonly allowed a send");
  if (deny.requiredProfile !== "messaging") throw new Error(`required=${deny.requiredProfile}`);
  if (!/Nothing was sent/.test(deny.hint)) throw new Error("denial does not say nothing happened");
  if (!access.checkToolAccess("telegram_send_message", { readOnlyHint: false }, "messaging").allowed) {
    throw new Error("messaging refused a send");
  }
  if (access.checkToolAccess("telegram_kick_member", { readOnlyHint: false }, "messaging").allowed) {
    throw new Error("messaging allowed a kick");
  }
  if (access.checkToolAccess("telegram_delete_chat", { readOnlyHint: false }, "moderator").allowed) {
    throw new Error("moderator allowed deleting a chat");
  }
  if (!access.checkToolAccess("telegram_delete_chat", { readOnlyHint: false }, "full").allowed) {
    throw new Error("full refused a delete");
  }
  return "6 classifications, denial carries the required profile";
});

/* ------------------------------------------------------------ approvals */

check("approvals: hash is stable, order-independent and one-way", () => {
  const a = approvals.approvalHash({ chat: "@x", messageIds: [1, 2], note: "hi" });
  const b = approvals.approvalHash({ note: "hi", messageIds: [1, 2], chat: "@x" });
  const c = approvals.approvalHash({ note: "hi", messageIds: [1, 3], chat: "@x" });
  if (a !== b) throw new Error("same args in a different key order produced a different hash");
  if (a === c) throw new Error("different args produced the same hash");
  if (!/^[a-f0-9]{64}$/.test(a)) throw new Error(`not a sha256 hex digest: ${a}`);
  return "stable, order-independent, 64 hex chars";
});

check("approvals: pending -> approve -> consume exactly once", () => {
  const tool = "telegram_unit_approval_once";
  const args = { chat: "@unit_once", messageIds: [101] };
  const created = approvals.createApprovalRequest(tool, args);
  if (created.request.status !== "pending") throw new Error(`status=${created.request.status}`);
  const again = approvals.createApprovalRequest(tool, args);
  if (!again.reused || again.request.id !== created.request.id) throw new Error("duplicate request was not reused");
  if (approvals.consumeApproval(tool, args)) throw new Error("consumed an unapproved request");
  approvals.approveRequest(created.request.id);
  const consumed = approvals.consumeApproval(tool, args);
  if (!consumed || consumed.id !== created.request.id) throw new Error("approved request was not consumed");
  if (approvals.consumeApproval(tool, args)) throw new Error("approval was reusable");
  return "reused pending, consumed once";
});

check("approvals: wrong tool or wrong args do not consume the approval", () => {
  const tool = "telegram_unit_approval_match";
  const args = { chat: "@unit_match", messageIds: [202] };
  const created = approvals.createApprovalRequest(tool, args);
  approvals.approveRequest(created.request.id);
  if (approvals.consumeApproval(tool, { chat: "@unit_match", messageIds: [999] })) {
    throw new Error("consumed with different args");
  }
  if (approvals.consumeApproval("telegram_other_tool", args)) throw new Error("consumed for a different tool");
  const consumed = approvals.consumeApproval(tool, args);
  if (!consumed) throw new Error("the real call could not consume its approval");
  return "tool and args are both bound";
});

check("approvals: deny is final and expired requests cannot be approved", () => {
  const denied = approvals.createApprovalRequest("telegram_unit_approval_deny", { chat: "@deny" });
  approvals.denyRequest(denied.request.id);
  let deniedAgain = false;
  try {
    approvals.approveRequest(denied.request.id);
  } catch {
    deniedAgain = true;
  }
  if (!deniedAgain) throw new Error("a denied request could be approved");

  const expiring = approvals.createApprovalRequest("telegram_unit_approval_expired", { chat: "@expired" });
  const file = approvals.approvalsPath();
  const store = JSON.parse(fs.readFileSync(file, "utf8"));
  const record = store.requests.find((item) => item.id === expiring.request.id);
  record.expiresAt = new Date(Date.now() - 60_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
  let expired = false;
  try {
    approvals.approveRequest(expiring.request.id);
  } catch {
    expired = true;
  }
  if (!expired) throw new Error("an expired request could be approved");
  return "deny and expiry are enforced";
});

/* --------------------------------------------------------- workflows */

check("workflow: briefing groups senders, days, media and questions", () => {
  const messages = [
    {
      id: 1,
      date: "2026-10-01T10:00:00.000Z",
      text: "Question one?",
      senderId: "u1",
      senderName: "Alice",
      entities: [{ type: "url", url: "https://example.com/a" }],
    },
    {
      id: 2,
      date: "2026-10-01T10:05:00.000Z",
      text: "Answer",
      senderId: "u2",
      senderName: "Bob",
      replyTo: 1,
    },
    {
      id: 3,
      date: "2026-10-02T09:00:00.000Z",
      text: "Question two?",
      senderId: "u1",
      senderName: "Alice",
      media: { type: "photo" },
      views: 100,
    },
    {
      id: 4,
      date: "2026-10-02T09:05:00.000Z",
      text: "",
      senderId: "u2",
      senderName: "Bob",
      media: { type: "document" },
      views: 50,
    },
  ];
  const briefing = workflow.buildBriefing(messages, { linkFor: (id) => `https://t.me/x/${id}` });
  if (briefing.count !== 4) throw new Error(`count=${briefing.count}`);
  if (briefing.bySender.length !== 2 || briefing.bySender[0].count !== 2) {
    throw new Error(`bySender=${JSON.stringify(briefing.bySender)}`);
  }
  if (briefing.byDay.length !== 2 || briefing.byDay[0].day !== "2026-10-01") {
    throw new Error(`byDay=${JSON.stringify(briefing.byDay)}`);
  }
  if (briefing.media.photo !== 1 || briefing.media.document !== 1) {
    throw new Error(`media=${JSON.stringify(briefing.media)}`);
  }
  if (briefing.questionCandidates.length !== 2) throw new Error("questions not found");
  const answered = briefing.questionCandidates.find((q) => q.id === 1);
  const open = briefing.questionCandidates.find((q) => q.id === 3);
  if (!answered || answered.directReplies !== 1 || answered.noDirectReply) {
    throw new Error(`answered=${JSON.stringify(answered)}`);
  }
  if (!open || open.directReplies !== 0 || !open.noDirectReply) {
    throw new Error(`open=${JSON.stringify(open)}`);
  }
  if (open.link !== "https://t.me/x/3") throw new Error(`link=${open.link}`);
  if (!briefing.links.includes("https://example.com/a")) throw new Error("url entity lost");
  if (briefing.topViewed[0].id !== 3) throw new Error(`topViewed=${JSON.stringify(briefing.topViewed)}`);
  if (briefing.highlights[0].id !== 4) throw new Error("highlights are not newest-first");
  return "2 senders, 2 days, 2 questions, media and links counted";
});

check("workflow: search report groups by sender and chat with a date range", () => {
  const hits = [
    {
      id: 1,
      date: "2026-10-01T10:00:00.000Z",
      text: "invoice",
      senderId: "u1",
      senderName: "Alice",
      chat: { id: "-1001", title: "Finance" },
      media: { type: "photo" },
    },
    {
      id: 2,
      date: "2026-10-03T10:00:00.000Z",
      text: "invoice again",
      senderId: "u1",
      senderName: "Alice",
      chat: { id: "-1001", title: "Finance" },
    },
    {
      id: 3,
      date: "2026-10-02T10:00:00.000Z",
      text: "invoice",
      senderId: "u2",
      senderName: "Bob",
      chat: { id: "-1002", title: "Ops" },
    },
  ];
  const report = workflow.buildSearchReport("invoice", hits);
  if (report.count !== 3) throw new Error(`count=${report.count}`);
  if (report.bySender[0].key !== "u1" || report.bySender[0].count !== 2) {
    throw new Error(`bySender=${JSON.stringify(report.bySender)}`);
  }
  if (report.byChat[0].title !== "Finance" || report.byChat[0].count !== 2) {
    throw new Error(`byChat=${JSON.stringify(report.byChat)}`);
  }
  if (report.media.photo !== 1) throw new Error("media count lost");
  if (report.dateRange.from !== "2026-10-01T10:00:00.000Z" || report.dateRange.to !== "2026-10-03T10:00:00.000Z") {
    throw new Error(`dateRange=${JSON.stringify(report.dateRange)}`);
  }
  return "2 senders, 2 chats, date range and media";
});

/* ----------------------------------------------------------- audit read */

check("audit-read: page filters and summary preserve error codes", () => {
  const file = path.join(sandbox, "audit-read.log");
  const lines = [
    { ts: "2026-10-01T00:00:00.000Z", tool: "alpha", outcome: "ok", args: { chat: "@a" } },
    {
      ts: "2026-10-01T00:01:00.000Z",
      tool: "beta",
      outcome: "error",
      args: {},
      detail: { code: "FLOOD_WAIT" },
    },
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n{bad json\n`);
  const page = auditRead.readAuditPage(file, { limit: 10 });
  if (!page.exists || page.totalLines !== 3 || page.count !== 3) {
    throw new Error(`page=${JSON.stringify({ exists: page.exists, totalLines: page.totalLines, count: page.count })}`);
  }
  if (page.entries[0].tool !== "(unparsable line)") throw new Error("newest-first order or unparsable line changed");
  const onlyErrors = auditRead.readAuditPage(file, { limit: 10, outcome: "error" });
  if (onlyErrors.count !== 1 || onlyErrors.entries[0].tool !== "beta") throw new Error("outcome filter broken");
  const summary = auditRead.summarizeAudit(file);
  if (!summary || summary.calls !== 2 || summary.ok !== 1 || summary.error !== 1) {
    throw new Error(`summary=${JSON.stringify(summary)}`);
  }
  if (summary.unparsableLines !== 1) throw new Error(`unparsable=${summary.unparsableLines}`);
  if (summary.errorsByCode.FLOOD_WAIT !== 1) throw new Error("error code lost");
  return "3 lines, filter, summary and error code";
});

/* ------------------------------------------------------------------ report */

await Promise.all(pending);
fs.rmSync(sandbox, { recursive: true, force: true });

check("the harness scores a protocol refusal as a refusal", () => {
  // Input validation does not arrive as a tool result with isError:true — the
  // SDK answers the JSON-RPC request with an `error` object. The harness read
  // `res.result` (undefined), so the call looked like an empty success. A tool
  // that rejects its arguments could therefore look green, which is precisely
  // the failure the harness exists to catch. Both mistakes are pinned here: the
  // client mapping, and the runner's scoring of a step that asserts a refusal.
  const src = fs.readFileSync(path.join(root, "harness", "mcp-harness.mjs"), "utf8");
  // The mapping, not just the words: `res.error` must be read into a variable
  // and that variable must be the condition that returns a failed result.
  if (!/const rpcError = res\.error/.test(src)) {
    throw new Error("callTool does not read the JSON-RPC error object");
  }
  if (!/if \(rpcError\) \{\s*return \{\s*ok: false,/.test(src)) {
    throw new Error("a protocol error does not return ok:false");
  }
  if (!/text: String\(rpcError\.message/.test(src)) {
    throw new Error("a protocol error's message is not surfaced as the tool text");
  }
  // The runner, not just the flag: a step that asserts a refusal must pass only
  // when the refusal happened *and* matched.
  if (!/const refused = expectedError && !step\.res\.ok && step\.expectError\.test\(step\.res\.text\)/.test(src)) {
    throw new Error("the runner does not verify that an asserted refusal happened and matched");
  }
  if (!/expected this call to be refused, but it succeeded/.test(src)) {
    throw new Error("a scenario step that should have failed but succeeded is not reported");
  }
  if (!/refusal did not match/.test(src)) {
    throw new Error("a refusal whose message does not match is not reported");
  }
  return "a JSON-RPC refusal is a failure, and an asserted refusal is a pass";
});

check("media: a typo in the download cap is not read as 'no cap'", async () => {
  // `Number("1O24")` is NaN and `NaN || 0` is 0, which the download path reads as
  // "no limit". One typo in the environment silently removed the only ceiling on
  // how much this server would pull off the network.
  const saved = process.env.TELEGRAM_MAX_DOWNLOAD_BYTES;
  const fresh = async (value) => {
    if (value === undefined) delete process.env.TELEGRAM_MAX_DOWNLOAD_BYTES;
    else process.env.TELEGRAM_MAX_DOWNLOAD_BYTES = value;
    // A distinct query string forces a fresh module instance so the value is
    // re-read; the module caches it at import time by design.
    const url = pathToFileURL(path.join(root, "dist/media.js"));
    url.search = `?cap=${encodeURIComponent(String(value))}`;
    const mod = await import(url.href);
    return mod.maxDownloadBytes();
  };
  try {
    if (await fresh(undefined) !== 0) throw new Error("an unset cap should mean no cap");
    if (await fresh("") !== 0) throw new Error("an empty cap should mean no cap");
    if (await fresh("1024") !== 1024) throw new Error("a numeric cap was not honoured");
    for (const bad of ["1O24", "1kb", "-5", "ten"]) {
      let threw = false;
      try {
        await fresh(bad);
      } catch (err) {
        threw = /CONFIG_INVALID|not a number/.test(String(err?.message ?? err) + String(err?.code ?? ""));
      }
      if (!threw) throw new Error(`TELEGRAM_MAX_DOWNLOAD_BYTES=${JSON.stringify(bad)} was silently accepted as "no cap"`);
    }
    return "unparseable caps are refused instead of disabling the limit";
  } finally {
    if (saved === undefined) delete process.env.TELEGRAM_MAX_DOWNLOAD_BYTES;
    else process.env.TELEGRAM_MAX_DOWNLOAD_BYTES = saved;
  }
});

check("extras: folder peers are named, not listed as anonymous ids", () => {
  // A folder's peers are a Vector<InputPeer>, and InputPeer* carries an id and an
  // access hash and nothing else. Reading `title`/`firstName`/`username` off the
  // peer returned null for every member, so every folder looked empty of names.
  const src = fs.readFileSync(path.join(root, "extras.ts"), "utf8");
  const start = src.indexOf('"telegram_folders"');
  const body = src.slice(start, start + 4000);
  if (/nameOf\s*\(/.test(body)) {
    throw new Error("the dead nameOf() helper is back — InputPeer has no name fields");
  }
  if (!/getDialogs/.test(body)) {
    throw new Error("folder peers are not resolved against the dialog list, so their names cannot exist");
  }
  if (!/marked: markedId\(e\)/.test(body)) {
    throw new Error("folder peers are not given a marked id, so they cannot be pasted into another tool");
  }
  if (!/unresolved:/.test(body)) {
    throw new Error("a peer that cannot be named does not say so");
  }
  return "folder peers carry a marked id and a real name, or say why not";
});

check("extras: no tool reads a field the reply does not have", () => {
  // messages.translateResult has exactly one field, `result`. `detectedLanguage`
  // was read from it for months and was therefore always null — a key that looked
  // like a measurement and was a constant. Also checked: `p.rights`, which no
  // ChannelParticipant variant has.
  const src = fs.readFileSync(path.join(root, "extras.ts"), "utf8");
  // Strip comments first: the fix is documented in a comment that names the
  // phantom field, and a naive grep would fail on its own explanation.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  if (/detectedLanguage/.test(code)) {
    throw new Error("detectedLanguage is still read from messages.translateResult, which has no such field");
  }
  const adminsAt = src.indexOf('"telegram_chat_admins"');
  const adminsBody = code.slice(adminsAt, adminsAt + 3000);
  if (/adminRights\s*\?\?\s*p\?\.rights/.test(adminsBody)) {
    throw new Error("the dead `?? p?.rights` fallback is back — no ChannelParticipant has `rights`");
  }
  if (!/channelParticipantsNotModified|Array\.isArray\(result\?\.participants\)/.test(adminsBody)) {
    throw new Error("a missing participant list would be reported as zero admins");
  }
  return "translate drops the phantom field, chat_admins refuses an empty reply";
});

check("read-only scenarios run without --write and keep their steps on failure", () => {
  // Two properties, both silent when they break. (1) A `readOnly: true` scenario
  // must run on a plain read-only pass — gating every scenario behind --write
  // meant the pagination check almost never ran. (2) A scenario that returns a
  // failure must keep the steps it collected; throwing made the runner build
  // `steps: []`, so the report showed one opaque FAIL with the evidence gone.
  const src = fs.readFileSync(path.join(root, "harness", "mcp-harness.mjs"), "utf8");
  if (!/if \(!scenario\.readOnly && !WITH_WRITES && !WITH_DESTRUCTIVE\)/.test(src)) {
    throw new Error("scenarios are not gated on readOnly, so read-only scenarios cannot run on a read pass");
  }
  if (!/readOnly: true,/.test(src)) {
    throw new Error("no scenario is marked readOnly");
  }
  if (!/scenario:pagination/.test(src) && !/name: "pagination"/.test(src)) {
    throw new Error("the pagination scenario is gone");
  }
  if (!/const bad = \(reason\) => \(\{ steps, ok: false, reason \}\)/.test(src)) {
    throw new Error("scenarios do not report failures with their steps");
  }
  // A scenario that throws is still caught, but the runner must not silently
  // swallow the reason.
  if (!/result = \{ ok: false, reason: String\(err\.message \?\? err\), steps: \[\] \}/.test(src)) {
    throw new Error("the runner no longer converts a thrown scenario into a reported failure");
  }
  return "read-only scenarios run on every pass and a failed scenario keeps its evidence";
});

check("searches page with a cursor the server actually honours", () => {
  // Telegram's SearchGlobal pages with `offsetRate` (returned as `nextRate`).
  // Accepting offsetId/offsetPeer instead made every page after the first return
  // page one again, unchanged — measured on this account, not assumed. And a
  // tool that cannot tell a full page from an exhausted one gives its caller no
  // way to stop paging.
  const src = fs.readFileSync(path.join(root, "messages.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  const at = code.indexOf('"telegram_search_global"');
  const body = code.slice(at, at + 5000);
  if (/offsetPeer:\s*peer/.test(body) || /offsetPeer: peer/.test(body)) {
    throw new Error("search_global still pages with offsetPeer, which Telegram ignores");
  }
  if (!/offsetRate:\s*offsetRate\s*\?\?\s*0/.test(body)) {
    throw new Error("search_global ignores the caller's offsetRate, so every page repeats page one");
  }
  if (!/nextRate/.test(body)) {
    throw new Error("search_global never reads nextRate, so there is no cursor to continue from");
  }
  if (!/MessageEmpty/.test(body)) {
    throw new Error("MessageEmpty placeholders are reported as readable matches");
  }
  if (!/totalMatches/.test(body)) {
    throw new Error("the server's own match total is not surfaced");
  }
  if (!/skippedRepeat/.test(body)) {
    throw new Error("dropped overlap rows are invisible, so a shorter page looks like a short result");
  }

  for (const [name, key] of [["get_history", "hasMore"], ["search_messages", "hasMore"]]) {
    const a = code.indexOf(`"telegram_${name}"`);
    const b = code.slice(a, a + 1800);
    if (!new RegExp(key).test(b)) {
      throw new Error(`${name} reports no ${key}, so a caller cannot tell a full page from an exhausted history`);
    }
  }
  return "search tools page with the server cursor and say whether anything is left";
});

check("a send that produced no message id is not a delivery", () => {
  // `sent: true` with `messageId: null` told the caller a file had been delivered
  // when the id it needs to read or delete that file was never produced.
  const src = fs.readFileSync(path.join(root, "media.ts"), "utf8");
  for (const tool of ["telegram_send_file", "telegram_send_photo", "telegram_send_location"]) {
    const a = src.indexOf(`"${tool}"`);
    if (a < 0) throw new Error(`${tool} is missing from media.ts`);
    const body = src.slice(a, a + 3200);
    if (!/messageId === null/.test(body) && !/messageId == null/.test(body)) {
      throw new Error(`${tool} still claims success when the reply carries no message id`);
    }
  }
  const loc = src.indexOf('"telegram_send_location"');
  const locBody = src.slice(loc, loc + 3200);
  if (/\.\.\.\(accuracy \?/.test(locBody)) {
    throw new Error("send_location drops accuracy: 0 while still echoing it back as sent");
  }
  return "no send tool reports a delivery it cannot name";
});

check("version: compareVersions orders releases, patches and prereleases", async () => {
  const { compareVersions } = await load("dist/version.js");
  const cases = [
    ["1.0.1", "1.0.0", 1],
    ["1.0.0", "1.0.1", -1],
    ["1.0.0", "1.0.0", 0],
    ["v1.2.0", "1.10.0", -1],
    ["1.10.0", "1.9.9", 1],
    ["2.0.0", "1.99.99", 1],
    ["1.0.0", "1.0.0-beta.1", 1], // a release outranks its own prerelease
    ["1.0.0-beta.1", "1.0.0", -1],
    ["1.0.0-beta.2", "1.0.0-beta.1", 1],
    ["1.0.0+build.5", "1.0.0", 0], // build metadata is ignored
  ];
  for (const [a, b, want] of cases) {
    const got = compareVersions(a, b);
    if (got !== want) throw new Error(`compare(${a}, ${b}) = ${got}, want ${want}`);
  }
  return `${cases.length} orderings`;
});

check("version: SERVER_VERSION matches package.json, so serverInfo cannot drift", async () => {
  const { SERVER_VERSION } = await load("dist/version.js");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (SERVER_VERSION !== pkg.version) {
    throw new Error(`dist says ${SERVER_VERSION}, package.json says ${pkg.version}`);
  }
  return SERVER_VERSION;
});

check("update: TELEGRAM_UPDATE_CHECK=0 disables the registry lookup", async () => {
  const { getUpdateInfo } = await load("dist/update-check.js");
  const before = process.env.TELEGRAM_UPDATE_CHECK;
  process.env.TELEGRAM_UPDATE_CHECK = "0";
  try {
    const info = await getUpdateInfo();
    if (info.source !== "disabled") throw new Error(`source=${info.source}`);
    if (info.updateAvailable) throw new Error("reported an update while disabled");
    return "no outbound request";
  } finally {
    if (before === undefined) delete process.env.TELEGRAM_UPDATE_CHECK;
    else process.env.TELEGRAM_UPDATE_CHECK = before;
  }
});

check("update: a stale cache is ignored, a fresh one is not", async () => {
  const { getUpdateInfo } = await load("dist/update-check.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tgmcp-upd-"));
  const file = path.join(dir, "update-check.json");
  const before = { dir: process.env.TELEGRAM_STATE_DIR, off: process.env.TELEGRAM_UPDATE_CHECK };
  process.env.TELEGRAM_STATE_DIR = dir;
  delete process.env.TELEGRAM_UPDATE_CHECK;
  try {
    // Fresh cache: answered from disk, no network, and the notice is actionable.
    fs.writeFileSync(file, JSON.stringify({ checkedAt: new Date().toISOString(), latest: "9.9.9" }));
    const fresh = await getUpdateInfo({ allowNetwork: false });
    if (fresh.source !== "cache") throw new Error(`fresh source=${fresh.source}`);
    if (fresh.latest !== "9.9.9") throw new Error(`fresh latest=${fresh.latest}`);
    if (!fresh.updateAvailable) throw new Error("a 9.9.9 cache did not read as an available update");

    // Stale cache: must not be trusted, and offline mode must not invent a version.
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify({ checkedAt: old, latest: "9.9.9" }));
    const stale = await getUpdateInfo({ allowNetwork: false });
    if (stale.source === "cache") throw new Error("used a 40-day-old cache");
    if (stale.updateAvailable) throw new Error("reported an update from a stale cache");
    return "24h TTL enforced";
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (before.dir === undefined) delete process.env.TELEGRAM_STATE_DIR;
    else process.env.TELEGRAM_STATE_DIR = before.dir;
    if (before.off === undefined) delete process.env.TELEGRAM_UPDATE_CHECK;
    else process.env.TELEGRAM_UPDATE_CHECK = before.off;
  }
});

check("update: the notice names a command the user can actually run", async () => {
  const { formatNotice } = await load("dist/update-check.js");
  const line = formatNotice({ current: "1.0.0", latest: "1.0.1", updateAvailable: true, source: "cache" });
  if (!line.includes("1.0.0 -> 1.0.1")) throw new Error(`no version transition in: ${line}`);
  if (!line.includes("TELEGRAM_UPDATE_CHECK=0")) throw new Error("the notice offers no way to opt out");
  if (!/npx -y @dikacode\/telegram-mcp@latest|npm install -g @dikacode\/telegram-mcp@latest/.test(line)) {
    throw new Error(`no upgrade command in: ${line}`);
  }
  // stderr only: a line on stdout would corrupt the JSON-RPC stream.
  if (!line.endsWith("\n")) throw new Error("notice is not newline-terminated");
  return line.trim();
});

check("update: the upgrade command matches how this copy was installed", async () => {
  const { detectInstall } = await load("dist/cli/update.js");
  const layout = detectInstall();
  // A dev checkout must be reported as a checkout: `npm i -g` would install a
  // second copy instead of updating this one.
  if (!fs.existsSync(path.join(root, ".git"))) return `no git metadata here, layout=${layout.kind}`;
  if (layout.kind !== "source") throw new Error(`expected "source" for a git checkout, got "${layout.kind}"`);
  if (path.resolve(layout.location) !== path.resolve(root)) {
    throw new Error(`location ${layout.location} is not the package root ${root}`);
  }
  return `detected "${layout.kind}" at ${layout.location}`;
});

check("update: the subcommand answers through the binary, not just its module", async () => {
  const { spawnSync } = await import("node:child_process");
  // Regression guard: update.ts exports main() and guards its own direct
  // invocation, so an import from index.ts used to do nothing at all — the
  // command exited 0 with no output.
  const run = spawnSync(process.execPath, [path.join(root, "dist", "index.js"), "update", "--check"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, TELEGRAM_UPDATE_CHECK_TIMEOUT_MS: "1", TELEGRAM_STATE_DIR: "/tmp/telegram-mcp-unit" },
  });
  if (run.status !== 0) throw new Error(`update --check exited ${run.status}: ${run.stderr}`);
  if (!run.stdout.includes("installed")) throw new Error(`update --check printed no plan: ${JSON.stringify(run.stdout)}`);
  return "binary prints the plan";
});

check("cli: --version and --help answer before the transport starts", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const flag of ["--version", "-v"]) {
    const out = spawnSync(process.execPath, [path.join(root, "dist", "index.js"), flag], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, TELEGRAM_UPDATE_CHECK: "0" },
    });
    if (out.status !== 0) throw new Error(`${flag} exited ${out.status}: ${out.stderr}`);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (out.stdout.trim() !== pkg.version) throw new Error(`${flag} printed "${out.stdout.trim()}"`);
    // Nothing on stdout but the version: a server that booted would emit JSON-RPC.
    if (out.stdout.includes("{")) throw new Error(`${flag} started the server`);
  }
  const help = spawnSync(process.execPath, [path.join(root, "dist", "index.js"), "--help"], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, TELEGRAM_UPDATE_CHECK: "0" },
  });
  if (help.status !== 0) throw new Error(`--help exited ${help.status}: ${help.stderr}`);
  for (const needle of ["Usage:", "--version", "npm install -g"]) {
    if (!help.stdout.includes(needle)) throw new Error(`--help is missing "${needle}"`);
  }
  return "3 flags, no transport";
});

check("cli: an unknown flag still boots the server (MCP clients pass none)", async () => {
  // Guard against the flag parser swallowing a client's arguments: only the
  // four known flags exit, everything else must fall through to serving.
  const src = fs.readFileSync(path.join(root, "index.ts"), "utf8");
  const flags = src.match(/flags\.has\("(-{1,2}[a-z]+)"\)/g) ?? [];
  if (flags.length !== 4) throw new Error(`expected 4 known flags, found ${flags.length}`);
  if (/process\.exit\(/.test(src.slice(src.indexOf("function handleCliFlags"), src.indexOf("async function main")))) {
    throw new Error("handleCliFlags calls process.exit, which would kill a real session");
  }
  return "only --version/-v/--help/-h short-circuit";
});

check("version: an unreadable package.json disables the update notice", async () => {
  // A guessed fallback version would nag every user about a release they may
  // already be running, so the module must recognise that it does not know.
  const src = fs.readFileSync(path.join(root, "version.ts"), "utf8");
  const m = /const FALLBACK_VERSION = "([^"]+)"/.exec(src);
  if (!m) throw new Error("FALLBACK_VERSION is gone");
  const { compareVersions } = await load("dist/version.js");
  // Whatever the fallback is, it must sort *below* any real release, so it can
  // never be mistaken for "already up to date" or for a plausible version.
  if (compareVersions(m[1], "1.0.0") >= 0) {
    throw new Error(`fallback ${m[1]} sorts at or above a real release`);
  }
  const upd = fs.readFileSync(path.join(root, "update-check.ts"), "utf8");
  if (!/VERSION_IS_KNOWN/.test(upd)) throw new Error("update-check ignores VERSION_IS_KNOWN");
  return m[1];
});

const failed = results.filter((r) => r.status === "FAIL");for (const r of results) {
  const icon = r.status === "PASS" ? "✅" : "❌";
  console.log(`${icon} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(`\n${results.length - failed.length}/${results.length} unit checks passed`);
process.exitCode = failed.length ? 1 : 0;
