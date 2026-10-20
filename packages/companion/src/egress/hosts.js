// @ts-check
// Host names and addresses for the egress decision: reducing what someone wrote (a URL, host:port,
// a bracketed IPv6 literal) to a bare lower-case host, and telling public unicast addresses from
// everything the companion must never reach on a module's behalf (private ranges, loopback,
// link-local and cloud metadata, carrier-grade NAT, multicast, unique-local IPv6, IPv4 hidden in
// IPv6 transition forms). The idea of a host check before every outbound connection follows the
// egress policy of NemoClaw (Apache-2.0, see NOTICE); this file is written for the companion.
import { isIP, isIPv4, isIPv6 } from 'node:net';

/** Name suffixes that only make sense inside a network, never on the public internet. */
const PRIVATE_SUFFIXES = Object.freeze(['.local', '.localhost', '.internal', '.intranet', '.lan', '.home', '.home.arpa', '.corp', '.private']);
/** Names that resolve to the machine itself or to cloud instance metadata. */
const PRIVATE_NAMES = Object.freeze(new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']));
const DNS_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The bare host of a URL, `host:port`, `[v6]:port` or a host, lower case, without a trailing dot;
 * an IPv4-mapped IPv6 address becomes its IPv4 form. Null when the input is not one of these.
 * @param {unknown} value
 * @returns {string | null}
 */
export function canonicalHost(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim().toLowerCase();
  if (text === '' || /[\s\\]/.test(text)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
    try {
      text = new URL(text).hostname;
    } catch {
      return null;
    }
  }
  text = text.replace(/^[^@/]*@/, '');
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return null;
    text = text.slice(1, end);
  } else if ((text.match(/:/g) ?? []).length === 1) {
    text = text.slice(0, text.indexOf(':'));
  }
  text = text.replace(/\.$/, '');
  if (isIPv6(text)) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
    return mapped ? mapped[1] : text;
  }
  if (isIPv4(text) || DNS_NAME.test(text)) return text;
  return null;
}

/** @param {string} address */
function ipv4Parts(address) {
  return address.split('.').map(Number);
}

/** @param {number[]} p */
function internalIPv4(p) {
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && p[2] === 0) || (a === 192 && b === 0 && p[2] === 2) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && p[2] === 100) || (a === 203 && b === 0 && p[2] === 113) || a >= 224
  );
}

/**
 * The eight 16-bit words of an IPv6 address.
 * @param {string} address
 * @returns {number[]}
 */
export function ipv6Words(address) {
  let text = address.split('%')[0];
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const [a, b, c, d] = ipv4Parts(tail[1]);
    text = `${text.slice(0, -tail[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const fill = rest === null ? [] : new Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((w) => parseInt(w || '0', 16));
}

/** @param {number} hi @param {number} lo */
const wordsToIPv4 = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

/**
 * True for an IP literal that is not public unicast.
 * @param {string} address
 */
export function isInternalAddress(address) {
  if (isIPv4(address)) return internalIPv4(ipv4Parts(address));
  if (!isIPv6(address)) return true;
  const w = ipv6Words(address);
  if (w.every((x) => x === 0)) return true;
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true;
  if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xff00) === 0xff00 || (w[0] & 0xffc0) === 0xfec0) return true;
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) return internalIPv4(wordsToIPv4(w[6], w[7]));
  if (w[0] === 0x64 && w[1] === 0xff9b) return internalIPv4(wordsToIPv4(w[6], w[7]));
  if (w[0] === 0x2002) return internalIPv4(wordsToIPv4(w[1], w[2]));
  if (w[0] === 0x2001 && w[1] === 0xdb8) return true;
  return false;
}

/** True for a public unicast IP literal. @param {string} address */
export const isPublicAddress = (address) => isIP(address) !== 0 && !isInternalAddress(address);

/** True for a loopback literal (127/8, ::1, IPv4-mapped 127/8). @param {string} address */
export function isLoopbackAddress(address) {
  if (isIPv4(address)) return address.startsWith('127.');
  if (!isIPv6(address)) return false;
  const w = ipv6Words(address);
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true;
  return w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff && w[6] >> 8 === 127;
}

/**
 * True for a host name or literal that points inside a network.
 * @param {string} host  canonical
 */
export function isInternalHost(host) {
  if (isIP(host) !== 0) return isInternalAddress(host);
  if (PRIVATE_NAMES.has(host) || !host.includes('.')) return true;
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Parses an egress entry `host:443`; only public DNS names and port 443 are accepted.
 * @param {unknown} entry
 * @returns {{ host: string, port: 443 } | null}
 */
export function parseEgressEntry(entry) {
  if (typeof entry !== 'string') return null;
  const m = /^([^:\s]+):443$/.exec(entry.trim().toLowerCase());
  if (!m) return null;
  const host = canonicalHost(m[1]);
  if (host === null || isIP(host) !== 0 || isInternalHost(host)) return null;
  return { host, port: 443 };
}
