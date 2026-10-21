/**
 * Hard guard for the MCP transport.
 *
 * stdout is the JSON-RPC channel. Any stray `console.log` from a dependency
 * (gramJS, dotenv, a future import) would corrupt the stream and the agent
 * would drop the server. Import this first, before anything else, to redirect
 * every chatty console method to stderr. The MCP SDK writes through
 * process.stdout directly, so protocol traffic is unaffected.
 */

const toStderr =
  (label: string) =>
  (...args: unknown[]): void => {
    process.stderr.write(
      args
        .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a)))
        .join(" ") + "\n",
    );
    void label;
  };

console.log = toStderr("log");
console.info = toStderr("info");
console.debug = toStderr("debug");
console.warn = toStderr("warn");

export {};
