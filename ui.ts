/**
 * Terminal presentation: colour, symbols, a banner and small animations.
 *
 * Rules this module enforces, in order of importance:
 *
 *   1. **stdout is never touched.** Only stderr goes through here. stdout is the
 *      MCP JSON-RPC channel, and a single ANSI escape sequence written there
 *      corrupts the stream and gets the server dropped by the client.
 *   2. **Degrade silently.** Colour needs a TTY, a terminal that is not dumb,
 *      and no NO_COLOR. Piped output, CI logs and `npx ... > file` get plain
 *      text with no escape codes at all.
 *   3. **Animation is optional and cannot hang.** Every animation has a hard
 *      time cap and is skipped when `TERM=dumb`, when stderr is not a TTY, when
 *      the terminal is narrow, or when TELEGRAM_NO_ANIMATION is set.
 *
 * The exported surface is small on purpose: the rest of the codebase should not
 * be threading `isTTY` checks through every message.
 */
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

/* ------------------------------------------------------------------ */
/* Capability detection                                                */
/* ------------------------------------------------------------------ */

const isWindows = process.platform === "win32";

function stderrIsTty(): boolean {
  return Boolean(process.stderr.isTTY);
}

/**
 * Colour support. `NO_COLOR` is the de-facto standard opt-out and takes
 * priority over everything (https://no-color.org). `FORCE_COLOR` exists for the
 * case where output is piped into a colour-aware pager.
 */
export function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  const forced = process.env.FORCE_COLOR;
  if (forced !== undefined && forced !== "" && forced !== "0") return true;
  if (forced === "0") return false;
  if (!stderrIsTty()) return false;
  if (process.env.TERM === "dumb") return false;
  // Windows Terminal and VS Code advertise themselves; plain conhost does not
  // reliably handle SGR, so it stays plain unless FORCE_COLOR says otherwise.
  if (isWindows && !process.env.WT_SESSION && !process.env.TERM_PROGRAM) return false;
  return true;
}

/** Whether the fancy stuff (banner frame, spinner) should run at all. */
export function animationEnabled(): boolean {
  if (process.env.TELEGRAM_NO_ANIMATION && process.env.TELEGRAM_NO_ANIMATION !== "0") return false;
  if (!stderrIsTty()) return false;
  if (process.env.TERM === "dumb") return false;
  const columns = process.stderr.columns ?? 0;
  if (columns > 0 && columns < 60) return false;
  return colorEnabled();
}

/* ------------------------------------------------------------------ */
/* Painting                                                            */
/* ------------------------------------------------------------------ */

type Painter = (text: string) => string;

function sgr(open: number, close = 0): Painter {
  return (text: string) => (colorEnabled() ? `\u001b[${open}m${text}\u001b[${close}m` : text);
}

/** 256-colour foreground, falling back to cyan when colour is off. */
function c256(code: number, fallback: number): Painter {
  return (text: string) =>
    colorEnabled() ? `\u001b[38;5;${code}m${text}\u001b[0m` : `\u001b[${fallback}m${text}\u001b[0m`;
}

const basic = !process.env.TELEGRAM_256_COLORS;

/**
 * Low-level painters, for the rare call that needs one word emphasised inside a
 * sentence. Prefer `theme` in new code; these are aliases kept small on purpose.
 */
export const paint = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  underline: sgr(4, 24),
};

/**
 * The palette: cool cyan/teal for structure, warm accents for emphasis.
 * Names are semantic (`success`, `fail`) so call sites read as intent.
 */
export const theme: Record<
  | "bold"
  | "dim"
  | "underline"
  | "border"
  | "title"
  | "label"
  | "accent"
  | "success"
  | "fail"
  | "warn"
  | "muted",
  Painter
> = {
  bold: paint.bold,
  dim: paint.dim,
  underline: paint.underline,
  border: basic ? sgr(90) : c256(244, 90),
  title: basic ? sgr(96) : c256(51, 96),
  label: basic ? sgr(97) : c256(252, 97),
  accent: basic ? sgr(96) : c256(45, 96),
  success: basic ? sgr(92) : c256(48, 92),
  fail: basic ? sgr(91) : c256(203, 91),
  warn: basic ? sgr(93) : c256(214, 93),
  muted: basic ? sgr(90) : c256(242, 90),
};

/* ------------------------------------------------------------------ */
/* Symbols                                                             */
/* ------------------------------------------------------------------ */

// Unicode box drawing and symbols are fine on every modern terminal, but
// Windows conhost with a legacy code page mangles them, so ASCII is used there.
const unicodeSymbols = !isWindows || Boolean(process.env.WT_SESSION);
export const sym = {
  ok: unicodeSymbols ? "✔" : "v",
  fail: unicodeSymbols ? "✖" : "x",
  warn: unicodeSymbols ? "▲" : "!",
  arrow: unicodeSymbols ? "→" : "->",
  bullet: unicodeSymbols ? "·" : "-",
  bar: unicodeSymbols ? "│" : "|",
  tl: unicodeSymbols ? "╭" : "+",
  tr: unicodeSymbols ? "╮" : "+",
  bl: unicodeSymbols ? "╰" : "+",
  br: unicodeSymbols ? "╯" : "+",
  h: unicodeSymbols ? "─" : "-",
};

