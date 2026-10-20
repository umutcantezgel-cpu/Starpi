// @ts-check
// The in-process egress guard. With it installed the companion process reaches nothing but this
// machine, except through a capability the kernel hands to a module for the `host:443` entries the
// owner listed for that module.
//
// What it patches (all restored by uninstall):
//  - net.Socket#connect, the one place every TCP and TLS connection of http, https, tls and fetch
//    passes: an IP literal outside loopback, any host name other than `localhost` and any Unix
//    socket path the kernel did not open itself is refused with EGRESS_BLOCKED. Host names are
//    refused before resolution, so no name of a caller's choosing leaves as a DNS query either.
//    Node gets a fresh options object with the values that were checked, and `localhost` is
//    resolved through a lookup whose every answer must be loopback, a `lookup` function the
//    caller passed included (HTTP libraries pass their own; it runs, its answer is checked).
//  - dns.lookup, dns.promises.lookup: only IP literals and `localhost`; dns.resolve*, reverse and the
//    Resolver classes: always refused (they talk to DNS servers directly).
//  - dgram sockets: send and connect only to loopback literals or `localhost`; a socket made by
//    dgram.createSocket or dgram.Socket resolves through the same checked lookup (its own or
//    Node's), which also lets the wildcard bind addresses through.
//  - Spawning: child_process (spawn, exec, execFile, fork and their sync forms), ChildProcess#spawn
//    (the method every asynchronous form ends in), process.execve, cluster.fork and
//    worker_threads.Worker throw. A child process, a replaced process image or a worker starts
//    outside these patches, so the companion forbids them altogether in this release. The one
//    exception is the kernel's runner (vault/kek/runner.js): while it starts one of its fixed
//    programs, ChildProcess#spawn lets exactly that program through.
//  - process.binding of the raw socket, resolver and process bindings, and module.register (it
//    starts a loader thread outside the patches).
// The patched functions are also synchronised into the ESM named exports of the built-in modules,
// and the `constructor` of a replaced class's prototype points at the replacement, so the original
// cannot be picked up from there.
//
// Limits: references to the original functions and sockets made before install (the kernel makes
// none), Node's internal handle objects reached through a live socket, native add-ons and
// WebAssembly with host imports. On Linux the system unit adds a boundary outside the process
// (IPAddressDeny=any with an egress splice unit, see splice.js); a user unit has none, because a
// user manager ignores IPAddressDeny, so there this guard is the only boundary (deploy/linux/README.md).
import childProcess from 'node:child_process';
import cluster from 'node:cluster';
import dgram from 'node:dgram';
import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import workerThreads from 'node:worker_threads';
import { fail } from '../lib/errors.js';
import { kernelProgramStarting } from '../vault/kek/runner.js';
import { canonicalHost, isLoopbackAddress, isPublicAddress, parseEgressEntry } from './hosts.js';

const nodeModule = /** @type {typeof import('node:module')} */ (process.getBuiltinModule('node:module'));

export const EGRESS_BLOCKED = 'EGRESS_BLOCKED';
export const SPAWN_FORBIDDEN = 'SPAWN_FORBIDDEN';
/** Test seam for the capability's transport (resolve, connect, TLS); no configuration can produce it. */
export const TRANSPORT_SEAM = Symbol('egress transport seam');

