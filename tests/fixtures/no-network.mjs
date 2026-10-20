// Network guard for the test suite (SAF-102). Loaded into every test process and every gateway
// child via NODE_OPTIONS by scripts/run-tests.mjs. Blocks and records:
//   - TCP/TLS connects to non-loopback hosts (net, tls, http, https, http2, fetch/undici all end in
//     net.Socket.prototype.connect); hostnames are allowed only if they *resolve* to loopback
//   - DNS lookups / queries for non-loopback names (dns, dns.promises, Resolver)
//   - UDP (dgram) sends / connects to non-loopback addresses
// Every attempt is written to $CURSOR_API_NETGUARD_LOG, so the runner fails the whole run even
// when the code under test swallows the error (e.g. the startup account warm-up).
// Not covered (JS cannot see them): child processes started without this NODE_OPTIONS, worker
// threads, non-node binaries. `npm run test:offline` (empty network namespace) covers those; CI
// runs that.
import { appendFileSync } from "node:fs";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const GUARD = Symbol.for("cursor-api.netguard");

function blockedError(where) {
  const error = new Error(`[no-network test guard] blocked outbound ${where}`);
  error.code = "ENETGUARD";
  return error;
}

if (!net.Socket.prototype.connect[GUARD]) {
  // --- TCP / TLS ------------------------------------------------------------------------------
  const originalConnect = net.Socket.prototype.connect;
  const guardedConnect = function connect(...args) {
    const target = targetOf(args);
    if (target && !isLoopback(target.host)) {
      if (isLoopbackName(target.host)) {
        // "localhost": allowed only if what it resolves to (default or custom lookup) is loopback.
        if (target.options) target.options.lookup = checkedLookup(target.options.lookup ?? dns.lookup, target.port);
      } else {
        const where = `${String(target.host)}:${String(target.port ?? "")}`;
        record(where);
        const error = blockedError(`connection to ${where}`);
        process.nextTick(() => this.destroy(error));
        return this;
      }
    }
    return originalConnect.apply(this, args);
  };
  guardedConnect[GUARD] = true;
  net.Socket.prototype.connect = guardedConnect;

  // --- DNS ------------------------------------------------------------------------------------
  const originalLookup = dns.lookup;
  dns.lookup = function lookup(hostname, ...rest) {
    if (isLoopback(hostname) || isLoopbackName(hostname)) return originalLookup.call(this, hostname, ...rest);
    const callback = rest.find((item) => typeof item === "function");
    record(`dns.lookup ${String(hostname)}`);
    const error = blockedError(`dns lookup of ${String(hostname)}`);
    if (callback) process.nextTick(() => callback(error));
    else throw error;
  };
  const resolveNames = ["resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"];
  const guardCallbackResolver = (target, name) => {
    if (typeof target[name] !== "function") return;
    target[name] = function guardedResolve(hostname, ...rest) {
      const callback = rest.find((item) => typeof item === "function");
      record(`dns.${name} ${String(hostname)}`);
      const error = blockedError(`dns ${name} of ${String(hostname)}`);
      if (callback) process.nextTick(() => callback(error));
      else throw error;
    };
  };
  const guardPromiseResolver = (target, name) => {
    if (typeof target[name] !== "function") return;
    target[name] = async function guardedResolve(hostname) {
      record(`dns.promises.${name} ${String(hostname)}`);
      throw blockedError(`dns ${name} of ${String(hostname)}`);
    };
  };
  for (const name of resolveNames) {
    guardCallbackResolver(dns, name);
    guardCallbackResolver(dns.Resolver.prototype, name);
    guardPromiseResolver(dns.promises, name);
    guardPromiseResolver(dns.promises.Resolver.prototype, name);
  }
  const originalPromiseLookup = dns.promises.lookup;
  dns.promises.lookup = async function lookup(hostname, ...rest) {
    if (isLoopback(hostname) || isLoopbackName(hostname)) return originalPromiseLookup.call(this, hostname, ...rest);
    record(`dns.promises.lookup ${String(hostname)}`);
    throw blockedError(`dns lookup of ${String(hostname)}`);
  };

  // --- UDP ------------------------------------------------------------------------------------
  const CONNECTED = Symbol("netguard.udpPeer");
  const originalUdpConnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function connect(port, address, ...rest) {
    const host = typeof address === "string" ? address : undefined;
    if (host !== undefined && !isLoopback(host) && !isLoopbackName(host)) {
      record(`udp ${host}:${String(port)}`);
      throw blockedError(`udp connect to ${host}:${String(port)}`);
    }
    this[CONNECTED] = host;
    return originalUdpConnect.call(this, port, address, ...rest);
  };
  const originalSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function send(...args) {
    // send(msg, [offset, length,] port, [address], [cb])
    const withOffsets = typeof args[1] === "number" && typeof args[2] === "number" && typeof args[3] === "number";
    const port = withOffsets ? args[3] : args[1];
    const address = withOffsets ? args[4] : args[2];
    const host = typeof address === "string" ? address : undefined;
    if (host !== undefined && !isLoopback(host) && !isLoopbackName(host)) {
      record(`udp ${host}:${String(port)}`);
      const error = blockedError(`udp send to ${host}:${String(port)}`);
      const callback = args.find((item) => typeof item === "function");
      if (callback) process.nextTick(() => callback(error));
      else process.nextTick(() => this.emit("error", error));
      return;
    }
    return originalSend.apply(this, args);
  };

  // ESM named imports of builtins (`import { lookup } from "node:dns"`) see the patched functions.
  syncBuiltinESMExports();
}

/** Lookup wrapper: fails (and records) when a name resolves to anything but loopback. */
function checkedLookup(lookup, port) {
  return function guardedLookup(hostname, options, callback) {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : options;
    lookup(hostname, opts, (error, address, family) => {
      if (error) return cb(error, address, family);
      const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
      const bad = addresses.find((value) => !isLoopback(value));
      if (bad !== undefined) {
        const where = `${String(hostname)}->${String(bad)}:${String(port ?? "")}`;
        record(where);
        return cb(blockedError(`connection to ${where}`));
      }
      return cb(null, address, family);
    });
  };
}

/** Host/port (and the options object, when there is one) of a connect() call; undefined for IPC. */
function targetOf(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // net.connect passes normalized [options, cb]
  if (first !== null && typeof first === "object") {
    // http's Agent passes `path: null` for TCP: only a non-empty string is an IPC path.
    if (typeof first.path === "string" && first.path !== "") return undefined;
    return { host: first.host ?? "localhost", port: first.port, options: first };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return undefined; // IPC path
  return { host: typeof args[1] === "string" ? args[1] : "localhost", port: first };
}

/** Loopback IP literal (or the unspecified address, which connects to loopback). */
export function isLoopback(host) {
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  return (
    value === "::1" ||
    value === "0.0.0.0" ||
    value === "::" ||
    /^127\.\d+\.\d+\.\d+$/.test(value) ||
    /^::ffff:127\.\d+\.\d+\.\d+$/.test(value)
  );
}

/** The one name allowed before resolution; what it resolves to is still checked. */
export function isLoopbackName(host) {
  return String(host).toLowerCase() === "localhost";
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
