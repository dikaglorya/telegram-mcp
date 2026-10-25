# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-10-25

Access profiles, human approval gate, localhost dashboard, MCP prompts/resources, workflow tools, streaming downloads, and hardening.

### Added

- **Access profiles** — `TELEGRAM_ACCESS_PROFILE=readonly|messaging|moderator|full` (default: `full`). Enforced server-side before any Telegram request. Invalid value fails closed to `readonly`.
- **Human approval gate** — `TELEGRAM_APPROVAL_MODE=destructive|writes` (default: `off`). Risky calls return `APPROVAL_REQUIRED` with an `approval_id`. Approve with `telegram-mcp approve <id>` or the dashboard. Denied approvals are final for that exact tool+args.
- **Local control center** — `telegram-mcp dashboard` starts a localhost-only web UI (`127.0.0.1`, random port, token/cookie auth, CSP, CSRF protection). Shows policy, audit log, approval queue, tool catalog.
- **MCP prompts (6)** — `telegram_daily_briefing`, `telegram_summarize_chat`, `telegram_find_open_questions`, `telegram_moderate_group`, `telegram_search_intelligence`, `telegram_safe_send`.
- **MCP resources (4)** — `telegram://status`, `telegram://tools`, `telegram://audit/summary`, `telegram://security-model`.
- **Workflow tools** — `telegram_briefing` (structured chat briefing with per-sender/day activity, question candidates, highlights, links) and `telegram_search_intelligence` (search grouped by person/chat with date range and filters).
- **New CLI commands** — `telegram-mcp dashboard`, `telegram-mcp approvals`, `telegram-mcp approve <id>`, `telegram-mcp deny <id>`.
- **New tool** — `telegram_permissions` reports active profile, approval mode, and which tools are allowed/denied.
- **Streaming downloads** — `telegram_download_media` streams directly to disk (no OOM on large files).
- **MCP Registry metadata** — `server.json` with 2025-12-11 schema, npm identifier `@dikacode/telegram-mcp`.
- **Docs site** — Jekyll site in `docs/` for GitHub Pages.
- **Integrations** — example configs for OpenCode, Claude Code, Codex, Cursor, VS Code, n8n guide.
- **CI hardening** — CodeQL, dependency review, package smoke test, tag-based release with provenance.
- **Test:access harness** — end-to-end verification of profiles and approvals over real MCP stdio.

### Changed

- **Tool count**: 69 → 72 (added `telegram_permissions`, `telegram_briefing`, `telegram_search_intelligence`).
- **Session enumeration** — `telegram_list_sessions` now requires `full` profile (was `readonly`).
- **Config memoization** — `getConfig()` and `loadState()` memoized with mtime invalidation.
- **Approval lock** — exponential backoff (25→200ms), 10s timeout (was 2s), configurable via `TELEGRAM_APPROVAL_LOCK_TIMEOUT_MS`/`TELEGRAM_APPROVAL_LOCK_STALE_MS`. Read-only operations (`listApprovals`) skip write.
- **Secret redaction** — `redact()` caches secrets at startup, never reads session file at call time.
- **Pending login cleanup** — periodic 60s interval discards expired login attempts.
- **Test counts** — 74 → 83 offline unit checks.

### Fixed

- **Audit read filter** — unparsable lines now respect `tool`/`outcome` filters.
- **Denied approval finality** — retrying a denied call returns `APPROVAL_DENIED`, not a new pending request.

### Security

- All new features default to safe/strict behavior (profiles opt-in, approval off by default).
- Dashboard never connects to MTProto; no session/hash/message content exposed.
- Approval hash uses sanitized args (secrets replaced with `[redacted]`).

## [1.0.3] — 2026-10-21

`telegram-mcp update` did nothing when run as `telegram-mcp update`: the
command exited 0 and printed no output. Only the module entrypoint worked, so
the documented form — the one in the README and in `--help` — was the broken
one.

### Fixed

- The dispatcher now calls an exported `main()` when a subcommand module has
  one. `cli/update.ts` guards its own top-level invocation so the unit checks
  can import `detectInstall` without printing a report, and that guard is
  exactly why the dynamic import from `index.ts` had no effect.
- `telegram-mcp update --help` describes `update`. Subcommands own their flags
  now, instead of the server's usage text intercepting `--help` first.
- A unit check runs the real binary and asserts the plan is printed, because
  the previous tests imported the module and never exercised the command.

## [1.0.2] — 2026-10-21

`telegram-mcp update` — upgrading is a command, not a set of instructions to
look up. `1.0.1` told you a newer release existed; it still expected you to
know which npm incantation matched your install.

### Added

- **`telegram-mcp update`** upgrades the running copy. The command is derived
  from the filesystem, not from a flag:
  - a global npm install → `npm install -g @dikacode/telegram-mcp@latest`,
    reusing the prefix it was installed under, so a custom
    `npm i -g --prefix <dir>` is upgraded in place instead of duplicated;
  - a git checkout with an upstream → `git pull --ff-only`, then
    `npm install && npm run build`;
  - an npx run or a project dependency → nothing on disk to change, so it
    prints the restart command instead of mutating someone else's tree.
- **`telegram-mcp update --check`** (alias `--dry-run`) reports the installed
  and available versions and the exact command it *would* run, and installs
  nothing.
- `--help` and the main usage text list the new subcommand.
- A unit check that the detector reports a git checkout as a checkout, so a
  regression cannot quietly turn `update` into a second global install.

### Fixed