const RESOLVER_METHODS = Object.freeze(['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'resolveTlsa', 'reverse']);
const SPAWN_METHODS = Object.freeze(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const BLOCKED_BINDINGS = Object.freeze(new Set(['tcp_wrap', 'udp_wrap', 'pipe_wrap', 'tls_wrap', 'cares_wrap', 'process_wrap', 'spawn_sync', 'stream_wrap']));
/** A datagram socket resolves its bind address through its lookup as well. */
const WILDCARD_ADDRESSES = Object.freeze(new Set(['0.0.0.0', '::']));

/** @typedef {{ api: string, target: string, at: number }} EgressReport */

/**
 * How a capability reaches a listed host.
 * @typedef {object} EgressTransport
 * @property {(host: string) => Promise<net.Socket>} connect  a connected TCP socket to the host on port 443
 * @property {boolean} [plain]   tests only: no TLS on top
 */

/** @type {object | null} */
let active = null;

/** @param {string} api @param {string} target */
function blocked(api, target) {
  const err = /** @type {NodeJS.ErrnoException} */ (new Error(`egress blocked: ${api} to ${target}`));
  err.code = EGRESS_BLOCKED;
  return err;
}

/** @param {string} api */
function spawnRefused(api) {
  const err = /** @type {NodeJS.ErrnoException} */ (new Error(`spawning is forbidden in the companion (${api})`));
  err.code = SPAWN_FORBIDDEN;
  return err;
}

/** True when a host as given to connect stays on this machine. @param {unknown} host */
function localTarget(host) {
  if (host === undefined || host === null || host === '') return true;
  if (typeof host !== 'string') return false;
  if (net.isIP(host) !== 0) return isLoopbackAddress(host);
  return /^localhost\.?$/i.test(host);
}

/**
 * The destination of a Socket#connect call, as Node reads its arguments, in a fresh options object:
 * every option of the caller is read exactly once, and Node later sees only this copy, so a getter
 * cannot answer differently after the check.
 * @param {unknown[]} args
 * @returns {{ options: Record<string, unknown>, path: string | null, host: unknown, port: unknown, holder: unknown[] | null }}
 */
function destinationOf(args) {
  const first = args[0];
  const given = Array.isArray(first) ? (first[0] ?? {}) : first;
  if (given !== null && typeof given === 'object') {
    const options = { .../** @type {Record<string, unknown>} */ (given) };
    return { options, path: typeof options.path === 'string' ? options.path : null, host: options.host, port: options.port, holder: Array.isArray(first) ? first : null };
  }
  if (typeof first === 'string' && !(Number(first) >= 0)) return { options: { path: first }, path: first, host: undefined, port: undefined, holder: null };
  // connect(port[, host][, callback])
  const host = typeof args[1] === 'string' ? args[1] : undefined;
  return { options: host === undefined ? { port: first } : { port: first, host }, path: null, host, port: first, holder: null };
}

/**
 * Installs the guard. Only one guard per process.
 * @param {{ onBlocked?: (report: EgressReport) => void, transport?: (kernel: { rawConnect: (hostOrPath: string, port: number | null) => Promise<net.Socket> }) => EgressTransport }} [options]
 *   transport: how capabilities reach their hosts (default: resolve and connect in this process;
 *   the splice transport of splice.js goes through the egress unit instead)
 */
export function installEgressGuard(options = {}) {
  if (active) throw new Error('the egress guard is installed already');
  const onBlocked = options.onBlocked ?? (() => {});
  /** @type {EgressReport[]} */
  const reports = [];
  /** Sockets the kernel opened itself (capability and splice connections). */
  const trusted = new WeakSet();

  const originals = {
    connect: net.Socket.prototype.connect,
    lookup: dns.lookup,
    promisesLookup: dns.promises.lookup,
    resolver: Object.fromEntries(RESOLVER_METHODS.map((m) => [m, /** @type {any} */ (dns)[m]])),
    promisesResolver: Object.fromEntries(RESOLVER_METHODS.map((m) => [m, /** @type {any} */ (dns.promises)[m]])),
    resolverProto: Object.fromEntries(RESOLVER_METHODS.map((m) => [m, /** @type {any} */ (dns.Resolver.prototype)[m]])),
    promisesResolverProto: Object.fromEntries(RESOLVER_METHODS.map((m) => [m, /** @type {any} */ (dns.promises.Resolver.prototype)[m]])),
    dgramSend: dgram.Socket.prototype.send,
    dgramConnect: dgram.Socket.prototype.connect,
    dgramCreateSocket: dgram.createSocket,
    dgramSocket: dgram.Socket,
    spawn: Object.fromEntries(SPAWN_METHODS.map((m) => [m, /** @type {any} */ (childProcess)[m]])),
    childSpawn: /** @type {any} */ (childProcess.ChildProcess.prototype).spawn,
    execve: /** @type {any} */ (process).execve,
    clusterFork: cluster.fork,
    worker: workerThreads.Worker,
    binding: /** @type {any} */ (process).binding,
    register: nodeModule.register,
  };

  /** @param {string} api @param {string} target */
  function refuse(api, target) {
    const report = { api, target, at: Date.now() };
    reports.push(report);
    if (reports.length > 200) reports.shift();
    try {
      onBlocked(report);
    } catch {
      // a failing reporter never opens the guard
    }
    return blocked(api, target);
  }

  /**
   * Wraps a lookup function, the caller's own or the guarded dns.lookup: every address it answers
   * must be loopback, otherwise the answer is EGRESS_BLOCKED. Node gets fresh values, read once and
   * checked, never the objects of the caller's answer.
   * @param {Function} lookup
   * @param {string} api
   * @param {boolean} [wildcard]   also accept 0.0.0.0 and :: (the bind address of a datagram socket)
   */
  function loopbackOnly(lookup, api, wildcard = false) {
    const fits = (/** @type {unknown} */ address) => typeof address === 'string' && net.isIP(address) !== 0 && (isLoopbackAddress(address) || (wildcard && WILDCARD_ADDRESSES.has(address)));
    return function checkedLookup(/** @type {unknown} */ hostname, /** @type {unknown} */ options, /** @type {unknown} */ callback) {
      const done = /** @type {Function} */ (typeof options === 'function' ? options : callback);
      const answer = (/** @type {unknown} */ err, /** @type {unknown} */ address) => {
        if (err) return done(err);
        if (Array.isArray(address)) {
          const list = address.map((entry) => entry?.address);
          const at = list.findIndex((a) => !fits(a));
          if (at !== -1) return done(refuse(api, `${String(hostname)} -> ${String(list[at])}`));
          return done(null, list.map((a) => ({ address: a, family: net.isIP(a) })));
        }
        if (!fits(address)) return done(refuse(api, `${String(hostname)} -> ${String(address)}`));
        return done(null, address, net.isIP(/** @type {string} */ (address)));
      };
      return typeof options === 'function' ? Reflect.apply(lookup, undefined, [hostname, answer]) : Reflect.apply(lookup, undefined, [hostname, options, answer]);
    };
  }

  /** @this {net.Socket} @param {...unknown} args */
  function guardedConnect(...args) {
    if (trusted.has(this)) return originals.connect.apply(this, /** @type {any} */ (args));
    const dest = destinationOf(args);
    if (dest.path !== null) throw refuse('net.connect', `unix:${dest.path}`);
    if (!localTarget(dest.host)) throw refuse('net.connect', `${String(dest.host)}:${String(dest.port)}`);
    const options = dest.options;
    options.host = typeof dest.host === 'string' && dest.host !== '' ? dest.host : 'localhost';
    // A name (only `localhost` gets here) is resolved through a lookup whose answer is checked: a
    // lookup of the caller's could otherwise answer with any address.
    if (net.isIP(/** @type {string} */ (options.host)) === 0 && (options.lookup === undefined || options.lookup === null || typeof options.lookup === 'function')) {
      options.lookup = loopbackOnly(typeof options.lookup === 'function' ? options.lookup : dnsLookup, 'net.lookup');
    }
    if (dest.holder) {
      dest.holder[0] = options;
      return originals.connect.apply(this, /** @type {any} */ (args));
    }
    const callback = args.at(-1);
    const connect = /** @type {Function} */ (originals.connect);
    return typeof callback === 'function' ? connect.call(this, options, callback) : connect.call(this, options);
  }

  /** @param {string} api @param {Function} original */
  const guardedLookup = (api, original) =>
    function lookup(/** @type {unknown} */ hostname, /** @type {unknown[]} */ ...rest) {
      if (typeof hostname === 'string' && (net.isIP(hostname) !== 0 || /^localhost\.?$/i.test(hostname) || hostname === '')) {
        return original.call(dns, /^localhost\.?$/i.test(hostname) ? 'localhost' : hostname, ...rest);
      }
      const err = refuse(api, String(hostname));
      const callback = rest.at(-1);
      if (typeof callback === 'function') {
        process.nextTick(() => callback(err));
        return undefined;
      }
      if (original === originals.promisesLookup) return Promise.reject(err);
      throw err;
    };

  const dnsLookup = guardedLookup('dns.lookup', originals.lookup);

  /** @param {string} api */
  const refuseAlways = (api) =>
    function refused(/** @type {unknown} */ name, /** @type {unknown[]} */ ...rest) {
      const err = refuse(api, String(name));
      const callback = rest.at(-1);
      if (typeof callback === 'function') {
        process.nextTick(() => callback(err));
        return undefined;
      }
      return Promise.reject(err);
    };

  /** @param {Function} original @param {string} api */
  const guardedDatagram = (original, api) =>
    /** @this {any} */
    function datagram(/** @type {unknown[]} */ ...args) {
      // send(msg, [offset, length,] port, address, cb) / connect(port, address, cb)
      const address = args.find((a, i) => i > 0 && typeof a === 'string');
      if (!localTarget(address)) throw refuse(api, String(address));
      return original.apply(this, args);
    };

  /**
   * The options of a new datagram socket with its lookup (its own, or the guarded dns.lookup Node
   * would take) checked; datagram sockets resolve even IP literals through their lookup.
   * @param {unknown} type
   */
  function datagramOptions(type) {
    /** @type {Record<string, unknown>} */
    const options = type !== null && typeof type === 'object' ? { .../** @type {Record<string, unknown>} */ (type) } : { type };
    if (options.lookup === undefined || typeof options.lookup === 'function') {
      options.lookup = loopbackOnly(typeof options.lookup === 'function' ? options.lookup : dnsLookup, 'dgram.lookup', true);
    }
    return options;
  }
  /** @param {unknown} type @param {unknown} [listener] */
  const guardedCreateSocket = function createSocket(type, listener) {
    return originals.dgramCreateSocket.call(dgram, /** @type {any} */ (datagramOptions(type)), /** @type {any} */ (listener));
  };
  /** @param {unknown} type @param {unknown} [listener] */
  const GuardedSocket = function Socket(type, listener) {
    const target = new.target && new.target !== GuardedSocket ? new.target : originals.dgramSocket;
    return Reflect.construct(originals.dgramSocket, [datagramOptions(type), listener], target);
  };
  GuardedSocket.prototype = originals.dgramSocket.prototype;

  /** @this {unknown} @param {unknown} options */
  const guardedChildSpawn = function spawn(options) {
    // Only true while the kernel's runner starts one of its fixed programs; the options are Node's
    // own then, made from the runner's arguments.
    if (kernelProgramStarting(/** @type {any} */ (options)?.file)) return originals.childSpawn.call(this, /** @type {any} */ (options));
    throw spawnRefused('ChildProcess#spawn');
  };

  // Install. Everything above is prepared, nothing is half patched if a step throws.
  net.Socket.prototype.connect = /** @type {any} */ (guardedConnect);
  /** @type {any} */ (dns).lookup = dnsLookup;
  /** @type {any} */ (dns.promises).lookup = guardedLookup('dns.promises.lookup', originals.promisesLookup);
  for (const m of RESOLVER_METHODS) {
    if (originals.resolver[m]) /** @type {any} */ (dns)[m] = refuseAlways(`dns.${m}`);
    if (originals.promisesResolver[m]) /** @type {any} */ (dns.promises)[m] = refuseAlways(`dns.promises.${m}`);
    if (originals.resolverProto[m]) /** @type {any} */ (dns.Resolver.prototype)[m] = refuseAlways(`dns.Resolver.${m}`);
    if (originals.promisesResolverProto[m]) /** @type {any} */ (dns.promises.Resolver.prototype)[m] = refuseAlways(`dns.promises.Resolver.${m}`);
  }
  dgram.Socket.prototype.send = /** @type {any} */ (guardedDatagram(originals.dgramSend, 'dgram.send'));
  dgram.Socket.prototype.connect = /** @type {any} */ (guardedDatagram(originals.dgramConnect, 'dgram.connect'));
  /** @type {any} */ (dgram).createSocket = guardedCreateSocket;
  /** @type {any} */ (dgram).Socket = GuardedSocket;
  originals.dgramSocket.prototype.constructor = /** @type {any} */ (GuardedSocket);
  for (const m of SPAWN_METHODS) {
    /** @type {any} */ (childProcess)[m] = () => {
      throw spawnRefused(`child_process.${m}`);
    };
  }
  /** @type {any} */ (childProcess.ChildProcess.prototype).spawn = /** @type {any} */ (guardedChildSpawn);
  if (typeof originals.execve === 'function') {
    /** @type {any} */ (process).execve = () => {
      throw spawnRefused('process.execve');
    };
  }
  /** @type {any} */ (cluster).fork = () => {
    throw spawnRefused('cluster.fork');
  };
  const GuardedWorker = function Worker() {
    throw spawnRefused('worker_threads.Worker');
  };
  GuardedWorker.prototype = originals.worker.prototype;
  originals.worker.prototype.constructor = /** @type {any} */ (GuardedWorker);
  /** @type {any} */ (workerThreads).Worker = GuardedWorker;
  /** @type {any} */ (process).binding = function binding(/** @type {string} */ name) {
    if (BLOCKED_BINDINGS.has(name)) throw refuse('process.binding', name);
    return originals.binding.call(process, name);
  };
  /** @type {any} */ (nodeModule).register = () => {
    throw spawnRefused('module.register');
  };
  nodeModule.syncBuiltinESMExports();

  /**
   * Opens a TCP connection to a listed host directly: one resolution of exactly that name, every
   * address must be public unicast, then a connection to one of those literals.
   * @type {EgressTransport}
   */
  const direct = {
    async connect(host) {
      const addresses = await new Promise((resolve, reject) => {
        /** @type {any} */ (originals.lookup).call(dns, host, { all: true, verbatim: true }, (/** @type {any} */ err, /** @type {any} */ list) => (err ? reject(err) : resolve(list)));
      });
      const list = /** @type {Array<{ address: string }>} */ (addresses);
      if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) throw refuse('capability.resolve', `${host} (not public)`);
      let lastError = null;
      for (const { address } of list.slice(0, 4)) {
        try {
          return await rawConnect(address, 443);
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError ?? refuse('capability.connect', host);
    },
  };

  /**
   * A TCP socket the kernel opens itself.
   * @param {string} hostOrPath
   * @param {number | null} port   null for a Unix socket path
   * @returns {Promise<net.Socket>}
   */
  function rawConnect(hostOrPath, port) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      trusted.add(socket);
      const onError = (/** @type {Error} */ err) => {
        socket.destroy();
        reject(err);
      };
      socket.once('error', onError);
      socket.setTimeout(15_000, () => onError(new Error('connect timeout')));
      const done = () => {
        socket.off('error', onError);
        socket.setTimeout(0);
        resolve(socket);
      };
      const connect = /** @type {any} */ (originals.connect);
      if (port === null) connect.call(socket, { path: hostOrPath }, done);
      else connect.call(socket, { host: hostOrPath, port }, done);
    });
  }

  const seam = /** @type {any} */ (options)[TRANSPORT_SEAM];
  const transport = /** @type {EgressTransport} */ (seam ?? (options.transport ? options.transport({ rawConnect }) : direct));

  const handle = {
    reports,
    /**
     * A capability for a list of `host:443` entries.
     * @param {readonly string[]} entries
     */
    capability(entries) {
      return createCapability(entries, transport, () => active === handle);
    },
    /** A socket to a path or host the kernel itself trusts (the splice socket). */
    rawConnect,
    uninstall() {
      if (active !== handle) return;
      net.Socket.prototype.connect = originals.connect;
      /** @type {any} */ (dns).lookup = originals.lookup;
      /** @type {any} */ (dns.promises).lookup = originals.promisesLookup;
      for (const m of RESOLVER_METHODS) {
        if (originals.resolver[m]) /** @type {any} */ (dns)[m] = originals.resolver[m];
        if (originals.promisesResolver[m]) /** @type {any} */ (dns.promises)[m] = originals.promisesResolver[m];
        if (originals.resolverProto[m]) /** @type {any} */ (dns.Resolver.prototype)[m] = originals.resolverProto[m];
        if (originals.promisesResolverProto[m]) /** @type {any} */ (dns.promises.Resolver.prototype)[m] = originals.promisesResolverProto[m];
      }
      originals.dgramSocket.prototype.send = originals.dgramSend;
      originals.dgramSocket.prototype.connect = originals.dgramConnect;
      originals.dgramSocket.prototype.constructor = originals.dgramSocket;
      /** @type {any} */ (dgram).createSocket = originals.dgramCreateSocket;
      /** @type {any} */ (dgram).Socket = originals.dgramSocket;
      for (const m of SPAWN_METHODS) /** @type {any} */ (childProcess)[m] = originals.spawn[m];
      /** @type {any} */ (childProcess.ChildProcess.prototype).spawn = originals.childSpawn;
      if (typeof originals.execve === 'function') /** @type {any} */ (process).execve = originals.execve;
      /** @type {any} */ (cluster).fork = originals.clusterFork;
      originals.worker.prototype.constructor = originals.worker;
      /** @type {any} */ (workerThreads).Worker = originals.worker;
      /** @type {any} */ (process).binding = originals.binding;
      /** @type {any} */ (nodeModule).register = originals.register;
      nodeModule.syncBuiltinESMExports();
      active = null;
    },
  };
  active = handle;
  return handle;
}

/** @typedef {ReturnType<typeof installEgressGuard>} EgressGuard */

/**
 * A capability: a fetch that reaches only its listed hosts, over TLS with the normal certificate
 * and host-name checks, and stops working when the guard is removed.
 * @param {readonly string[]} entries
 * @param {EgressTransport} transport
 * @param {() => boolean} alive
 */
function createCapability(entries, transport, alive) {
  const hosts = new Set();
  for (const entry of entries) {
    const parsed = parseEgressEntry(entry);
    if (!parsed) throw fail('egress_entry', `${JSON.stringify(entry)} is not a public host:443 entry`);
    hosts.add(parsed.host);
  }
  const targets = Object.freeze([...hosts].sort().map((h) => `${h}:443`));

  /** True for a listed host written as it stands (any case, one trailing dot). @param {unknown} host */
  const allows = (host) => {
    if (typeof host !== 'string') return false;
    const bare = host.toLowerCase().replace(/\.$/, '');
    return canonicalHost(bare) === bare && hosts.has(bare);
  };

  /**
   * @param {string | URL | Request} input
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async function capabilityFetch(input, init = {}) {
    if (!alive()) throw blocked('capability.fetch', 'a capability of a removed guard');
    let url;
    let method = init.method ?? 'GET';
    let headers = new Headers(init.headers ?? {});
    /** @type {any} */
    let body = init.body ?? null;
    const signal = init.signal ?? null;
    if (typeof Request !== 'undefined' && input instanceof Request) {
      url = new URL(input.url);
      method = init.method ?? input.method;
      headers = new Headers(init.headers ?? input.headers);
      if (body === null && input.body) body = Buffer.from(await input.arrayBuffer());
    } else {
      url = new URL(String(input));
    }
    if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || url.username || url.password) throw blocked('capability.fetch', url.origin);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!allows(host)) throw blocked('capability.fetch', `${host}:443`);
    if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');

    const payload = await bodyBytes(body);
    if (payload !== null && !headers.has('content-length')) headers.set('content-length', String(payload.length));
    const socket = await transport.connect(host);
    const stream = transport.plain ? socket : tls.connect({ socket, servername: host, ALPNProtocols: ['http/1.1'] });
    /** @type {Record<string, string>} */
    const flat = {};
    headers.forEach((value, name) => {
      flat[name] = value;
    });
    return new Promise((resolve, reject) => {
      // No agent: the request runs over exactly the stream opened above, never a pooled socket.
      const req = https.request({ host, port: 443, defaultPort: 443, method, path: `${url.pathname}${url.search}`, headers: flat, createConnection: () => /** @type {any} */ (stream) });
      const abort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      req.once('error', (err) => {
        signal?.removeEventListener('abort', abort);
        reject(err);
      });
      req.once('response', (res) => {
        const responseHeaders = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
          try {
            responseHeaders.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
          } catch {
            // a header the Fetch standard does not accept is left out
          }
        }
        res.once('close', () => signal?.removeEventListener('abort', abort));
        const status = res.statusCode ?? 502;
        const noBody = status === 204 || status === 304 || method === 'HEAD';
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : /** @type {ReadableStream} */ (Readable.toWeb(res)), { status, statusText: res.statusMessage, headers: responseHeaders }));
      });
      if (payload !== null) req.end(payload);
      else req.end();
    });
  }

  return Object.freeze({
    targets,
    allows,
    fetch: capabilityFetch,
    /**
     * A capability for a subset of these targets; a target this one does not hold is refused.
     * @param {readonly string[]} subset
     */
    narrow(subset) {
      for (const entry of subset) {
        const parsed = parseEgressEntry(entry);
        if (!parsed || !hosts.has(parsed.host)) throw fail('egress_entry', `${entry} is not held by this capability`);
      }
      return createCapability(subset, transport, alive);
    },
  });
}

