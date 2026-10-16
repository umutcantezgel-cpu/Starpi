// Response headers from one source, scripts/headers.json. The generated vercel.json, the local
// server (scripts/serve.mjs), the build version (scripts/build.mjs), the post-build gate
// (scripts/verify-dist.mjs) and the end-to-end tests all resolve the file through this module, so a
// page cannot run under one policy in production and another one in a preview or a test.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SOURCE = new URL('../headers.json', import.meta.url);

/**
 * @typedef {string | Record<string, string>} ProfileValue  one value, or one per profile with an optional "default"
 * @typedef {{ source: string, profiles?: string[], headers: Record<string, ProfileValue> }} SourceRule
 * @typedef {{ profiles: string[], coreProfiles?: string[], csp: Record<string, ProfileValue>, rules: SourceRule[] }} HeaderConfig
 * @typedef {{ key: string, value: string }} Header
 * @typedef {{ source: string, headers: Header[] }} HeaderRule  the shape of a vercel.json "headers" entry
 */

/** @returns {HeaderConfig} */
export function loadHeaderConfig() {
  return JSON.parse(readFileSync(SOURCE, 'utf8'));
}

const CONFIG = loadHeaderConfig();

/** @type {readonly string[]} Profiles of the static hosts: Vercel (public), self-hosting and the test build. */
export const PROFILES = Object.freeze([...CONFIG.profiles]);

/** @type {readonly string[]} Profiles whose build is served by the local companion, which applies dist/headers.json. */
export const CORE_PROFILES = Object.freeze([...(CONFIG.coreProfiles ?? [])]);

/** @type {readonly string[]} Every profile a build can be made for (STARPI_HEADER_PROFILE). */
export const BUILD_PROFILES = Object.freeze([...PROFILES, ...CORE_PROFILES]);

/** The profile vercel.json is generated from, and the default of a build. */
export const DEFAULT_PROFILE = 'public';

/**
 * Security headers every response must carry with the same value (header parity): a worker runs
 * under the CSP of its own script response, so one weaker response would weaken the app.
 */
export const PARITY_HEADERS = Object.freeze([
  'content-security-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'origin-agent-cluster',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
]);

/** The documented exceptions to parity: the sandboxed frames, by exact path (clean URL, page, script). */
export const FRAME_PATHS = Object.freeze([
  '/render-frame',
  '/render-frame.html',
  '/render-frame.js',
  '/grounding-frame',
  '/grounding-frame.html',
  '/grounding-frame.js',
]);

/** The parity headers a frame rule replaces; every other parity header stays the page's. */
export const FRAME_OWN_HEADERS = Object.freeze(['content-security-policy', 'x-frame-options', 'cross-origin-resource-policy']);

/**
 * @param {ProfileValue} value
 * @param {string} profile
 * @param {string} where for the error message
 */
function valueFor(value, profile, where) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const chosen = Object.hasOwn(value, profile) ? value[profile] : value.default;
    if (typeof chosen === 'string') return chosen;
  }
  throw new Error(`scripts/headers.json: ${where} has no value for the profile "${profile}"`);
}

/**
 * The Content-Security-Policy of a profile, directives in file order.
 * @param {HeaderConfig['csp']} directives
 * @param {string} profile
 */
export function cspFor(directives, profile) {
  return Object.entries(directives)
    .map(([name, value]) => `${name} ${valueFor(value, profile, `csp.${name}`)}`.trim())
    .join('; ');
}

/**
 * The header rules of one profile in file order, in the shape vercel.json uses. A rule that names
 * `profiles` is left out of every other profile. `{{csp}}` stands for the profile's CSP.
 * @param {string} profile
 * @param {HeaderConfig} [config]
 * @returns {HeaderRule[]}
 */
export function resolveHeaderRules(profile, config = CONFIG) {
  const known = [...config.profiles, ...(config.coreProfiles ?? [])];
  if (!known.includes(profile)) throw new Error(`unknown header profile "${profile}" (known: ${known.join(', ')})`);
  /** @type {Record<string, string>} */
  const vars = { csp: cspFor(config.csp, profile) };
  return config.rules
    .filter((rule) => !Array.isArray(rule.profiles) || rule.profiles.includes(profile))
    .map((rule) => ({
      source: rule.source,
      headers: Object.entries(rule.headers).map(([key, raw]) => ({
        key,
        value: valueFor(raw, profile, `${rule.source} ${key}`).replace(/\{\{(\w+)\}\}/g, (_, name) => {
          if (!Object.hasOwn(vars, name)) throw new Error(`scripts/headers.json: unknown placeholder {{${name}}} in ${rule.source} ${key}`);
          return vars[name];
        }),
      })),
    }));
}

/**
 * A vercel.json source pattern as a RegExp. "(.*)" is the only wildcard the file uses; everything
 * else is literal, so "/render-frame" never matches "/render-frame/x" or "/render-frame%2F..".
 * @param {string} source
 */
export function toRegExp(source) {
  const literal = source.split('(.*)').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${literal.join('(.*)')}$`);
}

/**
 * The headers a path is served with: every matching rule applies in file order, and a later rule
 * replaces a header an earlier one set (as on Vercel).
 * @param {HeaderRule[]} rules
 * @param {string} pathname
 * @returns {Map<string, Header>} keyed by the lower-case header name
 */
export function headersFor(rules, pathname) {
  /** @type {Map<string, Header>} */
  const out = new Map();
  for (const rule of rules) {
    if (!toRegExp(rule.source).test(pathname)) continue;
    for (const header of rule.headers) out.set(header.key.toLowerCase(), header);
  }
  return out;
}

/**
 * The parity headers of a header map (see headersFor), as name -> value.
 * @param {Map<string, Header>} headers
 * @param {readonly string[]} [names]
 * @returns {Record<string, string | undefined>}
 */
export function parityOf(headers, names = PARITY_HEADERS) {
  return Object.fromEntries(names.map((name) => [name, headers.get(name)?.value]));
}

/**
 * The parity headers a path must be served with: the page's, and for a sandboxed frame path the
 * frame rule's own CSP, framing and resource policy on top.
 * @param {HeaderRule[]} rules
 * @param {string} pathname
 */
export function expectedParity(rules, pathname) {
  const page = parityOf(headersFor(rules, '/'));
  if (!FRAME_PATHS.includes(pathname)) return page;
  return { ...page, ...parityOf(headersFor(rules, pathname), FRAME_OWN_HEADERS) };
}

/**
 * A stable digest of resolved rules (16 hex characters). It is part of the build version, so a
 * changed header reaches every installed service worker.
 * @param {HeaderRule[]} rules
 */
export function headersDigest(rules) {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex').slice(0, 16);
}

/**
 * A CSP string as directive -> sources.
 * @param {string} csp
 * @returns {Record<string, string[]>}
 */
export function parseCsp(csp) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const directive of csp.split(';')) {
    const [name, ...sources] = directive.trim().split(/\s+/);
    if (name) out[name.toLowerCase()] = sources;
  }
  return out;
}
