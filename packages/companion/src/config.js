// @ts-check
// Configuration: one JSON file (config.json in the configuration folder, or --config), every member
// optional, checked as a whole before anything starts. Paths default to the platform's places for
// per-user data; the data folder and the anchor folder never overlap, and the anchor folder (with
// the deletion list) should live on another medium where that is possible.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { checkRecord, isRecord, oneOf } from './contracts/check.js';
import { MODULE_ID } from './contracts/module.js';
import { normalizeOrigin, DEFAULT_ALLOWED_ORIGINS } from './auth/origins.js';
import { checkBrainsConfig } from './brain/index.js';
import { parseEgressEntry } from './egress/hosts.js';
import { checkKekConfig } from './vault/kek/index.js';
import { fail } from './lib/errors.js';
import { pathsOverlap, readRegularFile } from './lib/fsx.js';
import { PROFILES, DEFAULT_PROFILE } from './profiles/index.js';
import { DEFAULT_PORT } from './server/http.js';

export const CONFIG_FILE = 'config.json';

/**
 * @typedef {object} CompanionConfig
 * @property {string} profile
 * @property {string} host
 * @property {number} port
 * @property {string} configDir
 * @property {string} dataDir
 * @property {string} anchorDir
 * @property {string | null} appDir
 * @property {string[]} allowedOrigins
 * @property {string | null} timeZone
 * @property {{ kek?: any }} vault
 * @property {{ allow: Record<string, string[]> }} egress
 * @property {any[]} brains
 * @property {{ personalToCloud: boolean }} router
 * @property {{ anchorEvery: number, anchorIntervalS: number }} audit
 * @property {{ days: number }} sessions
 * @property {{ budgetMb: number, reserveMb: number }} admission
 * @property {{ concurrency: number, interactiveReserve: number }} scheduler
 * @property {{ level: 'debug' | 'info' | 'warn' | 'error' }} log
 * @property {Record<string, unknown>} modules
 */

/**
 * The default folders of the platform.
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string }} [options]
 */
export function defaultPaths({ env = process.env, platform = process.platform, home = homedir() } = {}) {
  if (platform === 'darwin') {
    const base = join(home, 'Library', 'Application Support', 'starpi-companion');
    return { configDir: base, dataDir: join(base, 'data'), anchorDir: join(base, 'anchors') };
  }
  if (platform === 'win32') {
    const base = join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'starpi-companion');
    return { configDir: base, dataDir: join(base, 'data'), anchorDir: join(base, 'anchors') };
  }
  const xdg = (/** @type {string} */ name, /** @type {string[]} */ fallback) => (env[name] && isAbsolute(env[name]) ? env[name] : join(home, ...fallback));
  return {
    configDir: join(xdg('XDG_CONFIG_HOME', ['.config']), 'starpi-companion'),
    dataDir: join(xdg('XDG_DATA_HOME', ['.local', 'share']), 'starpi-companion'),
    anchorDir: join(xdg('XDG_STATE_HOME', ['.local', 'state']), 'starpi-companion', 'anchors'),
  };
}

/** @param {number} min @param {number} max */
const int = (min, max) => (/** @type {unknown} */ v) => (Number.isInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max ? null : `a whole number from ${min} to ${max}`);
const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v.length > 0 ? null : 'a string');
const bool = (/** @type {unknown} */ v) => (typeof v === 'boolean' ? null : 'true or false');
/** @param {(v: unknown) => string | null} item */
const nested = (item) => item;

/**
 * Every problem of a raw configuration object.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function checkConfig(raw) {
  if (!isRecord(raw)) return ['the configuration is an object'];
  const problems = checkRecord(raw, 'config', {
    $comment: () => null,
    profile: oneOf(Object.keys(PROFILES)),
    host: oneOf(['127.0.0.1', '::1', 'localhost']),
    port: int(1024, 65535),
    dataDir: str,
    anchorDir: str,
    appDir: (v) => (v === null || typeof v === 'string' ? null : 'a folder or null'),
    allowedOrigins: (v) => (Array.isArray(v) && v.length <= 16 && v.every((o) => normalizeOrigin(o) !== null) ? null : 'a list of https origins (http only for loopback)'),
    timeZone: (v) => (v === null || typeof v === 'string' ? null : 'an IANA time zone or null'),
    vault: nested((v) => (isRecord(v) ? null : 'an object')),
    egress: nested((v) => (isRecord(v) ? null : 'an object')),
    brains: () => null,
    router: (v) => checkRecord(v, 'router', { personalToCloud: bool }).join('; ') || null,
    audit: (v) => checkRecord(v, 'audit', { anchorEvery: int(1, 100_000), anchorIntervalS: int(10, 86_400) }).join('; ') || null,
    sessions: (v) => checkRecord(v, 'sessions', { days: int(1, 365) }).join('; ') || null,
    admission: (v) => checkRecord(v, 'admission', { budgetMb: int(256, 1_048_576), reserveMb: int(0, 1_048_576) }).join('; ') || null,
    scheduler: (v) => checkRecord(v, 'scheduler', { concurrency: int(2, 64), interactiveReserve: int(0, 63) }).join('; ') || null,
    log: (v) => checkRecord(v, 'log', { level: oneOf(['debug', 'info', 'warn', 'error']) }).join('; ') || null,
    modules: (v) => (isRecord(v) && Object.keys(v).every((k) => MODULE_ID.test(k)) ? null : 'an object keyed by module id'),
  });
  if (isRecord(raw.vault)) {
    problems.push(...checkRecord(raw.vault, 'vault', { kek: () => null }));
    problems.push(...checkKekConfig(raw.vault.kek));
  }
  problems.push(...checkBrainsConfig(raw.brains));
  if (isRecord(raw.egress)) problems.push(...checkEgressConfig(raw.egress));
  return problems;
}

/**
 * The egress section: { allow: { <module id>: ['host:443', ...] } }. A host may be listed for one
 * module only, so each capability is the only way to its hosts.
 * @param {Record<string, unknown>} egress
 */
