# Harness

Tests and drivers that talk to the **built** server (`dist/index.js`) exactly the
way a real MCP client does — JSON-RPC over stdio — plus offline unit checks for
the pure logic. Nothing here is imported by the server; nothing here ships in
the npm package.

> **Build first.** `mcp-harness.mjs` and `login-flow.mjs` load `dist/index.js`,
> so run `npm run build` after any `.ts` change or you are testing stale code.
> (`unit.mjs` imports `dist/*.js` too, for the same reason.)

### Choosing a test chat

The end-to-end cases need a chat the account can read. The default is the public
`@telegram` channel, so a fresh clone can run the read-only pass without any
setup. Set `TELEGRAM_TEST_CHAT` to use your own chat instead:

```bash
TELEGRAM_TEST_CHAT=@your_test_channel npm run test:mcp
```

Chat-edit, invite and creator-refusal scenarios need a chat this account **owns
or administers**, and there is no safe public default. Set
`TELEGRAM_HARNESS_CHAT` to run them; without it those cases are reported as
`SKIPPED`, never guessed:

```bash
TELEGRAM_HARNESS_CHAT=-1001234567890 npm run test:mcp -- --write
```

---

## The three files

### `unit.mjs` — offline unit checks

Pure-logic checks that need no Telegram session and no network:

| Area | What it pins |
|---|---|
| `errors.ts` | RPC code extraction (`FLOOD_WAIT_42` → code + `retryAfterSec`), hints, `NOT_AUTHORIZED` mapping, own-`.code` precedence, Node `ERR_*` not masking Telegram errors |
| `audit.ts` | error codes preserved, but OTP / password / token / `phone_code_hash` / invite hashes redacted |
| `policy.ts` | allowlist beats `allowAllChats`, **exact** title matching, marked channel ids, actionable denial text |
| `helpers.ts` | `markedId()` prefixes (`-100…` channels, `-…` groups, bare users); `peerIdOf()` over every `Peer*` wrapper (a channel post has `channelId`, not `userId`); `shapeMessage()` never emitting a stringified peer |

It points every state/audit/media/export path at a throwaway `mkdtemp` sandbox,
so a run never touches `~/.telegram-mcp`. The sandbox is deleted on exit.

```bash
node harness/unit.mjs
```

### `mcp-harness.mjs` — MCP stdio smoke tests

Spawns `dist/index.js`, does the MCP handshake, calls `tools/list`, then runs
every tool in its `CATALOG` over real JSON-RPC. This is the check that proves a
tool is **reachable from an agent**, not just present in the source.

`CATALOG` is the source of truth for coverage. Every advertised tool must have an
entry, and every entry must correspond to an advertised tool — a mismatch fails
the run (see *Coverage* below).

`kind` decides how a case is judged:

| `kind` | Meaning | Run by default? |
|---|---|---|
| `read` | Safe to call; must succeed and its output must match `expect` | yes |
| `write` | Self-cleaning round trip against `"me"`; **must succeed** | only with `--write` |
| `destructive` | Permanent side effect on the real account | only with `--destructive` / `--all` |
| `manual` | Cannot be fired safely without a human decision — login (sends a real code) and deletes that need a real target | never (reported `SKIPPED`) |
| `expect-error` | Must return `isError` **and** match `expect` | yes |

A `write` case must **succeed**. Accepting a structured error as a pass is how
`telegram_mute_chat` stayed broken: it failed with a clean `[UNKNOWN]` code and
the harness called that green.

### `RATE_LIMITED` is its own status

Telegram throttles the burst of calls a harness fires (a person makes one at a
time), and the answer is a bare `FLOOD`. That is neither a pass nor a defect: the
tool was never verified, and the code never ran. Such a case is reported as
`RATE_LIMITED`, which forces the verdict to `INCOMPLETE_RATE_LIMITED` and a
non-zero exit — calling it green would hide an unverified tool, and calling it a
failure would blame the code for being throttled.

Only cases marked `idempotent` retry automatically, and only after waiting. This
matches the server's own rule: a *lookup* may be retried, but a write is never
replayed because a second `send` can duplicate a message. Today only
`telegram_join_chat` opts in — joining a chat you are already in is a no-op.

