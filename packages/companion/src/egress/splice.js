// @ts-check
// The egress splice: the one way out when the companion runs under its systemd user unit with
// IPAddressDeny=any. A second, tiny unit (`starpi-companion egress-splice`) runs this server on a
// Unix socket only the companion may open. Per connection it reads one request head,
//   CONNECT <host>:443 HTTP/1.1
// refuses any host the owner did not list, resolves the host and refuses it when any address is
// not public unicast, connects to one of exactly those addresses and then copies bytes both ways.
// TLS runs end to end between the companion and the provider; this process sees ciphertext only.
// Each connection gives one JSON log line (host, address, result, byte counts), never content.
//
// The transport side (`spliceTransport`) is what the egress guard's capabilities use instead of
// connecting themselves when STARPI_COMPANION_EGRESS_SOCKET is set.
import dns from 'node:dns';
import net from 'node:net';
import { fail } from '../lib/errors.js';
import { isPublicAddress, parseEgressEntry } from './hosts.js';

export const EGRESS_SOCKET_ENV = 'STARPI_COMPANION_EGRESS_SOCKET';
export const SPLICE_LIMITS = Object.freeze({ headBytes: 4096, headMs: 5000, connectMs: 8000, connections: 64, idleMs: 10 * 60_000 });

/** Status line per refusal. */
const REFUSALS = Object.freeze({
  bad_request: '400 Bad Request',
  not_allowed: '403 Forbidden',
  not_public: '403 Forbidden',
  head_timeout: '408 Request Timeout',
  resolve_failed: '502 Bad Gateway',
  connect_failed: '502 Bad Gateway',
  busy: '503 Service Unavailable',
});

/**
 * Parses a request head; null unless it is exactly one CONNECT to a host on port 443.
 * @param {string} head
 * @returns {string | null} the host
 */
export function parseConnect(head) {
  const first = head.split('\r\n', 1)[0];
  const m = /^CONNECT ([a-z0-9.-]{1,253}):443 HTTP\/1\.[01]$/i.exec(first);
  if (!m) return null;
  return parseEgressEntry(`${m[1]}:443`)?.host ?? null;
}

/** @param {string} host @returns {Promise<string[]>} */
const resolveAll = (host) =>
  new Promise((resolve, reject) => {
    dns.lookup(host, { all: true, verbatim: true }, (err, list) => (err ? reject(err) : resolve(list.map((a) => a.address))));
  });

/** @param {string} address @param {number} timeoutMs @returns {Promise<net.Socket>} */
const connectLiteral = (address, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port: 443 });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

/**
 * The splice server (not listening yet).
 * @param {object} options
 * @param {readonly string[]} options.allow     host:443 entries
 * @param {(line: Record<string, unknown>) => void} [options.log]
 * @param {(host: string) => Promise<string[]>} [options.resolve]
 * @param {(address: string, timeoutMs: number) => Promise<net.Socket>} [options.connect]
 * @param {Partial<typeof SPLICE_LIMITS>} [options.limits]
 */
