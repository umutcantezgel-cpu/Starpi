#!/usr/bin/env node
// Writes the AI layer's model catalog snapshot (src/js/ai/catalog/snapshot.json) and the Python
// backend's copy of the NVIDIA allowlist (backend/core/nvidia_catalog.json).
//
// The snapshot holds curated default models per provider with their capability flags, price hints
// and role candidates (fast, balanced, max). Its NVIDIA section is generated from
// src/js/models/nvidia-catalog.js. When a provider's key is in the environment (<PROVIDER>_API_KEY,
// or the first of <PROVIDER>_API_KEYS), its live model list refreshes the curated entries: context
// and output limits from the list, price hints from lists that carry them, and `listed: false` for
// a curated model the list no longer names. Models the list adds are only counted; curating them is
// a manual step. Without keys the curated file is kept as it is (normalized).
//
// Keys are only ever sent to the provider's own API root; nothing printed contains a key, a header
// or a response body: only provider names, counts and HTTP status codes.
//
// Usage: npm run models:sync                 rewrite both files (live lists for providers with keys)
//        npm run models:sync -- --offline    rewrite both files without asking any provider
//        npm run models:sync -- --check      exit 1 if either file is outdated or invalid (offline, changes nothing)
// Exit codes: 0 ok, 1 outdated or invalid, 2 the snapshot cannot be read.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCaps } from '../src/js/ai/contract.js';
import { modelListRequest, parseModelList, SNAPSHOT_FORMAT } from '../src/js/ai/catalog/models.js';
import { PROVIDER_ORDER, PROVIDERS } from '../src/js/ai/catalog/providers.js';
import { directTransport } from '../src/js/ai/transport.js';
import { catalogJson, nvidiaSnapshotSection } from '../src/js/models/nvidia-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAPSHOT_FILE = 'src/js/ai/catalog/snapshot.json';
export const NVIDIA_MIRROR = 'backend/core/nvidia_catalog.json';

/** Providers whose live list can refresh the snapshot, with the environment names of their keys. */
export const LIVE_PROVIDERS = Object.freeze(['anthropic', 'openai', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'openrouter']);
/** Providers that have a snapshot section (the on-device engines are described by their own catalogs). */
const SECTION_PROVIDERS = PROVIDER_ORDER.filter((id) => id !== 'webgpu' && id !== 'wasm');

const CAPS_ORDER = ['text', 'vision', 'pdf', 'tools', 'parallelTools', 'reasoning', 'reasoningVisible', 'search', 'imageOut', 'audioIn', 'live', 'json', 'contextTokens', 'maxOutput', 'priceIn', 'priceOut', 'latency', 'free', 'local', 'verified'];
const MODEL_ORDER = ['id', 'label', 'vendor', 'listed', 'caps'];
const ROLE_ORDER = ['fast', 'balanced', 'max'];

/**
 * @param {Record<string, unknown>} value
 * @param {string[]} order
 */
function ordered(value, order) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of order) if (value[key] !== undefined) out[key] = value[key];
  for (const key of Object.keys(value).sort()) if (!order.includes(key) && value[key] !== undefined) out[key] = value[key];
  return out;
}

/**
 * The snapshot in its canonical form: providers in catalog order, the NVIDIA section generated,
 * fields in a fixed order, `listed` only where it is false.
 * @param {any} snapshot
 */
export function normalizeSnapshot(snapshot) {
  /** @type {Record<string, unknown>} */
  const providers = {};
  for (const id of SECTION_PROVIDERS) {
    const section = id === 'nvidia' ? nvidiaSnapshotSection() : (snapshot?.providers?.[id] ?? { roles: {}, models: [] });
    providers[id] = {
      roles: ordered({ ...section.roles }, ROLE_ORDER),
      models: (section.models ?? []).map((/** @type {any} */ m) => ordered({ ...m, listed: m.listed === false ? false : undefined, caps: ordered({ ...m.caps }, CAPS_ORDER) }, MODEL_ORDER)),
    };
  }
  return { format: SNAPSHOT_FORMAT, ...(snapshot?.note ? { note: snapshot.note } : {}), providers };
}

/**
 * Problems of a snapshot: unknown providers, duplicate ids, invalid capability records, role
 * candidates that are not in the section.
 * @param {any} snapshot
 * @returns {string[]}
 */
export function validateSnapshot(snapshot) {
  /** @type {string[]} */
  const problems = [];
  if (snapshot?.format !== SNAPSHOT_FORMAT) problems.push(`format: ${SNAPSHOT_FORMAT} expected`);
  for (const [id, section] of Object.entries(snapshot?.providers ?? {})) {
    if (!Object.hasOwn(PROVIDERS, id)) problems.push(`${id}: unknown provider`);
    const models = Array.isArray(/** @type {any} */ (section)?.models) ? /** @type {any[]} */ (/** @type {any} */ (section).models) : [];
    const ids = models.map((m) => m?.id);
    if (new Set(ids).size !== ids.length) problems.push(`${id}: duplicate model ids`);
    for (const m of models) {
      if (typeof m?.id !== 'string' || !m.id) problems.push(`${id}: model without id`);
      if (typeof m?.label !== 'string' || !m.label) problems.push(`${id}/${m?.id}: label expected`);
      for (const p of validateCaps(m?.caps)) problems.push(`${id}/${m?.id}: ${p}`);
    }
    for (const [role, model] of Object.entries(/** @type {any} */ (section)?.roles ?? {})) {
      if (!ROLE_ORDER.includes(role)) problems.push(`${id}: unknown role ${role}`);
      if (!ids.includes(model)) problems.push(`${id}: role ${role} names ${String(model)}, which is not in the section`);
    }
  }
  return problems;
}

