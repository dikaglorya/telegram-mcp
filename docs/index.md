# Welcome to telegram-mcp

Your Telegram account, exposed as an MCP server.

## Quick links

- [README](../README.md)
- [Tools reference](tools.md)
- [Security model](../SECURITY.md)
- [CHANGELOG](../CHANGELOG.md)
- [GitHub repository](https://github.com/dikaglorya/telegram-mcp)
- [npm package](https://www.npmjs.com/package/@dikacode/telegram-mcp)

## Quick start

```bash
npx -y @dikacode/telegram-mcp
```

## Features at a glance

| Feature | Description |
|---------|-------------|
| **72 tools** | Messages, chats, media, contacts, admin, sessions, briefings, search intelligence |
| **Access profiles** | `readonly`, `messaging`, `moderator`, `full` (default) |
| **Human approval** | `destructive` or `writes` mode with CLI + dashboard |
| **Local dashboard** | `telegram-mcp dashboard` — localhost-only control center |
| **MCP prompts** | 6 prompts for common workflows |
| **MCP resources** | `telegram://status`, `telegram://tools`, `telegram://audit/summary`, `telegram://security-model` |
| **Workflow tools** | `telegram_briefing`, `telegram_search_intelligence` |
| **Transport** | stdio only — no inbound port |
| **Security** | Session 0600, audit with redaction, allowlist, untrusted input handling |

## Install

```bash
# One-time global install
npm install -g @dikacode/telegram-mcp

# Or run directly with npx (always current)
npx -y @dikacode/telegram-mcp
```

## Configuration

Required environment variables:

```bash
TELEGRAM_API_ID=1234567
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
```

Optional:

```bash
TELEGRAM_ACCESS_PROFILE=full          # readonly|messaging|moderator|full
TELEGRAM_APPROVAL_MODE=off            # off|destructive|writes
TELEGRAM_APPROVAL_TTL_SECONDS=600     # 30-86400
TELEGRAM_ALLOW_ALL_CHATS=true
TELEGRAM_ALLOWED_CHATS=@channel,-1001234567890
TELEGRAM_STATE_DIR=~/.telegram-mcp
TELEGRAM_MAX_DOWNLOAD_BYTES=0         # 0 = unlimited
TELEGRAM_DASHBOARD_PORT=8787
TELEGRAM_DASHBOARD_TOKEN=my-secret-16
```

## Connect your agent

### OpenCode
```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "telegram": {
      "type": "local",
      "command": ["npx", "-y", "@dikacode/telegram-mcp"],
      "environment": {
        "TELEGRAM_API_ID": "1234567",
        "TELEGRAM_API_HASH": "0123456789abcdef0123456789abcdef"
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
  -- npx -y @dikacode/telegram-mcp
```

### Codex CLI
```toml
[mcp_servers.telegram]
command = "npx"
args = ["-y", "@dikacode/telegram-mcp"]
[mcp_servers.telegram.env]
TELEGRAM_API_ID = "1234567"
TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef"
```

### Cursor / Windsurf
```json
{
  "mcpServers": {
    "telegram": {
      "command": "npx",
      "args": ["-y", "@dikacode/telegram-mcp"],
      "env": {
        "TELEGRAM_API_ID": "1234567",
        "TELEGRAM_API_HASH": "0123456789abcdef0123456789abcdef"
      }
    }
  }
}
```

## First login

The server starts unauthenticated. The agent drives the login entirely in chat:

1. `telegram_login_start` — sends code to your Telegram app
2. `telegram_login_code` — you type the code in chat
3. `telegram_login_password` — only if 2FA enabled
4. Session saved to `~/.telegram-mcp/session.txt` (0600)

## Local dashboard

```bash
telegram-mcp dashboard
```

Opens a localhost-only UI at `http://127.0.0.1:<port>/?token=...` showing:
- Policy overview (profile, approval mode, session)
- Approval queue with one-click Approve/Deny
- Filterable audit log
- Complete tool catalog with access profile

## Workflow tools

- **telegram_briefing** — structured briefing: per-sender/day activity, media, question candidates, highlights, links
- **telegram_search_intelligence** — search grouped by person/chat with date range and filters

## Testing

```bash
npm run test:unit      # 83 offline checks
npm run test:access    # access profiles + approval flow
npm run test:mcp       # read-only end-to-end
npm run test:policy    # allowlist bypass probes
```

## Security

- Transport: stdio only
- Session file: 0600 in 0700 directory
- Secrets redacted from audit log: api_hash, codes, 2FA passwords, session strings
- Allowlist: optional chat authorization boundary
- Untrusted input: message content tagged as data, never instructions
- Private vulnerability reporting: GitHub Security Advisories

## License

MIT — see [LICENSE](../LICENSE).