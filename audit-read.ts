/**
 * Reading the local audit log.
 *
 * Shared by the `telegram_audit_*` tools and the local control center so both
 * report exactly the same counts. The log is append-only and already redacted;
 * this module only parses, filters and aggregates.
 */
import fs from "node:fs";

export type AuditLine = {
  ts?: string;
  tool?: string;
  outcome?: string;
  args?: unknown;
  detail?: unknown;
};

export type AuditPage = {
  path: string;
  exists: boolean;
  totalLines: number;
  count: number;
  filters: { tool: string | null; outcome: string | null };
  entries: AuditLine[];
};

export type AuditSummary = {
  path: string;
  calls: number;
  ok: number;
  error: number;
  unparsableLines: number;
  firstCallAt: string | null;
  lastCallAt: string | null;
  errorsByCode: Record<string, number>;
  perTool: Array<{ tool: string; ok: number; error: number; total: number }>;
};

function readLines(file: string): { exists: boolean; lines: string[] } {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, lines: [] };
    throw err;
  }
  return { exists: true, lines: raw.split("\n").filter((line) => line.trim()) };
}

export function readAuditPage(
  file: string,
  options: { limit: number; tool?: string; outcome?: "ok" | "error" },
): AuditPage {
  const { exists, lines } = readLines(file);
  const wanted = String(options.tool ?? "").toLowerCase();
  const entries: AuditLine[] = [];

  if (exists) {
    // Walk backwards: the newest calls are the interesting ones.
    for (let i = lines.length - 1; i >= 0 && entries.length < options.limit; i -= 1) {
      let parsed: AuditLine;
      try {
        parsed = JSON.parse(lines[i]) as AuditLine;
      } catch {
        // A half-written line from a crash is reported, not hidden — but it is
        // still subject to the same filters as a parsed line.
        parsed = { ts: undefined, tool: "(unparsable line)", outcome: "unknown", args: lines[i].slice(0, 200) };
      }
      if (wanted && String(parsed.tool ?? "").toLowerCase() !== wanted) continue;
      if (options.outcome && parsed.outcome !== options.outcome) continue;
      entries.push(parsed);
    }
  }

  return {
    path: file,
    exists,
    totalLines: lines.length,
    count: entries.length,
    filters: { tool: options.tool ?? null, outcome: options.outcome ?? null },
    entries,
  };
}

/** `null` means the log does not exist yet. */
export function summarizeAudit(file: string): AuditSummary | null {
  const { exists, lines } = readLines(file);
  if (!exists) return null;

  const perTool: Record<string, { ok: number; error: number }> = {};
  const errorsByCode: Record<string, number> = {};
  let okCount = 0;
  let errorCount = 0;
  let unparsable = 0;
  let first: string | undefined;
  let last: string | undefined;

  for (const line of lines) {
    let parsed: AuditLine;
    try {
      parsed = JSON.parse(line) as AuditLine;
    } catch {
      unparsable += 1;
      continue;
    }
    const name = String(parsed.tool ?? "(unknown)");
    perTool[name] = perTool[name] ?? { ok: 0, error: 0 };
    if (parsed.outcome === "error") {
      perTool[name].error += 1;
      errorCount += 1;
      const code = (parsed.detail as { code?: unknown } | undefined)?.code;
      if (typeof code === "string") errorsByCode[code] = (errorsByCode[code] ?? 0) + 1;
    } else {
      perTool[name].ok += 1;
      okCount += 1;
    }
    if (parsed.ts) {
      if (!first) first = parsed.ts;
      last = parsed.ts;
    }
  }

  return {
    path: file,
    calls: okCount + errorCount,
    ok: okCount,
    error: errorCount,
    unparsableLines: unparsable,
    firstCallAt: first ?? null,
    lastCallAt: last ?? null,
    errorsByCode,
    perTool: Object.entries(perTool)
      .map(([name, counts]) => ({ tool: name, ...counts, total: counts.ok + counts.error }))
      .sort((a, b) => b.total - a.total),
  };
}