export function checkEgressConfig(egress) {
  const problems = checkRecord(egress, 'egress', { allow: (v) => (isRecord(v) ? null : 'an object keyed by module id') });
  if (problems.length > 0 || !isRecord(egress.allow)) return problems;
  /** @type {Map<string, string>} */
  const owner = new Map();
  for (const [moduleId, entries] of Object.entries(egress.allow)) {
    if (!MODULE_ID.test(moduleId)) problems.push(`egress.allow.${moduleId}: not a module id`);
    if (!Array.isArray(entries) || entries.length > 16) {
      problems.push(`egress.allow.${moduleId}: a list of at most 16 host:443 entries`);
      continue;
    }
    for (const entry of entries) {
      const parsed = parseEgressEntry(entry);
      if (!parsed) {
        problems.push(`egress.allow.${moduleId}: ${JSON.stringify(entry)} is not a public host:443 entry`);
        continue;
      }
      const claimed = owner.get(parsed.host);
      if (claimed !== undefined && claimed !== moduleId) problems.push(`egress.allow.${moduleId}: ${parsed.host} is listed for ${claimed} already (one module per host)`);
      owner.set(parsed.host, moduleId);
    }
  }
  return problems;
}

/**
 * Loads and resolves the configuration.
 * @param {object} [options]
 * @param {string} [options.file]        explicit configuration file
 * @param {Partial<{ dataDir: string, anchorDir: string, port: number, appDir: string }>} [options.overrides]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {NodeJS.Platform} [options.platform]
 * @param {string} [options.home]
 * @returns {CompanionConfig & { file: string | null }}
 */
export function loadConfig({ file, overrides = {}, env = process.env, platform, home } = {}) {
  const paths = defaultPaths({ env, platform, home });
  const configFile = file ?? env.STARPI_COMPANION_CONFIG ?? join(paths.configDir, CONFIG_FILE);
  const rawBytes = readRegularFile(configFile, 1024 * 1024);
  if (rawBytes === null && (file !== undefined || env.STARPI_COMPANION_CONFIG)) throw fail('config_missing', `the configuration file ${configFile} does not exist`);
  /** @type {Record<string, any>} */
  let raw = {};
  if (rawBytes !== null) {
    try {
      raw = JSON.parse(rawBytes.toString('utf8'));
    } catch {
      throw fail('config_invalid', `${configFile} is not JSON`);
    }
  }
  const problems = checkConfig(raw);
  if (problems.length > 0) throw fail('config_invalid', `the configuration has problems: ${problems.join('; ')}`, { details: { problems } });
  const base = rawBytes !== null ? resolve(configFile, '..') : paths.configDir;
  const abs = (/** @type {string | undefined} */ p, /** @type {string} */ fallback) => (p === undefined ? fallback : resolve(base, p));
  const dataDir = overrides.dataDir ? resolve(overrides.dataDir) : env.STARPI_COMPANION_DATA_DIR ? resolve(env.STARPI_COMPANION_DATA_DIR) : abs(raw.dataDir, paths.dataDir);
  const anchorDir = overrides.anchorDir ? resolve(overrides.anchorDir) : env.STARPI_COMPANION_ANCHOR_DIR ? resolve(env.STARPI_COMPANION_ANCHOR_DIR) : abs(raw.anchorDir, paths.anchorDir);
  if (pathsOverlap(dataDir, anchorDir)) throw fail('config_invalid', 'the data folder and the anchor folder must not overlap');
  const appDir = overrides.appDir ? resolve(overrides.appDir) : raw.appDir ? resolve(base, raw.appDir) : null;
  if (appDir && (pathsOverlap(appDir, dataDir) || pathsOverlap(appDir, anchorDir))) throw fail('config_invalid', 'the app folder must not overlap the data or anchor folder');
  return {
    file: rawBytes !== null ? configFile : null,
    profile: raw.profile ?? DEFAULT_PROFILE,
    host: raw.host ?? '127.0.0.1',
    port: overrides.port ?? (env.STARPI_COMPANION_PORT ? Number(env.STARPI_COMPANION_PORT) : raw.port ?? DEFAULT_PORT),
    configDir: base,
    dataDir,
    anchorDir,
    appDir,
    allowedOrigins: raw.allowedOrigins ?? [...DEFAULT_ALLOWED_ORIGINS],
    timeZone: raw.timeZone ?? null,
    vault: raw.vault ?? {},
    egress: { allow: raw.egress?.allow ?? {} },
    brains: raw.brains ?? [],
    router: { personalToCloud: raw.router?.personalToCloud ?? true },
    audit: { anchorEvery: raw.audit?.anchorEvery ?? 256, anchorIntervalS: raw.audit?.anchorIntervalS ?? 600 },
    sessions: { days: raw.sessions?.days ?? 30 },
    admission: { budgetMb: raw.admission?.budgetMb ?? 8192, reserveMb: raw.admission?.reserveMb ?? 1024 },
    scheduler: { concurrency: raw.scheduler?.concurrency ?? 4, interactiveReserve: raw.scheduler?.interactiveReserve ?? 1 },
    log: { level: raw.log?.level ?? 'info' },
    modules: raw.modules ?? {},
  };
}
