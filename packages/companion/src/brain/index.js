// @ts-check
// Building the configured brains. Configuration `brains`: a list of
//   { id, type: 'openai-compat', baseUrl, model, secret?, memoryMb? }        a local or custom server
//   { id, type: 'cloud', preset, model?, secret }                            an OpenAI-compatible cloud preset
//   { id, type: 'anthropic', model?, secret, effort?, showReasoning? }
//   { id, type: 'gemini', model?, secret, showReasoning? }
// `secret` names an entry of the vault's `secrets` namespace (`starpi-companion secret set <name>`).
// A server on this machine (loopback) is a local brain; any other host is a cloud brain, needs https
// on port 443 and must be on the egress list of the module `brains`. Servers elsewhere in the local
// network are refused in this release (the egress guard only lets public hosts out).
import { isIP } from 'node:net';
import { fail } from '../lib/errors.js';
import { NAME } from '../contracts/check.js';
import { canonicalHost, isInternalHost, isLoopbackAddress } from '../egress/hosts.js';
import { ANTHROPIC_HOST, createAnthropicBrain } from './anthropic.js';
import { createGeminiBrain, GEMINI_HOST } from './gemini.js';
import { createOpenAiCompatBrain } from './openai-compat.js';
import { CLOUD_PRESETS } from './presets.js';

export const BRAIN_TYPES = Object.freeze(['openai-compat', 'cloud', 'anthropic', 'gemini']);
/** The module id whose egress entries the brains use. */
export const BRAINS_MODULE = 'brains';
const BRAIN_ID = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Where a base URL points.
 * @param {string} baseUrl
 * @returns {{ locality: 'local' | 'cloud', host: string }}
 */
export function localityOf(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw fail('brain_config', `${JSON.stringify(baseUrl)} is not a URL`);
  }
  const host = canonicalHost(url.hostname) ?? '';
  const loopback = host === 'localhost' || (isIP(host) !== 0 && isLoopbackAddress(host));
  if (loopback) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fail('brain_config', `${baseUrl}: http or https`);
    return { locality: 'local', host };
  }
  if (isInternalHost(host)) throw fail('brain_private_host', `${baseUrl}: model servers elsewhere in the local network are not reachable in this release`);
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443')) throw fail('brain_config', `${baseUrl}: a cloud server needs https on port 443`);
  return { locality: 'cloud', host };
}

/**
 * Problems of the `brains` section.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function checkBrainsConfig(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return ['brains: a list'];
  /** @type {string[]} */
  const problems = [];
  const ids = new Set();
  for (const [i, b] of raw.entries()) {
    const where = `brains[${i}]`;
    if (!b || typeof b !== 'object') {
      problems.push(`${where}: an object`);
      continue;
    }
    if (typeof b.id !== 'string' || !BRAIN_ID.test(b.id) || b.id === 'none') problems.push(`${where}.id: lower case, digits and -, not "none"`);
    else if (ids.has(b.id)) problems.push(`${where}.id: ${b.id} is used twice`);
    else ids.add(b.id);
    if (!BRAIN_TYPES.includes(b.type)) problems.push(`${where}.type: one of ${BRAIN_TYPES.join(', ')}`);
    if (b.type === 'openai-compat' && typeof b.baseUrl !== 'string') problems.push(`${where}.baseUrl: required`);
    if (b.type === 'openai-compat' && typeof b.model !== 'string') problems.push(`${where}.model: required`);
    if (b.type === 'cloud' && !Object.hasOwn(CLOUD_PRESETS, b.preset)) problems.push(`${where}.preset: one of ${Object.keys(CLOUD_PRESETS).join(', ')}`);
    if ((b.type === 'cloud' || b.type === 'anthropic' || b.type === 'gemini') && typeof b.secret !== 'string') problems.push(`${where}.secret: the name of the vault secret with the API key`);
    if (b.secret !== undefined && (typeof b.secret !== 'string' || !NAME.test(b.secret))) problems.push(`${where}.secret: a lower-case name`);
    if (b.memoryMb !== undefined && !(Number.isInteger(b.memoryMb) && b.memoryMb > 0)) problems.push(`${where}.memoryMb: a positive whole number`);
    if (b.model !== undefined && (typeof b.model !== 'string' || b.model.length > 120)) problems.push(`${where}.model: a model id`);
  }
  return problems;
}

/**
 * Builds the brains of a configuration.
 * @param {object} options
 * @param {any[]} [options.config]                    the `brains` section
 * @param {(name: string) => string | null} options.secret   reads a vault secret
 * @param {import('../egress/guard.js').EgressCapability | null} options.capability  of the module `brains`
 * @param {typeof fetch} [options.localFetch]
 * @param {() => Promise<any>} [options.loadSdk]
 * @returns {import('./contract.js').Brain[]}
 */
export function buildBrains({ config = [], secret, capability, localFetch = globalThis.fetch, loadSdk }) {
  const problems = checkBrainsConfig(config);
  if (problems.length > 0) throw fail('brain_config', problems.join('; '));
  /** @param {string} host @param {string} id */
  const cloudFetch = (host, id) => {
    const entry = `${host}:443`;
    if (!capability || !capability.targets.includes(entry)) throw fail('egress_not_listed', `brain ${id} needs ${entry} on the egress list of the module ${BRAINS_MODULE}`);
    return capability.narrow([entry]).fetch;
  };
  return config.map((b) => {
    const apiKey = () => (b.secret ? secret(b.secret) : null);
    switch (b.type) {
      case 'anthropic':
        return createAnthropicBrain({ id: b.id, apiKey, model: b.model, effort: b.effort, showReasoning: b.showReasoning === true, loadSdk, fetch: cloudFetch(ANTHROPIC_HOST, b.id) });
      case 'gemini':
        return createGeminiBrain({ id: b.id, apiKey, model: b.model, showReasoning: b.showReasoning === true, fetch: cloudFetch(GEMINI_HOST, b.id) });
      case 'cloud': {
        const preset = CLOUD_PRESETS[b.preset];
        const { host } = localityOf(preset.baseUrl);
        return createOpenAiCompatBrain({ id: b.id, kind: `cloud:${b.preset}`, baseUrl: preset.baseUrl, model: b.model ?? preset.model, locality: 'cloud', apiKey, hosts: [`${host}:443`], fetch: cloudFetch(host, b.id) });
      }
      default: {
        const { locality, host } = localityOf(b.baseUrl);
        return createOpenAiCompatBrain({
          id: b.id,
          baseUrl: b.baseUrl,
          model: b.model,
          locality,
          apiKey,
          memoryMb: b.memoryMb,
          hosts: locality === 'cloud' ? [`${host}:443`] : [],
          fetch: locality === 'cloud' ? cloudFetch(host, b.id) : localFetch,
        });
      }
    }
  });
}
