# Contributing

Thanks for taking the time to look at this. Bug reports, tool ideas and pull requests are all useful.

## Before you start

- Search the existing issues before opening a new one.
- For a large change, open an issue first so we can agree on the shape before you spend a weekend on it.
- Security issues go through [SECURITY.md](SECURITY.md), not the public tracker.

## Reporting a bug

Use the issue forms: <https://github.com/dikaglorya/telegram-mcp/issues/new/choose>. Pick **Bug report** for a broken tool or a server that will not start, and **Feature request** for a missing tool or behaviour.

The bug form asks for the version, install path, MCP client, OS, the tool involved, the error code, reproduction steps and `telegram_doctor` output. Fill those in and the report is usually actionable without a follow-up.

Never paste an `api_hash`, a session string, a login code, a 2FA password, your phone number, or private message text. Redact private chat ids and usernames too — issues are public.

Security problems (secret leakage, allowlist bypass, path traversal, session handling, a write tool that reports success without changing anything) must use GitHub's private advisory flow instead: <https://github.com/dikaglorya/telegram-mcp/security/advisories/new>.

## Development setup

```bash
git clone https://github.com/dikaglorya/telegram-mcp.git
cd telegram-mcp
npm install
npm run build
```

You need Node.js 20+. A Telegram test account is useful but not required for the offline checks.

## Checks

Run these before opening a pull request:

```bash
npm run typecheck
npm run test:unit
```

If your change touches a tool or the MCP transport, also run the harness against your own test chat:

```bash
TELEGRAM_TEST_CHAT=@your_test_channel npm run test:mcp
```

For chat-admin scenarios, add `TELEGRAM_HARNESS_CHAT` and use `--write`. Do not run the destructive suite against an account you are not prepared to lose.

## Adding a tool

A new tool needs all of these:

1. The implementation in the relevant module (`chats.ts`, `messages.ts`, `media.ts`, and so on).
2. A strict Zod input schema. Undeclared arguments must be rejected, not ignored.
3. A result that is read back from Telegram where the operation can silently no-op. `{ok:true}` on the request is not evidence that anything changed.
4. A line in the README tool table.
5. A catalogue entry in `harness/mcp-harness.mjs`, with `kind`, safe args, and an `expect` pattern.
6. An offline check in `harness/unit.mjs` if the logic is testable without the network.

Tools that can mutate the account need to be marked `write`, `destructive` or `manual` honestly. A test that only exercises the error path does not prove the success path.

## Style

- TypeScript, ESM, no build step beyond `tsc`.
- Keep comments about *why*, not *what*. If a workaround exists because Telegram behaves badly, name the error code and the observed behaviour.
- Prefer small functions and explicit return shapes.
- Don't add a dependency for something the standard library already does.
- Error messages should tell the caller what to do next, not just what failed.

There is no formatter config to fight with. Match the file you are editing.

## Commit messages

Short imperative subject, then a body when the reason is not obvious:

```
fix: re-resolve channel access hash before clear_history

channels.DeleteHistory returns CHANNEL_INVALID for every input form in the
current layer. Page the history and delete in batches with
channels.DeleteMessages instead.
```

## What not to commit

`.env`, session files, `state.json`, `audit.log`, `media/`, `exports/`, `dist/`, `node_modules/`, and anything containing someone's phone number, chat id or private message content.

## License

By contributing you agree that your work is released under the MIT license in [LICENSE](LICENSE).