export function createSpliceServer({ allow, log = () => {}, resolve = resolveAll, connect = connectLiteral, limits = {} }) {
  const lim = { ...SPLICE_LIMITS, ...limits };
  const hosts = new Set();
  for (const entry of allow) {
    const parsed = parseEgressEntry(entry);
    if (!parsed) throw fail('egress_entry', `${JSON.stringify(entry)} is not a public host:443 entry`);
    hosts.add(parsed.host);
  }
  let open = 0;

  const server = net.createServer((client) => {
    const started = Date.now();
    /** @type {Record<string, unknown>} */
    const line = { event: 'egress_splice' };
    let settled = false;
    const finish = (/** @type {string} */ result) => {
      if (settled) return;
      settled = true;
      log({ ...line, result, ms: Date.now() - started });
    };
    const refuse = (/** @type {keyof typeof REFUSALS} */ reason) => {
      client.end(`HTTP/1.1 ${REFUSALS[reason]}\r\nEgress-Error: ${reason}\r\nConnection: close\r\n\r\n`);
      finish(reason);
    };
    if (open >= lim.connections) {
      refuse('busy');
      return;
    }
    open += 1;
    client.once('close', () => {
      open -= 1;
      finish('client_closed');
    });
    client.on('error', () => client.destroy());
    let buffer = Buffer.alloc(0);
    const headTimer = setTimeout(() => refuse('head_timeout'), lim.headMs);
    const onData = async (/** @type {Buffer} */ chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > lim.headBytes) {
          clearTimeout(headTimer);
          client.off('data', onData);
          refuse('bad_request');
        }
        return;
      }
      clearTimeout(headTimer);
      client.off('data', onData);
      client.pause();
      const host = parseConnect(buffer.subarray(0, end).toString('latin1'));
      const rest = buffer.subarray(end + 4);
      if (host === null) return refuse('bad_request');
      line.host = host;
      if (!hosts.has(host)) return refuse('not_allowed');
      let addresses;
      try {
        addresses = await resolve(host);
      } catch {
        return refuse('resolve_failed');
      }
      if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a))) return refuse('not_public');
      let upstream = null;
      for (const address of addresses.slice(0, 4)) {
        if (client.destroyed) return finish('client_closed');
        try {
          upstream = await connect(address, lim.connectMs);
          line.address = address;
          break;
        } catch {
          // try the next checked address
        }
      }
      if (!upstream) return refuse('connect_failed');
      client.write(`HTTP/1.1 200 Connection Established\r\nEgress-Address: ${line.address}\r\n\r\n`);
      if (rest.length > 0) upstream.write(rest);
      let up = 0;
      let down = 0;
      client.on('data', (c) => {
        up += c.length;
      });
      upstream.on('data', (c) => {
        down += c.length;
      });
      upstream.setTimeout(lim.idleMs, () => upstream?.destroy());
      upstream.on('error', () => client.destroy());
      upstream.once('close', () => {
        line.up = up;
        line.down = down;
        finish('ok');
        client.end();
      });
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    };
    client.on('data', onData);
  });
  return server;
}

/**
 * The transport of the guard's capabilities through the splice socket.
 * @param {{ socketPath: string }} options
 * @returns {(kernel: { rawConnect: (hostOrPath: string, port: number | null) => Promise<net.Socket> }) => import('./guard.js').EgressTransport}
 */
export function spliceTransport({ socketPath }) {
  return ({ rawConnect }) => ({
    async connect(host) {
      const socket = await rawConnect(socketPath, null);
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
      return await new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        const timer = setTimeout(() => {
          socket.destroy();
          reject(fail('egress_splice', 'the egress unit did not answer in time'));
        }, 15_000);
        const onData = (/** @type {Buffer} */ chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) {
            if (buffer.length > 4096) onError(fail('egress_splice', 'the egress unit sent an oversized head'));
            return;
          }
          clearTimeout(timer);
          socket.off('data', onData);
          socket.off('error', onError);
          const head = buffer.subarray(0, end).toString('latin1');
          if (!/^HTTP\/1\.1 200 /.test(head)) {
            socket.destroy();
            const reason = /Egress-Error: ([a-z_]+)/.exec(head)?.[1] ?? 'refused';
            const err = fail('egress_splice', `the egress unit refused ${host}: ${reason}`);
            /** @type {any} */ (err).reason = reason;
            reject(err);
            return;
          }
          const rest = buffer.subarray(end + 4);
          if (rest.length > 0) socket.unshift(rest);
          resolve(socket);
        };
        const onError = (/** @type {Error} */ err) => {
          clearTimeout(timer);
          socket.destroy();
          reject(err);
        };
        socket.on('data', onData);
        socket.once('error', onError);
      });
    },
  });
}