/* ------------------------------------------------------------------ */
/* Message helpers — stderr only                                       */
/* ------------------------------------------------------------------ */

function write(text: string): void {
  process.stderr.write(text);
}

/** The canonical diagnostic line. `[telegram-mcp] ...` stays greppable. */
export function info(message: string): void {
  write(`${theme.title(`[${SERVER_NAME}]`)} ${message}\n`);
}

export function muted(message: string): void {
  write(`${theme.muted(`[${SERVER_NAME}]`)} ${message}\n`);
}

export function success(message: string): void {
  write(`${theme.success(sym.ok)} ${message}\n`);
}

export function warn(message: string): void {
  write(`${theme.warn(`${sym.warn} ${message}`)}\n`);
}

export function error(message: string): void {
  write(`${theme.fail(`${sym.fail} ${message}`)}\n`);
}

export function hint(message: string): void {
  write(`  ${theme.muted(`${sym.bullet} ${message}`)}\n`);
}

/** A blank line, but only when the terminal can afford it. */
export function gap(): void {
  if (animationEnabled()) write("\n");
}

/* ------------------------------------------------------------------ */
/* Banner                                                              */
/* ------------------------------------------------------------------ */

/** Two-row block wordmark: readable at small widths, unlike a huge figlet. */
const WORDMARK = [
  "▀█▀ █▀▀ █░░ █▀▀ █▀▀ █▀█ ▄▀█ █▀▄▀█",
  "░█░ █▀▀ █░░ ██▄ █▄█ █▀▄ █▀█ █░▀░█",
];

export type BannerOptions = {
  version?: string;
  subtitle?: string;
  /** One line instead of a frame. Used on every server start. */
  compact?: boolean;
};

/**
 * Print the banner. Deliberately quiet on repeated runs: the full frame is for
 * CLI commands (login, doctor, --help), while a server start uses the compact
 * form so an agent's log does not fill up with art.
 */
export function banner(opts: BannerOptions = {}): void {
  const version = opts.version ?? SERVER_VERSION;
  const subtitle = opts.subtitle ?? "your Telegram account, as an MCP server";

  if (opts.compact || !animationEnabled()) {
    write(
      `${theme.title(SERVER_NAME)} ${theme.muted(version)} ${theme.muted(sym.bullet)} ${theme.label(subtitle)}\n`,
    );
    return;
  }

  const width = Math.max(...WORDMARK.map((row) => [...row].length)) + 4;
  write(`${theme.border(`${sym.tl}${sym.h.repeat(width)}${sym.tr}`)}\n`);
  for (const row of WORDMARK) write(`${theme.border(sym.bar)}  ${theme.title(row)}\n`);
  write(
    `${theme.border(sym.bar)}  ${theme.muted(version)} ${theme.muted(sym.bullet)} ${theme.label(subtitle)}\n`,
  );
  write(`${theme.border(`${sym.bl}${sym.h.repeat(width)}${sym.br}`)}\n`);
}

/* ------------------------------------------------------------------ */
/* Spinner                                                             */
/* ------------------------------------------------------------------ */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Redraw the current line in place. Only valid when animation is on. */
function redraw(text: string): void {
  write(`\u001b[2K\r${text}`);
}

function clearLine(): void {
  write("\u001b[2K\r");
}

/**
 * A one-line spinner with a hard time cap, so a stuck network call cannot leave
 * something spinning in a log forever. `stop()` erases the line and optionally
 * replaces it with a final message.
 */
export function spinner(text: string, opts: { maxMs?: number } = {}): { stop: (final?: string) => void } {
  const maxMs = opts.maxMs ?? 6000;
  if (!animationEnabled()) {
    write(`${theme.muted(`${sym.bullet} ${text}`)}\n`);
    return { stop: () => undefined };
  }

  let frame = 0;
  const started = Date.now();
  let stopped = false;

  const stop = (final?: string): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    clearLine();
    if (final) write(`${final}\n`);
  };

  const draw = (): void => redraw(`${theme.accent(FRAMES[frame++ % FRAMES.length])} ${text}`);
  draw();

  const timer = setInterval(() => {
    if (Date.now() - started > maxMs) {
      // Give up quietly: the caller still prints its own outcome line.
      stop();
      return;
    }
    draw();
  }, 90);
  // Never let the animation be the reason the process stays alive.
  timer.unref?.();

  return { stop };
}

/** A numbered step header, e.g. `[1/3] Connecting to Telegram`. */
export function step(index: number, total: number, text: string): void {
  write(`${theme.accent(`[${theme.muted(`${index}/${total}`)}]`)} ${theme.bold(text)}\n`);
}

/**
 * The three-step onboarding footer shown once credentials are written. It is
 * the answer to "ok, and now what?" — the most common question after setup.
 */
export function nextSteps(steps: string[]): void {
  if (!steps.length) return;
  gap();
  write(`${theme.label(theme.bold("Next"))}\n`);
  steps.forEach((text, i) => {
    write(`  ${theme.accent(String(i + 1))}${theme.muted(".")} ${text}\n`);
  });
}