/** @typedef {ReturnType<typeof createCapability>} EgressCapability */

/**
 * The bytes of a request body.
 * @param {unknown} body
 * @returns {Promise<Buffer | null>}
 */
async function bodyBytes(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (typeof Blob !== 'undefined' && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (typeof (/** @type {any} */ (body)[Symbol.asyncIterator]) === 'function' || typeof (/** @type {any} */ (body).getReader) === 'function') {
    const chunks = [];
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (body)) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw fail('egress_body', 'unsupported request body type');
}

/**
 * A capability without the guard, for embedding and tests: the same host list and URL rules, with
 * the requests made by the given fetch. The companion's command line never uses it.
 * @param {readonly string[]} entries
 * @param {typeof fetch} fetchImpl
 */
export function openCapability(entries, fetchImpl) {
  const hosts = new Set();
  for (const entry of entries) {
    const parsed = parseEgressEntry(entry);
    if (!parsed) throw fail('egress_entry', `${JSON.stringify(entry)} is not a public host:443 entry`);
    hosts.add(parsed.host);
  }
  const targets = Object.freeze([...hosts].sort().map((h) => `${h}:443`));
  /** @param {unknown} host */
  const allows = (host) => typeof host === 'string' && hosts.has(host.toLowerCase().replace(/\.$/, ''));
  return Object.freeze({
    targets,
    allows,
    /** @param {string | URL | Request} input @param {RequestInit} [init] */
    fetch(input, init) {
      const url = new URL(typeof Request !== 'undefined' && input instanceof Request ? input.url : String(input));
      if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || !allows(url.hostname)) return Promise.reject(blocked('capability.fetch', url.host));
      return fetchImpl(input, init);
    },
    /** @param {readonly string[]} subset */
    narrow(subset) {
      for (const entry of subset) {
        const parsed = parseEgressEntry(entry);
        if (!parsed || !hosts.has(parsed.host)) throw fail('egress_entry', `${entry} is not held by this capability`);
      }
      return openCapability(subset, fetchImpl);
    },
  });
}
