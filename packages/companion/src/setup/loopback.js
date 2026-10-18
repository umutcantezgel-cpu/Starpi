// @ts-check
// Addresses of services on this machine: a local model server, an embedding server, the voice
// server, an MCP server, an MQTT broker. Every module that talks to one checks its address here,
// once, when the module starts, so a typing error never sends a note or a recording anywhere but to
// this machine. The egress guard would refuse another host anyway; this check refuses it earlier
// and with a clear message.
//
// Accepted: `<scheme>://127.0.0.1:<port>/<path>`, `<scheme>://[::1]:<port>/<path>` and
// `<scheme>://localhost:<port>/<path>`, with an explicit port and without user, query or fragment.
import { fail } from '../lib/errors.js';

const LOOPBACK_HOSTS = Object.freeze(new Set(['127.0.0.1', '[::1]', 'localhost']));

/**
 * @typedef {object} LoopbackTarget
 * @property {string} url       normalised, without a trailing slash
 * @property {string} scheme    without the colon
 * @property {string} host      127.0.0.1, ::1 or localhost (brackets removed)
 * @property {number} port
 * @property {string} path      '' or a path starting with '/', without a trailing slash
 */

/**
 * Checks an address of a local service.
 * @param {unknown} value
 * @param {string} label      where the address was configured, for the message
 * @param {{ schemes?: readonly string[] }} [options]  default ['http']
 * @returns {LoopbackTarget}
 */
export function parseLoopbackUrl(value, label, { schemes = ['http'] } = {}) {
  const refuse = (/** @type {string} */ why) => fail('loopback_only', `${label}: ${why}`, { status: 400 });
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) throw refuse('an address like http://127.0.0.1:8080');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw refuse('not an address');
  }
  const scheme = url.protocol.replace(/:$/, '');
  if (!schemes.includes(scheme)) throw refuse(`the scheme must be ${schemes.join(' or ')}`);
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw refuse('only 127.0.0.1, [::1] or localhost (services on this machine)');
  if (url.port === '') throw refuse('name the port explicitly');
  if (url.username || url.password) throw refuse('no user or password in the address');
  if (url.search || url.hash) throw refuse('no query or fragment');
  const path = url.pathname.replace(/\/+$/, '');
  return Object.freeze({
    url: `${scheme}://${url.host}${path}`,
    scheme,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port),
    path,
  });
}

/**
 * Whether a value is such an address (no exception).
 * @param {unknown} value
 * @param {{ schemes?: readonly string[] }} [options]
 */
export function isLoopbackUrl(value, options) {
  try {
    parseLoopbackUrl(value, 'address', options);
    return true;
  } catch {
    return false;
  }
}
