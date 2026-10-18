// @ts-check
// The module contract: how a feature plugs into the kernel without touching it. A module is a
// plain object
//   { id, version, title?, egress?, namespaces?, eventTypes?, projections?, routes?, start?, stop? }
// `egress` lists the `host:443` entries the module needs (each host may be claimed by one module
// only; the owner must also list them in the configuration), `namespaces` the vault namespaces it
// reads and writes, `routes` its HTTP routes (all below /v1/<id>/), and `start(ctx)` receives the
// kernel services narrowed to what the module declared. A module can never spawn a process.
import { checkRecord, isRecord, matches, text } from './check.js';
import { ACCESS_LEVELS } from './roles.js';

/** Module ids: lower case, digits and `-`, 2 to 32 characters. */
export const MODULE_ID = /^[a-z][a-z0-9-]{1,31}$/;
/** Vault namespaces: lower case, digits and `_`, 2 to 32 characters. */
export const NAMESPACE = /^[a-z][a-z0-9_]{1,31}$/;
/** An egress entry: a DNS name and port 443. */
export const EGRESS_ENTRY = /^(?=.{4,260}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+:443$/;
const METHODS = Object.freeze(['GET', 'POST', 'PUT', 'DELETE']);
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * @typedef {object} ModuleRoute
 * @property {'GET' | 'POST' | 'PUT' | 'DELETE'} method
 * @property {string} path      below /v1/<module id>/, may hold `:name` parameters
 * @property {import('./roles.js').Access} access
 * @property {(req: any) => Promise<any> | any} handler
 * @property {boolean} [stream] answers with server-sent events
 */

/**
 * @typedef {object} CompanionModule
 * @property {string} id
 * @property {string} version
 * @property {string} [title]
 * @property {string[]} [egress]
 * @property {string[]} [namespaces]
 * @property {import('./event.js').EventType[]} [eventTypes]
 * @property {import('../store/sqlite.js').Projection[]} [projections]
 * @property {ModuleRoute[]} [routes]
 * @property {(ctx: any) => Promise<void> | void} [start]
 * @property {() => Promise<void> | void} [stop]
 */

/** @param {(v: unknown) => string | null} item @param {number} max */
const listOf = (item, max) => (/** @type {unknown} */ v) => {
  if (!Array.isArray(v) || v.length > max) return `a list of at most ${max} entries`;
  for (const [i, entry] of v.entries()) {
    const problem = item(entry);
    if (problem) return `[${i}] ${problem}`;
  }
  return new Set(v).size === v.length ? null : 'entries must be unique';
};

/** @param {unknown} v */
const fn = (v) => (typeof v === 'function' ? null : 'a function');

/**
 * Problems of a module object.
 * @param {unknown} mod
 * @returns {string[]}
 */
export function checkModule(mod) {
  const problems = checkRecord(
    mod,
    'module',
    {
      id: matches(MODULE_ID, 'lower case, digits and -, 2 to 32 characters'),
      version: matches(VERSION, 'a version like 1.0.0'),
      title: text(80),
      egress: listOf(matches(EGRESS_ENTRY, 'host:443'), 16),
      namespaces: listOf(matches(NAMESPACE, 'a namespace name'), 16),
      eventTypes: (v) => (Array.isArray(v) ? null : 'a list'),
      projections: (v) => (Array.isArray(v) ? null : 'a list'),
      routes: (v) => (Array.isArray(v) ? null : 'a list'),
      start: fn,
      stop: fn,
    },
    { required: ['id', 'version'] },
  );
  if (problems.length > 0) return problems;
  const m = /** @type {CompanionModule} */ (mod);
  for (const [i, route] of (m.routes ?? []).entries()) {
    const where = `module.routes[${i}]`;
    if (!isRecord(route)) {
      problems.push(`${where}: an object`);
      continue;
    }
    if (!METHODS.includes(/** @type {string} */ (route.method))) problems.push(`${where}.method: one of ${METHODS.join(', ')}`);
    if (typeof route.path !== 'string' || !/^\/[a-z0-9:/_-]*$/.test(route.path) || route.path.includes('//')) problems.push(`${where}.path: a path like /items/:id`);
    if (!ACCESS_LEVELS.includes(/** @type {any} */ (route.access))) problems.push(`${where}.access: one of ${ACCESS_LEVELS.join(', ')}`);
    if (typeof route.handler !== 'function') problems.push(`${where}.handler: a function`);
  }
  return problems;
}
