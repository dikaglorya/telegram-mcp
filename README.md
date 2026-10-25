<p align="center">
  <img src="https://raw.githubusercontent.com/dikaglorya/telegram-mcp/main/assets/icon.svg" width="116" height="116" alt="telegram-mcp icon">
</p>

<h1 align="center">telegram-mcp</h1>

<p align="center">
  <strong>Your Telegram account, exposed as an MCP server.</strong><br>
  Read, send, search and manage Telegram from the agent you already use — over MTProto, on your own machine.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dikacode/telegram-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@dikacode/telegram-mcp?style=flat-square&color=5eead4&label=npm"></a>
  <a href="https://github.com/dikaglorya/telegram-mcp/actions/workflows/ci.yml"><img alt="ci" src="https://github.com/dikaglorya/telegram-mcp/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A5%2020-0ea5e9?style=flat-square">
  <img alt="tools" src="https://img.shields.io/badge/tools-72-a78bfa?style=flat-square">
  <img alt="transport" src="https://img.shields.io/badge/transport-stdio-38bdf8?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square">
  <a href="https://github.com/dikaglorya/telegram-mcp/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/dikaglorya/telegram-mcp?style=flat-square&color=f59e0b"></a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/dikaglorya/telegram-mcp/main/assets/hero.svg" width="100%" alt="Animated banner: a floating isometric server stack with an orbiting paper plane over a perspective grid">
</p>

---

## Why this one

Most Telegram integrations give a bot a token. A bot only sees the chats it was added to, cannot read your history, and can never act as you. This project connects an agent to **your account** instead, so its tools operate on the chats, contacts and messages you already have.

- **Full account access.** 72 tools spanning messages, chats, media, contacts, admin actions, session management, briefings, and search intelligence.
- **Login without a terminal step.** Credentials can be written by `telegram_setup`, and the first login happens entirely inside the chat — code and two-step password included.
- **Access profiles.** `TELEGRAM_ACCESS_PROFILE=readonly|messaging|moderator|full` limits which operations the server allows before any Telegram request.
- **Human approval gate.** `TELEGRAM_APPROVAL_MODE=destructive|writes` turns risky calls into one-shot approvals granted out-of-band (CLI or localhost dashboard).
- **Local control center.** `telegram-mcp dashboard` — a localhost-only web UI for policy, audit, approvals and tool catalog.
- **MCP prompts & resources.** 6 prompts and 4 resources (`telegram://status`, `telegram://tools`, `telegram://audit/summary`, `telegram://security-model`) for clients that support them.
- **Workflow tools.** `telegram_briefing` and `telegram_search_intelligence` compose low-level verbs into high-level tasks.
- **One local process.** stdio transport, no listening port, no cloud relay, no telemetry.
- **Cross-platform.** Linux, macOS and Windows. Paths are resolved with `path`; POSIX permissions go through a shim that is a no-op on Windows.
- **Honest answers.** Every state-changing tool reads the result back before reporting success. If Telegram accepted a call and ignored it, the tool tells you that instead of echoing the request.

