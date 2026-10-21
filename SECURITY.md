# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private reporting flow: **Security → Advisories → Report a vulnerability** on this repository. Include:

- what the issue is and which tool or file it affects
- steps to reproduce, with secrets removed
- the impact you think it has
- a suggested fix, if you have one

You can expect an acknowledgement within a few days. There is no bounty program.

## Scope

In scope:

- secret leakage into tool output, logs, errors or the audit trail
- allowlist bypasses
- path traversal in downloads, exports or media handling
- authentication/session handling bugs
- a write tool that reports success without changing anything
- injection through Telegram content that causes tool execution

Out of scope:

- Telegram account restrictions caused by automated behaviour
- losing a session file or `.env` on your own machine
- issues that require an already-compromised host
- rate limits (`FLOOD_WAIT`) — those are Telegram's, not a vulnerability

## Login material

The login tools accept a Telegram code or a two-step password. The server keeps
either value in memory for one call, never writes it to the session, state or
audit log, and does not return it in tool output. The agent's own conversation
transcript is outside the server's control. If that matters for your threat
model, run `npm run login` in a terminal instead of typing the password into a
chat.

## Handling secrets

If you accidentally expose an `api_hash`, a session string or a phone number, revoke the session in Telegram (Settings → Devices) and rotate the credentials at <https://my.telegram.org/apps>. Deleting the commit is not enough; the value has already been copied.

## Supported versions

Only the latest release on the `main` branch is supported.