- Global detection no longer depends on `npm root -g` alone. That call is
  skipped when npm is not on `PATH` (MCP clients strip it) and it points at
  npm's own prefix, not at a custom `--prefix`. The real path of the running
  file decides.
- `git pull` is only proposed when the checkout actually tracks an upstream.
  A detached HEAD or an upstream-less clone now says so instead of failing
  with git's error.

## [1.0.1] — 2026-10-21

Update path made explicit. `1.0.0` could only be updated by knowing npm's
commands by heart: there was no way to ask the installed copy its version, and
no signal that a newer release existed.

### Added

- **`--version` / `-v`** prints the version and exits, before the stdio
  transport is created. **`--help` / `-h`** prints usage, setup steps and the
  upgrade commands. Both answer on stdout; an MCP session is never started.
  Any other argument still falls through to serving, so a client that passes
  its own flags cannot break the server.
- **Update notice.** After the transport is live, the server asks the registry
  for `dist-tags.latest` and prints one line to stderr when a newer version
  exists, naming the exact upgrade command for the install type in use. The
  request has an 800 ms timeout, is cached for 24 hours under the state dir,
  never blocks startup, and never touches stdout.
- **`TELEGRAM_UPDATE_CHECK`** (`0`/`false`/`no`/`off` disables the lookup) and
  **`TELEGRAM_UPDATE_CHECK_TIMEOUT_MS`** (capped at 10 s).
- **`telegram_doctor` reports the installed version**, and the version of the
  newest release it knows about from the cache. Informational only: an
  available update never flips `healthy` to `false`.

### Changed

- The version now comes from `package.json` at runtime instead of a hand-kept
  constant, so `serverInfo`, `--version` and the published tarball cannot drift
  apart.

### Fixed

- Nothing in `1.0.0` is known to be broken; this release is additive.

## [1.0.0] — 2026-10-21

First public release. A local MCP server for a personal Telegram account, with
69 tools, in-chat login, and no hosted component.

### Added

- **69 MCP tools** covering account info, login, chats, messages, media,
  contacts, groups, channels, administration, sessions and the audit log.
- **Login over MCP.** `telegram_login_start`, `telegram_login_code`,
  `telegram_login_password` and `telegram_login_cancel` let an agent complete a
  login, including two-step verification, without a separate CLI step.
- **Strict input schemas.** Every tool declares its arguments; an undeclared key
  is rejected rather than silently ignored.
- **Read-back verification.** Sends, edits, deletes, pins, mutes, archives,
  reactions, contact changes, profile updates and admin changes are checked
  against Telegram before success is reported.
- **Explicit pagination.** History and in-chat search return `hasMore` and
  `nextOffsetId`; global search returns `nextOffsetRate` and a match total.
- **Media handling.** Download message attachments, send files and photos,
  maintain a local download index, and clean up files and index rows together.
- **Optional allowlist.** `TELEGRAM_ALLOWED_CHATS` restricts every chat-taking
  tool when `TELEGRAM_ALLOW_ALL_CHATS=false`.
- **Audit log.** Every call is recorded with sanitized arguments and an outcome,
  readable through `telegram_audit_log` and `telegram_audit_summary`.
- **Cross-platform launcher.** Linux, macOS and Windows, with `~` expansion and
  no hardcoded paths.
- **End-to-end harness.** Spawns the built server over stdio, runs the complete
  tool catalogue, exercises write round trips, probes the allowlist, and reports
  skipped or throttled checks instead of treating them as passes.

### Reliability

- Channel history clearing uses batched `channels.DeleteMessages`, because
  `channels.DeleteHistory` returns `CHANNEL_INVALID` for every input form in the
  current layer. Clearing is capped at 10,000 messages per call.
- Chat and user resolution no longer falls back to a fuzzy name match. A
  reference must carry the id, username or exact title the caller supplied.
- Channel ids are returned in marked form (`-100…`) so they can be fed back into
  tools and matched by the allowlist.
- Uploads and writes that can succeed without producing the expected artifact
  are verified, not assumed.
- Structured errors carry a stable code, a hint and — for `FLOOD_WAIT` — the
  retry window.

### Security

- The session file is written with mode `0600`; the state directory uses `0700`
  on POSIX. Windows inherits the user-profile ACL.
- `api_hash`, session strings, login codes, 2FA passwords and other secret
  arguments are redacted from audit entries and tool output.
- Login material is held in memory for one call and is never persisted.
- stdout is reserved for MCP JSON-RPC. Stray library output is routed to stderr,
  and the harness fails if a non-JSON line reaches the protocol stream.
- Telegram content is treated as untrusted data: messages and file contents are
  never interpreted as instructions by the server.

### Compatibility

- Node.js 20 and 22 are supported.
- Built and tested on Linux, macOS and Windows.
- Works with any MCP client that can spawn a stdio server, including OpenCode,
  Claude Code, Codex CLI, Cursor, Windsurf and Claude Desktop.

### Known limitations

- This is a user-account client, not the Bot API. Telegram's terms apply, and
  automated behaviour can get an account limited or banned. Keep request rates
  low and avoid bulk messaging.
- Secret chats (end-to-end encrypted) and voice/video calls are not exposed.
- Some operations require administrator rights; reactions in Saved Messages
  require Telegram Premium.
- `telegram_clear_history` removes at most 10,000 messages per call.
- The package is published as `@dikacode/telegram-mcp`; the unscoped name
  `telegram-mcp` belongs to an unrelated project and is not this server.

[1.0.1]: https://github.com/dikaglorya/telegram-mcp/releases/tag/v1.0.1
[1.0.0]: https://github.com/dikaglorya/telegram-mcp/releases/tag/v1.0.0