Cases keyed `foo__bad` point at tool `foo` (via `tool:`) and cover an error path.
A missing message id is deliberately *not* an error — `telegram_get_message`
returns `{found:false}` — so that case is a `read` pinning the contract, while a
*chat* that does not resolve is the `expect-error` case.

### A write must read its result back
Telegram accepts plenty of calls and does nothing. `contacts.Block`,
`channels.EditBanned`, `channels.EditPhoto`, `folders.EditPeerFolders`,
`messages.ToggleDialogPin` and `channels.LeaveChannel` all answer cheerfully
whether or not the account changed. A tool that echoes its own request therefore
looks correct and lies. This project has paid for that lesson seven times
(`promote_admin`, `kick_member`, `invite_members`, `block_user`, `archive_chat`,
`mark_read`, `leave_chat`).

The rule: every state-changing tool re-reads the state it claims to have changed
and answers `verified: true|false`, plus a plain `reason` when the account kept a
different value. `verified: false` means "the read-back was not possible" and is
never dressed up as success. The harness pins this — the `write` cases for
`telegram_archive_chat` and `telegram_mark_read` match `verified: true` in the
same payload, so a regression that drops the read-back fails the run instead of
passing on a cheerful answer.

### A message must be returned whole

The requirement that shaped this project was explicit: sender, full text, media,
replies, views, edit info — not "just the time and the view count". The first
`shapeMessage` failed it in four ways at once. `entities` was the *number* of
entities (three links and a bold word both read as `3`), `replyTo` collapsed the
reply header into one id, `media` knew a type and a byte size but no dimensions or
duration, and the sender was an id with no name.

The shape now carries `senderName`, `postAuthor`, shaped `entities`, the full
`reply` header (including `topId` for forum topics and any `quote`), `reactions`
with per-emoji counts and whether this account is among the reactors, `comments`
for a channel discussion thread, `forwards`, `groupedId` for albums, `action` for
service messages, and media detail read from the document attributes (dimensions,
duration, performer, title, sticker, poll options, contact card, coordinates).

