# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
