// @ts-check
// Mode A: the companion serves a build of the Starpi app from its own loopback origin. The folder
// must hold `headers.json` written by the app build for the profile `companion` ({ profile, digest,
// rules }); every file is answered with the headers of the rules that match its path (a later rule
// replaces a header of an earlier one), exactly as the hosted site applies them.
//
// Path rules: GET and HEAD only; no `.` or `..` segment (also not percent-encoded), no encoded
// slash or backslash, no NUL, no dot file; the real path must stay inside the folder; the file is
// opened without following a final link and must be a regular file with one hard link.
// `index.html` answers `/` and page navigations to paths without a file extension.
import { closeSync, constants, createReadStream, fstatSync, openSync, realpathSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { fail } from '../lib/errors.js';
import { readRegularFile } from '../lib/fsx.js';

export const HEADERS_FILE = 'headers.json';
const NOFOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;

const UTF8 = '; charset=utf-8';
const TYPES = Object.freeze(/** @type {Record<string, string>} */ ({
  '.css': `text/css${UTF8}`,
  '.html': `text/html${UTF8}`,
  '.ico': 'image/x-icon',
  '.js': `text/javascript${UTF8}`,
  '.json': `application/json${UTF8}`,
  '.map': `application/json${UTF8}`,
  '.mjs': `text/javascript${UTF8}`,
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': `text/plain${UTF8}`,
  '.wasm': 'application/wasm',
  '.webmanifest': `application/manifest+json${UTF8}`,
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}));
/** Headers a build may never set for the companion (it sets these itself, per request). */
const RESERVED = /^(?:access-control-.*|set-cookie|content-length|transfer-encoding|connection|keep-alive|upgrade|content-type)$/i;

/** @typedef {{ source: string, headers: Array<{ key: string, value: string }> }} HeaderRule */

/** @param {string} source */
function sourcePattern(source) {
  const parts = source.split('(.*)').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${parts.join('(.*)')}$`);
}

/**
 * Reads and checks headers.json of an app folder.
 * @param {string} dir
 * @returns {Array<{ pattern: RegExp, headers: Array<{ key: string, value: string }> }>}
 */
export function loadHeaderRules(dir) {
  const raw = readRegularFile(join(dir, HEADERS_FILE), 1024 * 1024);
  if (raw === null) throw fail('app_headers_missing', `${HEADERS_FILE} is missing in the app folder (build the app with the companion profile)`);
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw fail('app_headers_invalid', `${HEADERS_FILE} is not JSON`);
  }
  if (parsed?.profile !== 'companion' || !Array.isArray(parsed.rules)) throw fail('app_headers_invalid', `${HEADERS_FILE} is not the companion profile`);
  return parsed.rules.map((/** @type {HeaderRule} */ rule) => {
    if (typeof rule?.source !== 'string' || !Array.isArray(rule.headers)) throw fail('app_headers_invalid', 'a header rule has a source and headers');
    for (const h of rule.headers) {
      if (typeof h?.key !== 'string' || typeof h.value !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(h.key) || /[\r\n]/.test(h.value)) throw fail('app_headers_invalid', 'a header has a plain name and value');
      if (RESERVED.test(h.key)) throw fail('app_headers_invalid', `${h.key} may not be set by the app build`);
    }
    return { pattern: sourcePattern(rule.source), headers: rule.headers };
  });
}

/** Percent-decoding that answers null instead of throwing on a broken escape. @param {string} raw */
function decodePath(raw) {
  return /%(?![0-9a-f]{2})/i.test(raw) ? null : (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return null;
    }
  })();
}

/**
 * The folder-relative file a request path names, or null when the path breaks a rule.
 * @param {string} rawPath  the path as received (still percent-encoded)
 * @returns {string[] | null} segments
 */
export function safeSegments(rawPath) {
  if (/%2f|%5c|%00/i.test(rawPath) || rawPath.includes('\\') || rawPath.includes('\0')) return null;
  const decoded = decodePath(rawPath);
  if (decoded === null) return null;
  const segments = decoded.split('/').filter((s) => s !== '');
  if (segments.some((s) => s === '.' || s === '..' || s.startsWith('.') || s.includes('\0'))) return null;
  return segments;
}

/**
 * @param {{ dir: string }} options
 */
export function createStaticSite({ dir }) {
  const root = realpathSync(dir);
  const rules = loadHeaderRules(root);

  /**
   * The headers of a path: every matching rule in file order, a later one replacing a header of an
   * earlier one (compared without case).
   * @param {string} pathname
   * @returns {Record<string, string>}
   */
  function headersFor(pathname) {
    /** @type {Record<string, { key: string, value: string }>} */
    const byName = {};
    rules.filter((rule) => rule.pattern.test(pathname)).forEach((rule) => rule.headers.forEach((h) => {
      byName[h.key.toLowerCase()] = h;
    }));
    return Object.fromEntries(Object.values(byName).map((h) => [h.key, h.value]));
  }

  /** @param {string[]} segments @returns {{ fd: number, size: number, file: string } | null} */
  function open(segments) {
    const file = join(root, ...segments);
    let real;
    try {
      real = realpathSync(file);
    } catch {
      return null;
    }
    if (real !== root && !real.startsWith(`${root}${sep}`)) return null;
    let fd;
    try {
      fd = openSync(real, constants.O_RDONLY | NOFOLLOW);
    } catch {
      return null;
    }
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink > 1 || segments.at(-1) === HEADERS_FILE) {
      closeSync(fd);
      return null;
    }
    return { fd, size: info.size, file: real };
  }

  return {
    root,
    headersFor,
    /**
     * Answers a GET or HEAD for the app; false when there is no such file.
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {string} rawPath
     */
    serve(req, res, rawPath) {
      const segments = safeSegments(rawPath);
      if (segments === null) return false;
      const navigation = req.headers['sec-fetch-mode'] === 'navigate' || String(req.headers.accept ?? '').includes('text/html');
      let hit = segments.length === 0 ? open(['index.html']) : open(segments);
      let pathname = segments.length === 0 ? '/' : `/${segments.join('/')}`;
      if (!hit && navigation && extname(segments.at(-1) ?? '') === '') {
        hit = open(['index.html']);
        pathname = '/';
      }
      if (!hit) return false;
      const type = TYPES[extname(hit.file).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { ...headersFor(pathname), 'Content-Type': type, 'Content-Length': String(hit.size) });
      if (req.method === 'HEAD') {
        closeSync(hit.fd);
        res.end();
        return true;
      }
      createReadStream('', { fd: hit.fd, autoClose: true }).pipe(res);
      return true;
    },
  };
}

/** @typedef {ReturnType<typeof createStaticSite>} StaticSite */