Two traps live here. `replies.comments` is a **boolean** ("this is a comment
thread"), not a count — the count is `replies.replies`, and reading the flag as
the number printed `count: true`. And `_sender` is already cached on every message
gramJS fetched, so the sender's name costs no extra request; leaving it out was a
choice, not a limitation.

`telegram_get_message__full_shape` pins the key order of the payload, and a unit
check builds a message carrying every field and fails on any that disappears.

### A chat reference must resolve to the chat it names

gramJS falls back to a fuzzy name search when the reference is neither an
`@username` nor a numeric id. That fallback answers the wrong entity: on this
account `getEntity("Archive")` returned a user actually named **"Message"**.
Accepting it would point an edit, a delete or a kick at an unrelated account.

Resolution now demands a real correspondence — matching username, numeric id, or
exact title — and refuses anything else while naming the entity it *did* find, so
the guess is visible instead of inherited. `telegram_chat_info__refuses_a_guess`
pins the refusal.

### A search must be able to page

`get_history` and `search_messages` used to return a page and stop: nothing said
whether more existed, and a full page was indistinguishable from an exhausted
history. Both now answer `hasMore` and `nextOffsetId` — pass that id back as
`offsetId` for the next page. At the documented 100-message ceiling there is no
room for the extra row the tool uses to detect "more", so `hasMore` is `null`
there rather than a guess.

`telegram_search_global` paged by the wrong key. Telegram's `SearchGlobal`
continues from a server cursor, `offsetRate` (returned as `nextRate`); passing
`offsetId` or `offsetPeer` alone returns page one again, unchanged — so the tool
looked like it paged while repeating itself forever. It also repeated rows across
page boundaries, sometimes the previous page's last *two*. The tool now takes the
cursor back, hands it forward, drops the overlap itself and reports it as
`skippedRepeat`, so a shorter page is visible rather than mysterious. `count` is
the page length; `totalMatches` is the server's own total, the only honest answer
to "how many are there". A `MessageEmpty` placeholder (an id and nothing else) is
no longer reported as a readable match, and peers are reported with a marked id
because a bare channel id cannot be resolved by a later process.

#### Scenarios (the success path)

Single calls with `messageId: 0` only ever reach the error branch, so a broken
edit/pin/delete/forward would pass forever. `SCENARIOS` therefore drive real round
trips where each call feeds the next a genuine id, and everything created is
deleted at the end:

| Scenario | Covers |
|---|---|
| `message write lifecycle` | send → edit → read (edit is observed) → react → delete → confirm gone |
| `forward and pin` | send → forward → pin → unpin → delete both |
| `attachment round trip` | send file → send photo → delete both |
| `media senders round trip` | send poll → assert a `messageId` came back → delete → confirm gone; repeat for a contact card and a location |
| `chat lifecycle` *(destructive)* | also proves `telegram_promote_admin`, `telegram_kick_member` and `telegram_chat_admins` — the only place a chat this account owns exists |
| `profile field preservation` | write a `lastName` marker → update `firstName` only → assert the marker survived → restore the original name |
| `download round trip` | find a real attachment → download it → assert the file is non-empty → assert it is indexed → download it again and assert the index did not gain a row → delete the record through `telegram_delete_download` → assert it is gone (the run ends with the index exactly as it began) |
| `chat lifecycle` *(destructive)* | create channel → rename it and read the title back → mint and rotate an invite link → clear its history → promote yourself and assert the read-back says `creator` → assert demoting and kicking the creator are refused → list the admins → delete → repeat for a group |

A scenario marked `destructive` creates something permanent if it fails halfway,
so it only runs with `--destructive` — same rule as a destructive single call.
`chat lifecycle` is the reason: deleting a channel is the most aggressively
flood-limited call in Telegram, and a `--write` run that could not delete what it
created would leave real chats behind.

A step can declare `tolerate` for an account limitation (e.g. reactions on Saved
Messages need Premium). Those report `LIMITED` with a reason instead of failing,
so a real regression is still visible but a non-Premium account does not fail the
run.

A step that Telegram throttled reports `RATE_LIMITED`, and so does the scenario
as a whole — the same rule the single-call cases follow. Without it, one flood in
the middle of a round trip looked like a code defect. When a destructive scenario
is the one throttled, its failure reason names the id it could not delete:

```
RATE_LIMITED scenario:chat lifecycle -> delete_chat failed after telegram_create_group,
  so -1001234567890 was left behind — run --cleanup once any flood wait expires
```

That is the signal to run `npm run cleanup`; it is not a tool bug.

Tools already proven by a scenario are reported `SKIPPED — covered end-to-end by
scenario` rather than re-run with a fake id — and that decision is made **before**
the call, never after (see *Run cleanliness* below). A tool that needs a real
target no scenario can supply is marked `manual` with a reason, so it reports an
honest skip instead of failing by construction.

```bash
node harness/mcp-harness.mjs                      # read-only smoke tests
node harness/mcp-harness.mjs --write              # + self-cleaning write round trips
node harness/mcp-harness.mjs --all                # + destructive tools (real side effects!)
node harness/mcp-harness.mjs --cleanup            # reclaim chats left by earlier runs
node harness/mcp-harness.mjs --json               # machine-readable report
node harness/mcp-harness.mjs --only=telegram_status,telegram_chat_info
node harness/mcp-harness.mjs --doctor             # health check only
node harness/mcp-harness.mjs --policy             # prove the allowlist actually blocks
node harness/mcp-harness.mjs --reclaim            # delete exactly what a crashed run left
node harness/mcp-harness.mjs --timeout=120000     # per-request timeout (ms)
```

#### `--reclaim`

Deletes **exactly** the messages a previous run created and failed to delete. It
does not guess.

The journal (`.harness-journal.json`) records every message id a run creates the
moment the id is known, and drops it again once the run deletes it. A run that is
throttled halfway therefore leaves a precise list, and `--reclaim` deletes only
those ids, only in the chat they were recorded for. An empty journal means there
is nothing to do.

This exists because of a real mistake. A run was throttled after `send_contact`
had already created the message, two attachments were left behind, and a
hand-written "delete recent messages with media" script removed eight messages —
six harness leftovers and two messages that predated the run. The lesson is
that "looks like debris" is not a safe test in a chat the user also writes to.
Now a send is bracketed by a watermark *before* the call, so even a send that
reports `FLOOD` while creating the message is recorded and can be reclaimed
without touching anything else.

```bash
node harness/mcp-harness.mjs --reclaim
node harness/mcp-harness.mjs --reclaim --json
```

Exit code is 0 when the journal is empty or every recorded id was deleted.

#### `--policy`

The allowlist is only as strong as its weakest tool. A tool that resolves its
target by hand instead of through `requireChat()` / `enforce()` will happily
answer for a chat the policy denies — and no other mode can see that, because
they all run with `allowAll`.

This mode starts the server with a one-entry allowlist (`--allow`, default
`@telegram`) and calls **every** chat-taking tool against a chat that is
**not** on it (`--deny`, default `me`). Any answer is a bypass. The probes are
read-only or no-ops by construction, so a bypassed call cannot change anything.

It also reads the live `tools/list` and **fails if any advertised tool with a
`chat` / `user` / `users` / `target` property has no probe**. That matters more
than the probe list itself: two real bypasses (`telegram_user_photos`,
`telegram_common_chats`) were found only because the earlier 7-probe version
happened to include the right tool. A tool added later cannot silently skip this
test now.

This is not hypothetical. `telegram_user_photos` fetched a denied account's
photos while every other tool refused, and `telegram_common_chats` did the same
thing after it — both resolved their target by hand instead of through
`requireChat()` / `enforce()`. A third, `telegram_join_chat`, joined whatever an
invite link pointed at and never asked the allowlist at all; it was invisible
here because its argument is called `target`, not `chat`.
Verified to catch a regression by deleting the `enforce()` call and watching it
report `1 bypass(es)`.

```bash
node harness/mcp-harness.mjs --policy
node harness/mcp-harness.mjs --policy --allow=@somechannel --deny=some_username
node harness/mcp-harness.mjs --policy --json
```

Exit code is 0 only when every probe is refused.

#### Scenarios

Beyond single calls, a scenario drives a multi-step round trip and asserts the
end state, not just that each call returned. The ones that matter:

| Scenario | What it proves |
|---|---|
| message lifecycle | send, edit, read back, delete — the message is gone afterwards |
| forward + pin | forwarding lands in the target chat, pinning is observable |
| attachment round trip | a real file survives a send, `forceDocument` keeps its bytes |
| media senders | polls, contact cards and locations produce a real message id |
| profile round trip | a partial `update_profile` does not erase an untouched field |
| **chat edit + invite** | a channel title changes and is **restored**, an invite link is a real `t.me` URL |
| download round trip | bytes on disk match, then the file and its index row are removed |

Every scenario that changes something restores it in a `finally` block, so a
failed assertion still leaves the account as it was found. A scenario that
creates a real chat is gated behind `--destructive` for the same reason.

#### `--cleanup`

Reclaims chats left behind by a run that died between "create" and "delete", or by
a version of the harness that had no delete tool at all. It is the reason the
account can be brought back to zero debris without opening the Telegram app.

It refuses to guess: only a title matching the harness pattern **exactly**
(`harness`, `[harness] …`) is considered, and anything with a public username is
reported and skipped. Calls are paced (`--pace=2500` by default) and it stops at
the first flood rather than firing the same failure N times — re-run it once the
wait expires.

```bash
node harness/mcp-harness.mjs --cleanup
node harness/mcp-harness.mjs --cleanup --json
node harness/mcp-harness.mjs --cleanup --pace=5000
```

#### `--doctor`

Runs only `telegram_doctor` and gates its exit code on the result, so an agent
has one command to self-diagnose. It prints each check's name, pass flag, and
detail, then a one-line verdict.

```bash
node harness/mcp-harness.mjs --doctor
```

`--doctor --json` emits `{ healthy, checks[], account, serverInfo, ms }`.

#### Coverage

```bash
node harness/mcp-harness.mjs --json | node -e '…'   # read .coverage
```

```json
"coverage": { "advertised": 38, "catalogued": 38, "untested": [], "missing": [] }
```

* `untested` — advertised by the server but absent from `CATALOG`.
* `missing` — in `CATALOG` but no longer advertised.

**Either array being non-empty is a hard failure** (`verdict: "COVERAGE_GAP"`,
exit 1). Coverage is counted in *tool names*, so `foo` and `foo__bad` both count
as covering `foo` and cannot inflate the number.

#### Run cleanliness (the account is the witness)

A `--write` / `--destructive` run records the newest message id in **Saved
Messages** before it starts, and afterwards fails with `__left_no_debris` if any
message newer than that watermark survived.

```json
"cleanliness": { "watermark": 143519, "leftover": 0, "reclaimed": [144716, 144715] }
```

`reclaimed` lists ids the check removed itself. Cleanliness is enforced, not just
reported: whatever survived is deleted through the toolset and re-read, so a run
ends clean even when a tool failed halfway. It reports only what it could not
remove.

This exists because the harness used to lie to itself. The `scenarioVerified`
check sat *after* the tool call, so a case reported as
`SKIPPED — covered end-to-end by scenario` had already sent `"[harness] ping"`
and re-uploaded `/etc/hostname`. Nothing in the report disagreed; the account
did. 42 stray uploads accumulated before anyone noticed.

Two subtler ways the account can disagree with the report, both now handled:

- **A throttled send still sends.** `messages.SendMedia` can create the message
  and *then* answer `FLOOD_WAIT`. The recovery read that looks for what the failed
  call made is throttled in the same burst, so it returned an empty list and the
  harness concluded there was nothing to clean up. `newerThan()` now retries with
  backoff and returns `null` — not `[]` — when every read was throttled, because
  "unknown" and "clean" must not look the same.
- **`get_history` is briefly stale.** Immediately after a send, the read can
  return a list that does not yet include it. That made a scenario sweep report
  `leftover: []` while three messages existed. The final check pauses, and reads
  again after reclaiming.

The rule the check enforces: **never do the work and then decide you were not
going to.** Every skip is now decided before the call, and the only thing that
can confirm a clean run is the account itself.

If a run still reports leftovers, they are listed with their ids and text in
`cleanliness.leftoverMessages`, so the debris can be reclaimed precisely with
`--reclaim` (which deletes only ids in `.harness-journal.json`, never a guess).

#### stdout purity

stdout is the JSON-RPC channel. The harness parses every stdout line and records
anything that is not a JSON-RPC frame — a non-JSON banner, a `console.log` that
escaped `stream-guard.ts`, parseable JSON that is not JSON-RPC, or a truncated
final frame with no newline.

**This is a hard failure**, not a warning: the run appends a synthetic
`(transport)` FAIL case, sets `summary.stdoutPurity: "VIOLATED"`, and exits 1
with `stdout must carry JSON-RPC only`. A real client drops the server on the
first stray line, so a polluted run must never look green.

#### Exit codes

| Code | Meaning |
|---|---|
| `0` | Every executed case passed, coverage complete, stdout pure |
| `1` | A case failed, a coverage gap exists, a retained `RATE_LIMITED` case exists (`INCOMPLETE_RATE_LIMITED`), stdout was polluted, a run left debris behind (`__left_no_debris`), or the server never initialized |
| `3` | `--doctor` only: the server is reachable but reported `healthy:false` |

A rate-limited case exits `1` on purpose: the tool was not verified, so a green
exit would claim something the run never proved. It is reported separately from
`FAIL` because the code never ran — Telegram throttled the burst, it is not a
defect (item 47 in `CHANGELOG.md`).

Exit `3` is deliberately distinct from `1` so an agent can tell "the account
needs fixing" (call `telegram_login_start`) from "the harness/server is broken".

`BLOCKED` (an auth error such as `NO_SESSION`) is not a tool bug; it is reported
once as `verdict: "BLOCKED_BY_AUTH"` and still exits `0`.

### `login-flow.mjs` — interactive login driver

Drives the login the same way an agent would: `telegram_status` →
`telegram_login_start` → prompt for the code → `telegram_login_code` →
(2FA: `telegram_login_password`) → `telegram_status` + `telegram_doctor`.

```bash
node harness/login-flow.mjs                    # prompts for the code
node harness/login-flow.mjs --phone=+15551234567
node harness/login-flow.mjs --code=12345       # non-interactive
node harness/login-flow.mjs --force            # replace a working session
```

#### `--resume` and `--attach`

A pending login — the `phoneCodeHash` and the open `TelegramClient` — lives **in
the memory of the process that called `telegram_login_start`** (`login-tools.ts`
keeps it in a module-level `pending`). A brand-new process cannot resume it: it
has no code hash and no auth key, so it can only start a *fresh* login, which
sends a *new* code.

`--resume` therefore only makes sense against a **still-running** server, which
`--attach` provides:

```bash
MCP_ATTACH_SOCKET=/tmp/tg.sock node harness/login-flow.mjs --attach --resume
node harness/login-flow.mjs --resume --socket=/tmp/tg.sock
```

`--attach` connects with `net.connect()` (Unix domain socket, or a Windows named
pipe path). `--resume` then skips `telegram_login_start` and goes straight to
the code prompt, so a killed process no longer costs the user a new SMS.

> **No attach socket exists by default.** The server wires only
> `StdioServerTransport` (`index.ts`), so it never listens on a socket. `--attach`
> works against whatever is bridging stdio to a socket (a proxy, a supervisor, a
> future `--socket` flag). Without one, `--resume` exits `4` with an explanation
> rather than hanging on a prompt that could never complete.

`--resume` detects a live pending login without consuming it: it calls
`telegram_login_code` with a non-digit payload, which the server rejects at the
`needPending()` gate (`"must contain digits"` = pending, `"No login in progress"`
= not). No code is spent and nothing is sent to Telegram.

#### Exit codes

| Code | Meaning |
|---|---|
| `0` | Logged in (or already was) and `telegram_status` confirms it |
| `1` | Login failed — server error, rejected code, or unexpected reply |
| `2` | A human step is needed but was not supplied (no code / no phone), or `--resume` found no pending login |
| `4` | `--resume` / `--attach` misconfigured: no socket given, or the socket could not be reached |

---

## ⚠️ Flags that touch the real account

`--write` is safe by default: every write case runs against **your own** "me"
chat and deletes what it created, so the account ends a run exactly as it started.
`--destructive` (implied by `--all`) is the one that leaves debris.

| Flag | Effect on the real account |
|---|---|
| `--write` | Sends/edits/forwards/pins/deletes messages **in "me" only**, then cleans up. Reacts to one existing channel message. Unmutes "me". Temporarily sets a `lastName` marker on your profile and restores it. Downloads one attachment and removes the file. |
| `--destructive` / `--all` | Additionally **joins** `@telegram`, **re-saves** an existing contact under the name it already has (no visible change), and **creates then deletes** a group and a channel. The chat lifecycle is the only part that can leave debris, and only if Telegram refuses the delete — it names the leftover id when that happens. |

The bio is **not** rewritten by any run. The old catalog did that, and it silently
replaced a real bio with the word `harness`; the fallback args are a no-op patch
now, and the real coverage is the self-restoring profile scenario.

Run `--destructive` only on an account you own and do not mind mutating. Never in
CI against a real account. `--write` is intentionally **not** part of `npm test`.

`login-flow.mjs` sends a **real login code** to a real phone via
`telegram_login_start`. Do not run it in a loop or on someone else's number.

---

## npm scripts

| Script | Command | Sends real messages? |
|---|---|---|
| `npm run test:unit` | `node harness/unit.mjs` | no |
| `npm test` | build + `node harness/unit.mjs` | no |
| `npm run test:mcp` | `node harness/mcp-harness.mjs` | no |
| `npm run test:mcp:write` | `node harness/mcp-harness.mjs --write` | yes, to "me" only (cleaned up) |
| `npm run test:all` | build + unit + `--write` | yes, to "me" only (cleaned up) |
| `npm run test:destructive` | build + `node harness/mcp-harness.mjs --all` | **YES**, creates chats (deleted again) |
| `npm run cleanup` | `node harness/mcp-harness.mjs --cleanup` | **YES**, deletes harness-titled chats |
| `npm run test:policy` | `node harness/mcp-harness.mjs --policy` | no (read-only probes against a denied chat) |
| `npm run test:reclaim` | `node harness/mcp-harness.mjs --reclaim` | **YES**, deletes only ids journaled by a crashed run |
| `npm run test:login` / `login:flow` | `node harness/login-flow.mjs` | **YES** (sends a login code) |

## Typical run

```bash
npm run build
node harness/unit.mjs                  # offline logic
node harness/mcp-harness.mjs --doctor  # is the account healthy?
node harness/mcp-harness.mjs           # are the read tools reachable?
```

When `--doctor` exits `3` or the harness reports `BLOCKED_BY_AUTH`, the fix is a
login — not a terminal session. From an agent: `telegram_login_start` →
`telegram_login_code` (→ `telegram_login_password`).