| | |
| --- | --- |
| Tools | **72** |
| Transport | **stdio** (Model Context Protocol) |
| Telegram API | **MTProto**, through [GramJS](https://github.com/gram-js/gramjs) |
| Runtime | **Node.js ≥ 20** |
| Package | **`@dikacode/telegram-mcp`** on npm |
| State | `~/.telegram-mcp/` — session file `0600`, state dir `0700` |
| Network | outbound to Telegram only; **no inbound port** |
| Test suite | **83** offline unit checks |

## Quick start

<p align="center">
  <img src="https://raw.githubusercontent.com/dikaglorya/telegram-mcp/main/assets/terminal.svg" width="100%" alt="Animated terminal: clone the repository, install, add credentials, and start the server">
</p>

```bash
npx -y @dikacode/telegram-mcp
```

That starts the server on stdio. In normal use you don't run it by hand: your MCP client spawns it. Add the server with one of the snippets in [Connect your agent](#connect-your-agent), restart the client, then ask the agent to log in.

If you would rather run from a checkout:

```bash
git clone https://github.com/dikaglorya/telegram-mcp.git
cd telegram-mcp
npm install
npm run build
cp .env.example .env
# add TELEGRAM_API_ID and TELEGRAM_API_HASH from my.telegram.org/apps
npm start
```

The server speaks MCP over stdio, so the last command is only a manual check. The code and the two-step password are typed in chat, never in a terminal.

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Install](#install)
- [Updating](#updating)
- [Credentials](#credentials)
- [First login — from chat](#first-login--from-chat)
- [Access profiles & human approval](#access-profiles--human-approval)
- [Local control center](#local-control-center)
- [MCP prompts & resources](#mcp-prompts--resources)
- [Workflow tools](#workflow-tools)
- [Connect your agent](#connect-your-agent)
- [Tools](#tools)
- [Security model](#security-model)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Project layout](#project-layout)
- [Release](#release)
- [Reporting a bug](#reporting-a-bug)
- [Contributing](#contributing)
- [License](#license)
- [Contributors](#contributors)

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/dikaglorya/telegram-mcp/main/assets/flow.svg" width="100%" alt="Animated diagram: agent to MCP server over JSON-RPC/stdio, MCP server to Telegram over MTProto">
</p>

The agent spawns `telegram-mcp` as a child process and speaks JSON-RPC over stdin/stdout. The server holds one MTProto connection, signs in with a saved session, and translates each tool call into Telegram API requests. Nothing is exposed to the network: if the agent is not running, the server is not running.

```
agent  ── JSON-RPC / stdio ──▶  telegram-mcp  ── MTProto ──▶  Telegram
                                      │
                                      ├── ~/.telegram-mcp/session.txt   (0600)
                                      ├── ~/.telegram-mcp/audit.log     (redacted)
                                      ├── ~/.telegram-mcp/approvals.json (0600)
                                      ├── ~/.telegram-mcp/media/
                                      └── ~/.telegram-mcp/exports/
```

Three properties are deliberate:

1. **The session file is the credential.** It is written with mode `0600` and never returned by a tool. The api_hash is only used to create that session.
2. **Tool output is data.** Message text, names and files come from other people. The server labels untrusted content and never treats it as instructions; an agent should do the same.
3. **Policy is enforced, not suggested.** Access profiles and approvals are checked by the server before any Telegram request. An agent that hits `PERMISSION_DENIED` or `APPROVAL_REQUIRED` must tell the user — it cannot bypass the gate.

## Requirements

- **Node.js 20 or newer** (22 LTS recommended).
- A **Telegram account** you can log into on your phone.
- An **api_id** and **api_hash** from [my.telegram.org/apps](https://my.telegram.org/apps). This is a one-time, free registration of a Telegram application.
- A supported MCP client: OpenCode, Claude Code, Codex CLI, Cursor, Windsurf, Claude Desktop, or anything that can spawn a stdio MCP server.

## Install

Pick one path. All of them end with a `telegram-mcp` process that speaks MCP over stdio.

### 1. From npm

The package ships compiled JavaScript, so there is no build step and no compiler on your machine.

```bash
npx -y @dikacode/telegram-mcp
```

Or install it once, globally:

```bash
npm install -g @dikacode/telegram-mcp
telegram-mcp
```

`npx` is the shortest thing to put in an MCP client config:

```json
{
  "command": "npx",
  "args": ["-y", "@dikacode/telegram-mcp"]
}
```

Pin a version if you want reproducible installs: `npx -y @dikacode/telegram-mcp@1.1.0`.

### 2. Clone and link

Best if you want to read the code, pin a commit, or modify a tool.

```bash
git clone https://github.com/dikaglorya/telegram-mcp.git
cd telegram-mcp
npm install          # also runs the build
npm link             # optional: makes `telegram-mcp` available on PATH
```

`npm install` runs the `prepare` script, which compiles `dist/`. If you edit the TypeScript later, run `npm run build` again.

### 3. Release tarball

Download the tarball attached to the latest release and install it globally:

```bash
npm install -g https://github.com/dikaglorya/telegram-mcp/releases/download/v1.1.0/dikacode-telegram-mcp-1.1.0.tgz
telegram-mcp
```

The release tarball already contains the compiled `dist/`, so no build step is needed.

### 4. Unreleased commit from GitHub

Useful when you want a fix that has landed on `main` but is not in an npm release yet.

```bash
npx -y github:dikaglorya/telegram-mcp
```

npm fetches the repository, installs dependencies, runs the `prepare` build, and starts the launcher.

## Updating

One command, whichever way it was installed:

```bash
telegram-mcp update
```

It works out how *this* copy got here and runs the right thing — `npm install
-g @latest` for a global install (reusing a custom `--prefix`), `git pull
--ff-only` plus a rebuild for a checkout, and a plain restart instruction for an
npx run, where nothing on disk needs changing. `--check` reports and installs
nothing.

```text
telegram-mcp 1.1.0 · update

  installed   1.0.3  /home/you/.local/lib/node_modules/@dikacode/telegram-mcp
  latest      1.1.0
  install     global npm package

  ▲ 1.0.3 -> 1.1.0 available
```

| Installed with | Behaviour |
| --- | --- |
| `npx -y @dikacode/telegram-mcp` (unpinned) | **Automatic.** npm resolves `latest` on every start, so the next client restart picks up a new release. |
| `npx -y @dikacode/telegram-mcp@1.1.0` (pinned) | **Never.** That is the point of pinning. |
| `npm install -g @dikacode/telegram-mcp` | **`telegram-mcp update`**, or `npm update -g @dikacode/telegram-mcp`. |
| Release tarball | **Manual.** Reinstall from the newer tarball. |
| `npx -y github:dikaglorya/telegram-mcp` | **Not automatic.** npm caches the fetched repo; clear the cache or pin a ref (`#main`) to move forward. |

Check what you are running:

```bash
telegram-mcp --version
telegram-mcp update --check                 # newer release available? installs nothing
npm outdated -g @dikacode/telegram-mcp      # global installs only
```

The server also tells you. When a newer release exists it prints one line to
stderr at startup, after the MCP transport is already serving:

```
[telegram-mcp] update available: 1.0.3 -> 1.1.0. Run `npm install -g @dikacode/telegram-mcp@latest`, or set TELEGRAM_UPDATE_CHECK=0 to silence this.
```

That check is a single request to the npm registry with an 800 ms timeout,
cached for 24 hours, and it never blocks startup or writes to stdout. If you
want zero outbound traffic that is not Telegram itself, set
`TELEGRAM_UPDATE_CHECK=0`. `telegram_doctor` shows the version it knows about
without touching the network.

## Credentials

1. Open [my.telegram.org/apps](https://my.telegram.org/apps) and log in with your phone number.
2. Create an application if you do not have one. Any title and short name will do; platform can be *Desktop*.
3. Copy the **api_id** (a number) and **api_hash** (32 hex characters).

There are two ways to give them to the server.

**A. Let the agent write them.** If your MCP client already starts the server, ask the agent to call `telegram_setup` with the two values. The tool writes a `.env` next to the installed package, preserves any other keys already there, and never returns the hash.

```json
{ "apiId": "1234567", "apiHash": "0123456789abcdef0123456789abcdef", "allowAllChats": true }
```

**B. Pass them in the client config.** This is the most reliable option for `npx`, because the npm cache can be replaced. Put them in the `env` / `environment` block of your MCP client — see the snippets below.

Never paste an api_hash into a chat message, an issue, or a screenshot. If one leaks, revoke the application on my.telegram.org and create a new one.

## First login — from chat

You don't have to run a login command or answer a terminal prompt. The server starts unauthenticated, and the first tool call returns a structured `NOT_AUTHORIZED` error. The agent then drives the login:

1. `telegram_login_start` — sends a login code to your Telegram app. Pass `phone` in international format (or set `TELEGRAM_PHONE` beforehand).
2. `telegram_login_code` — you type the code to the agent in chat; the agent passes it to this tool.
3. `telegram_login_password` — only if two-step verification is enabled. Same rule: type it in chat, and the server will not echo or store it beyond the login.
4. The session is written to `~/.telegram-mcp/session.txt` with mode `0600`. Later runs skip the login entirely.

`telegram_login_cancel` abandons a half-finished login and forgets the code. Login codes and 2FA passwords are stripped from the audit log before they are written.

> The server holds a code or password only for the duration of one call, but the agent's chat transcript is outside this project's control. If you would rather not put a 2FA password in that transcript, run `npm run login` in a terminal instead.

> **Windows:** the session still lives under your user profile. NTFS inherits the profile ACL; the POSIX `0600` call is a documented no-op.

## Access profiles & human approval

### Access profiles

Set `TELEGRAM_ACCESS_PROFILE` in the MCP client environment to opt into a narrower profile. The default is `full`, so upgrading never silently removes a capability.

| Profile | Description | Allows |
| --- | --- | --- |
| `readonly` | Read-only: reads, searches, downloads nothing; no Telegram writes. | All `readOnlyHint:true` tools + login/auth tools |
| `messaging` | Messaging: read, send, edit, react, forward and local media operations. | `readonly` + `telegram_send_message`, `telegram_send_photo`, `telegram_edit_message`, `telegram_react`, `telegram_forward_messages`, `telegram_pin_message`, `telegram_mark_read`, `telegram_typing`, `telegram_archive_chat`, `telegram_mute_chat`, `telegram_pin_chat`, `telegram_download_media`, `telegram_delete_download`, `telegram_export_history` |
| `moderator` | Moderator: messaging plus group/channel administration and moderation. | `messaging` + `telegram_invite_members`, `telegram_promote_admin`, `telegram_kick_member`, `telegram_set_chat_photo`, `telegram_create_group`, `telegram_create_channel`, `telegram_edit_chat`, `telegram_export_invite_link`, `telegram_delete_messages`, `telegram_join_chat`, `telegram_leave_chat` |
| `full` | Full: every tool the account itself is allowed to use. | All 72 tools including `telegram_setup`, `telegram_update_profile`, `telegram_set_my_photo`, `telegram_add_contact`, `telegram_delete_contacts`, `telegram_block_user`, `telegram_delete_chat`, `telegram_clear_history`, `telegram_logout_session` |

An invalid value fails closed to `readonly` and carries an explanation in `telegram_permissions` and `telegram_doctor`.

### Human approval gate

Set `TELEGRAM_APPROVAL_MODE` to enable a one-shot approval step for risky calls. The server checks this *before* any Telegram request.

| Mode | When it triggers |
| --- | --- |
| `off` | Never (default) |
| `destructive` | Tools with `destructiveHint:true` (deletes, revokes, destructive admin actions) |
| `writes` | Any tool that is not `readOnlyHint:true` (sends, edits, forwards, admin, media, contacts) |

Flow:

1. Agent calls a write tool while approval mode is enabled.
2. Server hashes tool + canonical arguments, finds no approved record, stores a pending request, and returns `APPROVAL_REQUIRED` with an `approval_id`.
3. Human runs `telegram-mcp approve <id>` (or clicks Approve in the local dashboard).
4. Agent retries the **exact same call**; server consumes the approval once and executes it.

Approval records live in `<state dir>/approvals.json` (0600). Secret arguments are sanitized before storage; the hash is one-way (SHA-256). One approval = one execution. Denied approvals are final for that exact tool+arguments combination.

Optional TTL: `TELEGRAM_APPROVAL_TTL_SECONDS` (default 600, range 30–86400).

### Quick reference

```bash
# Check current policy
telegram-mcp approvals

# Approve one exact call
telegram-mcp approve <approval-id>

# Deny one call (final for these exact args)
telegram-mcp deny <approval-id>

# Open the localhost dashboard
telegram-mcp dashboard
```

## Local control center

`telegram-mcp dashboard` starts a localhost-only web server (`127.0.0.1`, random port) with a token-protected UI. It shows:

- **Overview**: access profile, approval mode, session presence, audit summary, pending approvals
- **Approvals**: pending requests with one-click Approve/Deny
- **Audit log**: filterable, paginated call log with outcome and error codes
- **Tools**: complete catalog with access profile, read-only/destructive hints

Security:

- Binds to `127.0.0.1` only, never `0.0.0.0`
- Random 192-bit token, exchanged for `HttpOnly; SameSite=Strict` cookie (token removed from URL)
- Host header allowlist (DNS-rebinding defence)
- Strict CSP, no external assets, no CORS
- POSTs require `X-Requested-With: telegram-mcp-dashboard` header (CSRF defence)
- No session string, api_hash, or message content is returned by the API

```bash
# Default: random port, random token, prints one-time URL
telegram-mcp dashboard

# Fixed port / token (useful for scripts)
telegram-mcp dashboard --port 8787 --token my-secret-token-16chars

# Environment variables
TELEGRAM_DASHBOARD_PORT=8787
TELEGRAM_DASHBOARD_TOKEN=my-secret-token-16chars
```

The dashboard never opens an MTProto connection — live authorization checks stay in `telegram_doctor`.

## MCP prompts & resources

The server registers 6 prompts and 4 resources for clients that support them (Claude Desktop, Cursor, etc.).

### Prompts

| Prompt | Purpose |
| --- | --- |
| `telegram_daily_briefing` | Turn selected chats into a sourced daily briefing with open questions and follow-ups. |
| `telegram_summarize_chat` | Read a chat and produce a structured summary with decisions, questions and links. |
| `telegram_find_open_questions` | Find questions in a group that have no direct reply, without overstating certainty. |
| `telegram_moderate_group` | Inspect a group, propose moderation actions, and require confirmation before acting. |
| `telegram_search_intelligence` | Answer a question from Telegram history, grouped by person and chat with citations. |
| `telegram_safe_send` | Preview a message, get explicit confirmation, then send and verify it. |

### Resources

| URI | Type | Description |
| --- | --- | --- |
| `telegram://status` | `application/json` | Version, config presence, session presence, access profile, approval mode. No secrets. |
| `telegram://tools` | `application/json` | Every registered tool with title, access profile, read-only/destructive hints. |
| `telegram://audit/summary` | `application/json` | Counts per tool and outcome from the local audit log. Nothing read from Telegram. |
| `telegram://security-model` | `text/markdown` | The enforced transport, credential, policy, approval and untrusted-input rules. |

## Workflow tools

Two high-level tools compose the same policy checks, message shaping and read-back rules as the low-level verbs.

### `telegram_briefing`

Read one or more chats and return a structured briefing:

- Activity per sender and per day
- Media counts (photos, documents, videos, etc.)
- Question candidates with whether they got a direct reply
- Recent highlights with links
- Most-viewed posts (channels)
- Extracted URLs

```json
{
  "chats": ["@channel", "groupname"],
  "limit": 50,
  "since": "2026-10-01T00:00:00Z",
  "includeMessages": false
}
```

### `telegram_search_intelligence`

Full-text search across selected chats (or every chat), grouped by person and chat:

- Matching messages with chat context
- Results grouped by sender and by chat
- Date range and media counts
- Optional filters: `from` (sender substring), `mediaType`, `minDate`/`maxDate` (unix seconds)

```json
{
  "query": "quarterly budget",
  "chats": ["@finance", "@ops"],
  "limit": 20,
  "from": "alex",
  "mediaType": "document",
  "minDate": 1727740800,
  "maxDate": 1727827200
}
```

Both tools are `readOnlyHint:true`, policy-checked, and limited to 10 chats × 100 messages per call.

## Connect your agent

The server is the same in every client; only the wrapper differs. Use the `npx` form unless you cloned the repository, in which case replace the command with `node /absolute/path/to/telegram-mcp/dist/index.js`.

### OpenCode

`opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "telegram": {
      "type": "local",
      "command": ["npx", "-y", "@dikacode/telegram-mcp"],
      "environment": {
        "TELEGRAM_API_ID": "1234567",
        "TELEGRAM_API_HASH": "0123456789abcdef0123456789abcdef",
        "TELEGRAM_ACCESS_PROFILE": "full",
        "TELEGRAM_APPROVAL_MODE": "destructive"
      },
      "enabled": true
    }
  }
}
```

### Claude Code

```bash
claude mcp add telegram \
  -e TELEGRAM_API_ID=1234567 \
  -e TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef \
  -e TELEGRAM_ACCESS_PROFILE=full \
  -e TELEGRAM_APPROVAL_MODE=destructive \
  -- npx -y @dikacode/telegram-mcp
```

Or commit a project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "npx",
      "args": ["-y", "@dikacode/telegram-mcp"],
      "env": {
        "TELEGRAM_API_ID": "1234567",
        "TELEGRAM_API_HASH": "0123456789abcdef0123456789abcdef",
        "TELEGRAM_ACCESS_PROFILE": "full",
        "TELEGRAM_APPROVAL_MODE": "destructive"
      }
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.telegram]
command = "npx"
args = ["-y", "@dikacode/telegram-mcp"]

[mcp_servers.telegram.env]
TELEGRAM_API_ID = "1234567"
TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef"
TELEGRAM_ACCESS_PROFILE = "full"
TELEGRAM_APPROVAL_MODE = "destructive"
```

### Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "npx",
      "args": ["-y", "@dikacode/telegram-mcp"],
      "env": {
        "TELEGRAM_API_ID": "1234567",
        "TELEGRAM_API_HASH": "0123456789abcdef0123456789abcdef",
        "TELEGRAM_ACCESS_PROFILE": "full",
        "TELEGRAM_APPROVAL_MODE": "destructive"
      }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json` uses the same `mcpServers` shape as Cursor.

### Claude Desktop

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Use the same `mcpServers` JSON as above, then restart the app.

### Anything else

The contract is small: spawn a process, speak MCP JSON-RPC over stdio, pass the two required environment variables. If your client supports stdio MCP servers, it supports this one.

<p align="center">
  <img src="https://raw.githubusercontent.com/dikaglorya/telegram-mcp/main/assets/divider.svg" width="100%" alt="">
</p>

## Tools

Every tool is strict about its arguments: an undeclared key is rejected instead of silently dropped, so a typo can never make a tool answer about the wrong chat. Names are stable; the table is the full list.

### Account & session

| Tool | What it does | Profile |
| --- | --- | --- |
| `telegram_status` | Connection, authorization and a summary of the signed-in account. | readonly |
| `telegram_me` | Your own profile: id, names, username, phone, Premium. | readonly |
| `telegram_full_user` | Every non-secret field of one user; defaults to you. | readonly |
| `telegram_update_profile` | Change your first/last name or bio. | full |
| `telegram_user_photos` | Profile photos of any user, with downloadable references. | readonly |
| `telegram_set_my_photo` | Set or remove your own profile photo. | full |
| `telegram_list_sessions` | Every device logged into the account, current one marked. | full |
| `telegram_logout_session` | Revoke one session, or all others with all=true. | full |
| `telegram_doctor` | Health check: env, state dir, session permissions, live auth. | readonly |
| `telegram_setup` | Write the server's .env (api_id, api_hash, phone, policy). | full |

### Login

| Tool | What it does | Profile |
| --- | --- | --- |
| `telegram_login_start` | Send the login code to the user's Telegram app. | readonly |
| `telegram_login_code` | Submit the code; reports needsPassword when 2FA is on. | readonly |
| `telegram_login_password` | Complete a 2FA login. The password is never echoed. | readonly |
| `telegram_login_cancel` | Abandon an in-progress login and forget the code. | readonly |

### Chats & dialogs

| Tool | What it does | Profile |
| --- | --- | --- |
| `telegram_list_chats` | List DMs, groups and channels, with unread and pin state. | readonly |
| `telegram_chat_info` | Title, username, id, type, member count, description. | readonly |
| `telegram_chat_members` | Participants of a group or channel, with roles. | readonly |
| `telegram_chat_admins` | Admins plus the exact rights each one holds. | readonly |
| `telegram_folders` | Chat folders and the peers/rules behind each one. | readonly |
| `telegram_mute_chat` | Mute for N days; 0 unmutes. | messaging |
| `telegram_pin_chat` | Pin or unpin a dialog in your own list. | messaging |
| `telegram_archive_chat` | Move a dialog to Archived, or back. | messaging |
| `telegram_mark_read` | Mark every message in a chat as read. | messaging |
| `telegram_clear_history` | Delete history from your side, or for everyone with revoke. | full |

### Groups & channels

| Tool | What it does | Profile |
| --- | --- | --- |
| `telegram_create_group` | Create a group with an explicit member list. | moderator |
| `telegram_create_channel` | Create a broadcast channel. | moderator |
| `telegram_join_chat` | Join a public chat by @username or invite link. | moderator |
| `telegram_leave_chat` | Leave a group or channel. | moderator |
| `telegram_delete_chat` | Delete a group/channel you own, history included. | full |
| `telegram_edit_chat` | Change a title or description (admin). | moderator |
| `telegram_export_invite_link` | Read or revoke an invite link (admin). | moderator |
| `telegram_set_chat_photo` | Set or remove a group/channel photo (admin). | moderator |
| `telegram_invite_members` | Add users to a chat you administer. | moderator |
| `telegram_promote_admin` | Grant, change or revoke admin rights. | moderator |
| `telegram_kick_member` | Kick or ban a member; unban reverses it. | moderator |

### Messages

| Tool | What it does | Profile |
| --- | --- | --- |
| `telegram_get_history` | Recent messages, newest first, with hasMore/nextOffsetId. | readonly |
| `telegram_search_messages` | Full-text search inside one chat, with paging. | readonly |
| `telegram_search_global` | Search every chat at once, with a server cursor. | readonly |
| `telegram_get_message` | Fetch one message by id. | readonly |
| `telegram_send_message` | Send text, with replyTo and topicId. | messaging |
| `telegram_edit_message` | Edit one of your own messages. | messaging |
| `telegram_delete_messages` | Delete messages by id; revoke for everyone. | moderator |
| `telegram_forward_messages` | Forward messages between chats. | messaging |
| `telegram_react` | Add or clear an emoji reaction. | messaging |
| `telegram_pin_message` | Pin or unpin one message in a chat. | messaging |
| `telegram_unpin_all` | Remove every pinned message at once. | messaging |
| `telegram_pinned_messages` | Read the current pinned messages. | readonly |
| `telegram_typing` | Show or cancel the typing indicator. | messaging |
| `telegram_export_history` | Dump a chat's history to JSON or JSONL on disk. | messaging |
| `telegram_message_link` | Build a t.me or tg:// link for a message or chat. | readonly |
| `telegram_scheduled_messages` | Messages queued to be sent later. | readonly |
| `telegram_translate` | Translate a message or a literal string. | readonly |
| `telegram_send_poll` | Send a poll or quiz with 2-10 answers. | messaging |
| `telegram_send_contact` | Send a vCard into a chat without saving it. | messaging |

### Media

| Tool | What it does | Profile |
| --- | --- | --- |
| `telegram_send_file` | Send a local file as a document or auto-detected media. | messaging |
| `telegram_send_photo` | Send a local image as an inline photo. | messaging |
| `telegram_send_location` | Send a point with optional accuracy. | messaging |
| `telegram_download_media` | Download a message attachment to the local media dir (streamed to disk, no OOM). | messaging |
| `telegram_list_downloads` | The local download index, with exists checks. | readonly |
| `telegram_delete_download` | Drop an index row, optionally deleting the file. | messaging |

### Contacts & users

| Tool | What it does | Profile |
| --- | --- | --- |
| `telegram_search_users` | Find users and chats by name or @username. | readonly |
| `telegram_get_contacts` | Saved contacts with ids, usernames and phones. | readonly |
| `telegram_add_contact` | Save a Telegram user as a contact by @username or user id. | full |
| `telegram_delete_contacts` | Remove saved contacts by @username, user id, or numeric id. | full |
| `telegram_block_user` | Block or unblock a user. | full |
| `telegram_list_blocked` | The current block list. | readonly |
| `telegram_send_contact` | Send a vCard into a chat without saving it. | messaging |
| `telegram_common_chats` | Groups and channels shared with another user. | readonly |

### Audit

| Tool | What it does | Profile |
| --- | --- | --- |
| `telegram_audit_log` | The server's own call log, secrets redacted. | readonly |
| `telegram_audit_summary` | Counts per tool and outcome, plus first/last call. | readonly |
| `telegram_permissions` | Show access profile, approval mode, and which tools are allowed/denied right now. | readonly |

### Workflows

| Tool | What it does | Profile |
| --- | --- | --- |
| `telegram_briefing` | Structured briefing: per-sender/day activity, media, question candidates, highlights, links, top-viewed. | readonly |
| `telegram_search_intelligence` | Search + group by person/chat, with date range, media counts, and optional filters. | readonly |

A few behaviours worth knowing:

- **Paging is explicit.** History and search return `hasMore` plus a cursor (`nextOffsetId`, or `nextOffsetRate` for global search). Page two is not a guess.
- **Reads before writes.** `pin_message`, `mute_chat`, `mark_read`, `delete_messages`, `clear_history` and friends read the state back and report what actually changed.
- **Errors carry a code and a hint.** `FLOOD_WAIT` includes `retryAfterSec`; `CHAT_ADMIN_REQUIRED` names the missing right; `NOT_AUTHORIZED` tells the agent to start a login.
- **Files stay local.** `download_media` and `export_history` write under `~/.telegram-mcp/`; `delete_download` cleans the index and, optionally, the file.
- **Out of scope.** Secret chats (end-to-end encrypted) and voice/video calls are not exposed by this server.

## Security model

Full access is the default because that is the point of connecting your own account. The guardrails are there when you want them.

| Layer | What it does |
| --- | --- |
| Transport | stdio only. The server never opens a TCP port. |
| Session | `session.txt` written with `0600`; the containing directory is `0700`. |
| Secrets | api_hash, login codes, 2FA passwords and session strings are redacted from `audit.log` and never returned by a tool. |
| Audit | Every call is appended with a timestamp, tool name, sanitized arguments and outcome. `telegram_audit_log` and `telegram_audit_summary` read it back. |
| Allowlist | Optional. Set `TELEGRAM_ALLOWED_CHATS` and `TELEGRAM_ALLOW_ALL_CHATS=false` to restrict every chat-taking tool to named chats. |
| Access profiles | `TELEGRAM_ACCESS_PROFILE=readonly|messaging|moderator|full` enforced server-side before any Telegram request. |
| Human approval | `TELEGRAM_APPROVAL_MODE=destructive|writes` turns risky calls into one-shot approvals granted out-of-band. |
| Untrusted input | Message content is tagged as data. An agent must not follow instructions found in a message. |
| Sessions | `telegram_list_sessions` shows every device; `telegram_logout_session` revokes one, or all others with `all=true`. |

The allowlist and profiles are real gates, not display filters: every tool resolves its target through the same policy check, and the test harness probes all of them for bypasses (`npm run test:policy`).

## Configuration

All settings are environment variables. The server also loads a `.env` next to the installed package, so `telegram_setup` works without touching your shell.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_API_ID` | — | **Required.** Numeric app id from my.telegram.org. |
| `TELEGRAM_API_HASH` | — | **Required.** App hash from my.telegram.org. |
| `TELEGRAM_PHONE` | — | Optional international number. When set, login only asks for the code. |
| `TELEGRAM_ACCESS_PROFILE` | `full` | `readonly` \| `messaging` \| `moderator` \| `full`. Invalid fails closed to `readonly`. |
| `TELEGRAM_APPROVAL_MODE` | `off` | `off` \| `destructive` \| `writes`. Invalid fails closed to `writes`. |
| `TELEGRAM_APPROVAL_TTL_SECONDS` | `600` | How long a pending approval lives (30–86400). |
| `TELEGRAM_ALLOW_ALL_CHATS` | `true` | Full access to every chat the account can reach. |
| `TELEGRAM_ALLOWED_CHATS` | — | Comma-separated allowlist: `@name`, numeric id, or exact title. |
| `TELEGRAM_STATE_DIR` | `~/.telegram-mcp` | State directory (session, approvals, audit, downloads, exports). |
| `TELEGRAM_SESSION_PATH` | `~/.telegram-mcp/session.txt` | Session file. |
| `TELEGRAM_MEDIA_DIR` | `~/.telegram-mcp/media` | Downloads. |
| `TELEGRAM_EXPORT_DIR` | `~/.telegram-mcp/exports` | History exports. |
| `TELEGRAM_AUDIT_LOG` | `~/.telegram-mcp/audit.log` | Call log. |
| `TELEGRAM_MAX_DOWNLOAD_BYTES` | `0` (unlimited) | Hard cap for one download. A non-numeric value is refused rather than treated as unlimited. |
| `TELEGRAM_UPDATE_CHECK` | `true` | Set to `0` to stop the startup check for a newer npm release. |
| `TELEGRAM_UPDATE_CHECK_TIMEOUT_MS` | `800` | Timeout for that check, capped at 10 s. |
| `TELEGRAM_MCP_NODE` | current Node | Launcher override, for exotic Node installs. |
| `TELEGRAM_DASHBOARD_PORT` | random | Fixed port for the localhost dashboard. |
| `TELEGRAM_DASHBOARD_TOKEN` | random | Fixed token for the dashboard (≥16 chars). |

`~` and `~\` are both expanded. Relative paths resolve against the current working directory.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `[NOT_AUTHORIZED]` | No valid session. Call `telegram_login_start`; the agent can do this for you. |
| `[FLOOD_WAIT]` with `retryAfterSec` | Telegram is throttling this account. Wait the stated number of seconds. Do not parallelize identical writes; chat creation and contact edits are the usual triggers. |
| `[AUTH_KEY_DUPLICATED]` | The saved session was replaced by a newer login. Run `npm run login:force` once, then restart the agent. |
| `[CHAT_ADMIN_REQUIRED]` | The account is an admin but lacks that specific right. Only the chat creator can grant it; an admin cannot grant it to themselves. |
| `[PREMIUM_ACCOUNT_REQUIRED]` | Some reactions and account features need Telegram Premium. The tool reports this cleanly instead of pretending. |
| `[PERMISSION_DENIED]` | Current access profile does not allow this tool. Call `telegram_permissions` to see which profile is required. |
| `[APPROVAL_REQUIRED]` | Approval mode is enabled and this tool needs human sign-off. Run `telegram-mcp approve <id>` or open the dashboard, then retry the exact same call. |
| `[APPROVAL_DENIED]` | This exact call was denied by the human. Change the arguments or request a fresh approval. |
| `TELEGRAM_API_ID is not set` | The MCP client did not pass the environment. Check the `env` / `environment` block and restart the client. |
| `Cannot find module .../dist/index.js` | The package was installed without building. Run `npm run build`, or use the release tarball. |
| Login works, then the next run asks again | `TELEGRAM_SESSION_PATH` changed between runs. Keep it stable, or leave it unset. |
| Window/terminal closes when started by hand | Expected: the server speaks MCP on stdio. Start it through a client, or use `npm run login` for the standalone CLI. |
| `update available: …` on every start | A newer release is on npm. Run `telegram-mcp update`, or set `TELEGRAM_UPDATE_CHECK=0` if you pin versions on purpose. |
| `telegram-mcp update` finds no upgrade command | The copy lives in a `node_modules` tree npm does not manage as a global prefix (npx cache, or a project dependency). Restart it as `npx -y @dikacode/telegram-mcp@latest`, or upgrade the project dependency. |
| `telegram-mcp --version` prints nothing | You are on `1.0.0`, which predates the flag. Upgrade to `1.0.1` or newer. |

## Development

The repository ships with a unit suite and a real MCP harness that spawns the built server and calls tools over stdio.

```bash
npm install
npm run build

npm run test:unit          # 83 offline checks
npm run test:mcp           # read-only end-to-end pass
npm run test:mcp:write     # + self-cleaning writes
npm run test:destructive   # + disposable chats (opt-in, flood-limited)
npm run test:policy        # allowlist bypass probes
npm run test:access        # access profiles + approval flow (new)
npm run test:mcp -- --doctor
```

The end-to-end harness reads from a public channel by default. Point it at a chat you control for the full picture:

```bash
TELEGRAM_TEST_CHAT=@your_channel npm run test:mcp
TELEGRAM_HARNESS_CHAT=-1001234567890 npm run test:destructive
```

`TELEGRAM_HARNESS_CHAT` must be a chat the account administers; it enables the rename, invite-link and admin-list round trips. Without it those scenarios report an honest skip instead of a fake pass.

`--destructive` creates and deletes real groups and channels. Telegram flood-bans that aggressively. If a run hits `FLOOD_WAIT`, stop and wait; `--cleanup` and `--reclaim` exist for the debris an interrupted run can leave.

The harness also supports `--json`, `--only=tool_a,tool_b`, `--cleanup`, `--reclaim`, `--allow=@chat`, `--deny=me` and `--doctor`. See [harness/README.md](harness/README.md) for the full behaviour, including how artifacts are verified and removed.

## Project layout

```
telegram-mcp/
├── bin/telegram-mcp.js       portable launcher (finds Node, then dist/index.js)
├── cli/                      standalone login, doctor, update, dashboard, approvals
├── assets/                   animated README art (SVG, no scripts)
├── harness/                  unit checks + end-to-end MCP harness
├── docs/                     Jekyll site source (GitHub Pages)
├── integrations/             example configs for OpenCode, Claude Code, Codex, Cursor, VS Code, n8n
├── index.ts                  stdio entrypoint
├── server.ts                 tool registration
├── server-registry.ts        strict schemas, secret-arg scrubbing, tool guards
├── access.ts                 access profiles + tool classification
├── approvals.ts              human approval store (SHA-256, TTL, cross-process lock)
├── workflow-core.ts          pure aggregation logic (testable offline)
├── workflows.ts              telegram_briefing + telegram_search_intelligence
├── mcp-extras.ts             MCP prompts (6) + resources (4)
├── audit-read.ts             shared audit log parser + summarizer
├── audit-tools.ts            telegram_audit_log / telegram_audit_summary
├── audit.ts                  append-only audit log with secret redaction
├── config.ts                 env parsing, path resolution, memoized config
├── telegram.ts               GramJS client lifecycle (generation counter)
├── errors.ts                 RPC error normalization
├── perms.ts                  POSIX 0600/0700 with a Windows no-op
├── state.ts                  local state (allowlist + downloads, mtime-cached)
├── ui.ts                     terminal UI (spinner, steps, theming)
├── helpers.ts                chat resolution, message shaping, flood retry
├── version.ts                version + update check
├── package.json              metadata, scripts, mcpName
├── server.json               MCP Registry metadata (2025-12-11 schema)
└── tsconfig.json
```

The TypeScript is built with `tsc` to `dist/`. There is no bundler; the published package is the compiled tree plus the launcher.

## Release

**v1.1.0** is the current release, published to npm as
[`@dikacode/telegram-mcp`](https://www.npmjs.com/package/@dikacode/telegram-mcp).

- 72 MCP tools (was 69), all registered with strict input schemas.
- Access profiles: `readonly`, `messaging`, `moderator`, `full` (default).
- Human approval gate: `TELEGRAM_APPROVAL_MODE=destructive|writes` with CLI + dashboard.
- Local control center: `telegram-mcp dashboard` (localhost-only, token/cookie auth, CSP, CSRF).
- MCP prompts (6) and resources (4): `telegram://status`, `telegram://tools`, `telegram://audit/summary`, `telegram://security-model`.
- Workflow tools: `telegram_briefing`, `telegram_search_intelligence`.
- Streaming downloads: `telegram_download_media` streams to disk, no OOM on large files.
- Memoized config + mtime-cached state for lower latency.
- Approval lock: exponential backoff, configurable timeout, read-only fast path.
- 83 offline unit checks (was 74).
- In-chat login, including two-step verification.
- Session file `0600`, state directory `0700`.
- Read-back verification for state-changing tools.
- Optional allowlist, audited calls, redacted secrets.
- Cross-platform launcher; no hardcoded paths.
- `--version` / `--help`, and a startup notice when a newer release exists.
- `telegram-mcp update` upgrades whichever layout is installed; `--check` reports without touching anything.
- End-to-end harness with paging, policy probes and artifact cleanup.

See [CHANGELOG.md](https://github.com/dikaglorya/telegram-mcp/blob/main/CHANGELOG.md) for the full release notes. Release artifacts are on the [releases page](https://github.com/dikaglorya/telegram-mcp/releases).

## Reporting a bug

Open an issue here: **https://github.com/dikaglorya/telegram-mcp/issues/new/choose**

You get two forms — *Bug report* and *Feature request*. The bug form asks for the version, install path, MCP client, OS, the tool involved, the error code, steps to reproduce, and `telegram_doctor` output. That is enough to reproduce most failures without a round trip.

If the server will not start at all, say so and paste the client's server log; the launcher prints one line explaining what is missing before it starts serving.

**What not to put in an issue.** Never include an `api_hash`, a session string, a login code, a 2FA password, your phone number, or the text of a private message. Chat ids and usernames of private chats should be redacted too. An issue is public and indexed the moment you submit it.

**Security problems go private.** Secret leakage, allowlist bypass, path traversal, session handling bugs, or a write tool that reports success without changing anything should go through GitHub's private advisory flow: **Security → Advisories → Report a vulnerability** (direct link: https://github.com/dikaglorya/telegram-mcp/security/advisories/new). That flow is enabled on this repository. [SECURITY.md](SECURITY.md) lists what is in scope and what is not — `FLOOD_WAIT` and account restrictions from automated behaviour are Telegram's, not vulnerabilities.

**Before you report**, the [troubleshooting table](#troubleshooting) already covers `NOT_AUTHORIZED`, `FLOOD_WAIT`, `AUTH_KEY_DUPLICATED`, `CHAT_ADMIN_REQUIRED`, `PREMIUM_ACCOUNT_REQUIRED`, a missing `TELEGRAM_API_ID`, and a missing `dist/`. A quick `telegram_doctor` call answers most "it will not connect" reports in one shot.

## Contributing

Issues and pull requests are welcome. A useful PR is small, explains the failure it fixes, and includes a test that fails without it.

Before opening a PR:

```bash
npm run build
npm run test:unit
npm run test:mcp
```

Guidelines:

- Keep the strict-schema contract: a new tool declares every argument it accepts.
- A state-changing tool reads its result back; do not report the request as the outcome.
- Never log or return api_hash, session strings, login codes or 2FA passwords.
- Do not add a dependency when the standard library or an existing dependency already does the job.
- Match the surrounding style: two-space indent, explicit types at module boundaries, comments that explain *why*.

For a security issue, follow [SECURITY.md](https://github.com/dikaglorya/telegram-mcp/blob/main/SECURITY.md). Do not open a public issue containing a session string, an api_hash or private message content.

## License

MIT — see [LICENSE](https://github.com/dikaglorya/telegram-mcp/blob/main/LICENSE).

## Contributors

| | Role |
| --- | --- |
| [dikaglorya](https://github.com/dikaglorya) | creator and maintainer |
| *you* | contributions welcome |

See [CONTRIBUTORS.md](https://github.com/dikaglorya/telegram-mcp/blob/main/CONTRIBUTORS.md) for the canonical list. Contributions are credited in the release notes for the version that includes them.