/**
 * The snapshot section of a provider refreshed from its live list.
 * @param {any} section
 * @param {import('../src/js/ai/catalog/models.js').LiveModel[]} live
 * @returns {{ section: any, listed: number, unlisted: number, added: number }}
 */
export function refreshSection(section, live) {
  const byId = new Map(live.map((m) => [m.id, m]));
  let listed = 0;
  const models = (section?.models ?? []).map((/** @type {any} */ m) => {
    const found = byId.get(m.id);
    if (!found) return { ...m, listed: false };
    listed += 1;
    const caps = { ...m.caps };
    if (Number.isInteger(found.contextTokens) && /** @type {number} */ (found.contextTokens) > 0) caps.contextTokens = found.contextTokens;
    if (Number.isInteger(found.maxOutput) && /** @type {number} */ (found.maxOutput) > 0) caps.maxOutput = Math.min(/** @type {number} */ (found.maxOutput), caps.contextTokens);
    if (typeof found.hints?.priceIn === 'number') caps.priceIn = found.hints.priceIn;
    if (typeof found.hints?.priceOut === 'number') caps.priceOut = found.hints.priceOut;
    return { ...m, listed: undefined, caps };
  });
  const curated = new Set(models.map((/** @type {any} */ m) => m.id));
  const added = live.filter((m) => !curated.has(m.id)).length;
  return { section: { ...section, models }, listed, unlisted: models.length - listed, added };
}

/**
 * The first key of a provider in the environment.
 * @param {string} provider
 * @param {Record<string, string | undefined>} env
 */
export function keyFromEnv(provider, env) {
  const name = provider.toUpperCase();
  const single = env[`${name}_API_KEY`]?.trim();
  if (single) return single;
  return env[`${name}_API_KEYS`]?.split(',').map((k) => k.trim()).find(Boolean) ?? null;
}

/**
 * @param {string} file
 */
function readOptional(file) {
  try {
    return readFileSync(path.join(ROOT, file), 'utf8');
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 */
export function snapshotText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, fetch?: import('../src/js/ai/transport.js').FetchLike, log?: (line: string) => void, error?: (line: string) => void, write?: boolean }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const log = io.log ?? ((line) => console.log(line));
  const error = io.error ?? ((line) => console.error(line));
  const check = argv.includes('--check');
  const offline = check || argv.includes('--offline');

  const currentText = readOptional(SNAPSHOT_FILE);
  /** @type {any} */
  let current;
  try {
    current = JSON.parse(currentText ?? '');
  } catch {
    error(`${SNAPSHOT_FILE} cannot be read as JSON`);
    return 2;
  }

  let next = normalizeSnapshot(current);
  if (!offline) {
    for (const provider of LIVE_PROVIDERS) {
      const key = keyFromEnv(provider, env);
      if (!key) continue;
      const built = modelListRequest(/** @type {any} */ (provider));
      const base = PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (provider)].baseUrl;
      if (!built || !base) continue;
      try {
        const transport = directTransport(base, key, undefined, { provider: /** @type {any} */ (provider), fetch: io.fetch });
        const res = await transport(null, built, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          error(`${provider}: model list failed (HTTP ${res.status}); curated entries kept`);
          continue;
        }
        const live = parseModelList(/** @type {any} */ (provider), await res.json());
        const refreshed = refreshSection(/** @type {any} */ (next.providers)[provider], live);
        /** @type {any} */ (next.providers)[provider] = refreshed.section;
        log(`${provider}: ${refreshed.listed} curated models listed, ${refreshed.unlisted} not listed, ${refreshed.added} more live models not curated`);
      } catch (err) {
        const code = err && typeof err === 'object' && 'code' in err ? String(/** @type {any} */ (err).code) : 'network';
        error(`${provider}: model list failed (${code.replace(/[^a-z_]/gi, '').slice(0, 40)}); curated entries kept`);
      }
    }
    next = normalizeSnapshot(next);
  }

  const problems = validateSnapshot(next);
  if (problems.length) {
    for (const p of problems) error(`${SNAPSHOT_FILE}: ${p}`);
    return 1;
  }

  const expected = snapshotText(next);
  const mirror = catalogJson();
  const files = /** @type {const} */ ([
    [SNAPSHOT_FILE, currentText, expected],
    [NVIDIA_MIRROR, readOptional(NVIDIA_MIRROR), mirror],
  ]);
  let outdated = false;
  for (const [file, have, want] of files) {
    if (have === want) {
      log(`${file} is up to date`);
    } else if (check) {
      error(`${file} is outdated; run npm run models:sync`);
      outdated = true;
    } else {
      if (io.write !== false) writeFileSync(path.join(ROOT, file), want);
      log(`${file} updated`);
    }
  }
  return outdated ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
