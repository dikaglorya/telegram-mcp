#!/usr/bin/env node
/**
 * Terminal-only preview of the UI: banner, colours, symbols, spinner and the
 * full login walkthrough with fake answers.
 *
 * It exists because the interesting output depends on a TTY, and a piped test
 * run deliberately produces plain text. `npm run preview` runs it under a pty
 * so what you see is what a user sees.
 *
 *   npm run preview            # everything
 *   npm run preview -- banner  # one section
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);

const ui = await load("dist/ui.js");
const { banner, theme, sym, paint, info, hint, success, warn, error, muted, gap, spinner, step, nextSteps } = ui;

const section = process.argv[2];
const show = (name) => !section || section === name;

const rule = (title) => process.stdout.write(`\n${theme.muted("──")} ${theme.label(title)} ${theme.muted("──".repeat(24))}\n`);

if (show("banner")) {
  rule("banner · framed (login / doctor / --help)");
  banner({ subtitle: "your Telegram account, as an MCP server" });
  rule("banner · compact (server start)");
  banner({ subtitle: "your Telegram account, as an MCP server", compact: true });
}

if (show("palette")) {
  rule("palette");
  process.stdout.write(
    [
      ["title", theme.title("title")],
      ["label", theme.label("label")],
      ["accent", theme.accent("accent")],
      ["success", theme.success("success")],
      ["fail", theme.fail("fail")],
      ["warn", theme.warn("warn")],
      ["muted", theme.muted("muted")],
      ["bold", paint.bold("bold")],
      ["underline", paint.underline("underline")],
    ]
      .map(([k, v]) => `  ${theme.muted(k.padEnd(10))} ${v}`)
      .join("\n") + "\n",
  );
  rule("symbols");
  process.stdout.write(`  ${sym.ok} ok   ${sym.fail} fail   ${sym.warn} warn   ${sym.arrow} arrow   ${sym.bullet} bullet\n`);
}

if (show("messages")) {
  rule("messages");
  info("neutral information line");
  success("something that worked");
  warn("something that needs attention");
  error("something that failed");
  hint("a follow-up detail, indented and quiet");
  muted("the quietest line: shutdown, notes");
}

if (show("spinner")) {
  rule("spinner");
  const s = spinner("verifying the saved session");
  await new Promise((r) => setTimeout(r, 900));
  s.stop(`${theme.success(sym.ok)} verified in 0.9s`);
}

if (show("login")) {
  rule("login walkthrough (fake answers, spinner accelerated)");
  banner({ subtitle: "interactive login", compact: true });
  gap();
  step(1, 3, "Checking the existing session");
  const check = spinner("verifying the saved session");
  await new Promise((r) => setTimeout(r, 700));
  check.stop(`${theme.warn(`${sym.warn} saved session is no longer authorized`)}`);
  gap();
  step(2, 3, "Signing in to Telegram");
  hint(`the session will be stored at ~/.telegram-mcp/session.txt`);
  hint("Telegram is sending a code to your other devices");
  process.stdout.write(`  ${theme.accent(`${sym.arrow} `)}${theme.label("Login code")} ${theme.muted("••••• (typed)")}\n`);
  hint("two-step verification is on for this account");
  process.stdout.write(`  ${theme.accent(`${sym.arrow} `)}${theme.label("2FA password (leave blank if none)")} ${theme.muted("•••• (typed, hidden)")}\n`);
  gap();
  step(3, 3, "Saving");
  success(`authorized as ${paint.bold("@dikacode")}`);
  hint(`session saved to ~/.telegram-mcp/session.txt ${theme.muted("(0600)")}`);
  nextSteps([
    `start your MCP client — it spawns ${theme.label("telegram-mcp")} from the config you already added`,
    `or run ${theme.label("telegram-mcp doctor")} to confirm everything is healthy`,
  ]);
  gap();
}

if (show("doctor")) {
  rule("doctor report");
  const rows = [
    ["config", "api_id=1234567, allowAll=true, allowlist=0"],
    ["state dir", "/home/you/.telegram-mcp"],
    ["session present", "/home/you/.telegram-mcp/session.txt"],
    ["session permissions", "mode=600"],
    ["telegram authorized", ""],
    ["account", "id=123456789 username=@you"],
  ];
  const width = Math.max(...rows.map(([l]) => l.length));
  process.stdout.write(
    rows
      .map(([label, detail]) =>
        `  ${theme.success(sym.ok)} ${theme.label(label.padEnd(width))}${detail ? `  ${theme.muted(detail)}` : ""}`,
      )
      .join("\n") + "\n",
  );
  gap();
  process.stdout.write(`  ${theme.success(`${sym.ok} ${paint.bold("all checks passed")}`)}\n`);
}

process.stdout.write("\n");
