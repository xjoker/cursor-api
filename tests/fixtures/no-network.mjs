// Network guard for the test suite (SAF-102). Loaded into every test process and every gateway
// child via NODE_OPTIONS by scripts/run-tests.mjs. Any TCP/TLS connection to a non-loopback
// host fails immediately and is recorded in $CURSOR_API_NETGUARD_LOG, so the runner fails the
// whole run even when the code under test swallows the error (e.g. the startup account warm-up).
import { appendFileSync } from "node:fs";
import net from "node:net";

const GUARD = Symbol.for("cursor-api.netguard");

if (!net.Socket.prototype.connect[GUARD]) {
  const original = net.Socket.prototype.connect;
  const guarded = function connect(...args) {
    const target = targetOf(args);
    if (target && !isLoopback(target.host)) {
      const where = `${target.host}:${String(target.port ?? "")}`;
      record(where);
      const error = new Error(`[no-network test guard] blocked outbound connection to ${where}`);
      error.code = "ENETGUARD";
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return original.apply(this, args);
  };
  guarded[GUARD] = true;
  net.Socket.prototype.connect = guarded;
}

/** Host/port of a connect() call; undefined for IPC (path) connections. */
function targetOf(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // net.connect passes normalized [options, cb]
  if (first !== null && typeof first === "object") {
    if (first.path !== undefined) return undefined;
    return { host: first.host ?? "localhost", port: first.port };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return undefined; // IPC path
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

export function isLoopback(host) {
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "::1" ||
    value === "0.0.0.0" ||
    value === "::" ||
    /^127\.\d+\.\d+\.\d+$/.test(value) ||
    /^::ffff:127\.\d+\.\d+\.\d+$/.test(value)
  );
}

function record(where) {
  const log = process.env.CURSOR_API_NETGUARD_LOG;
  const line = `${new Date().toISOString()} pid=${String(process.pid)} ${where} ${process.argv.slice(1).join(" ")}\n`;
  process.stderr.write(`[no-network test guard] blocked ${where}\n`);
  if (log) {
    try {
      appendFileSync(log, line);
    } catch {
      // The guard must never crash the process it protects.
    }
  }
}
