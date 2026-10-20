// @ts-check
// The first-start checks: what works already and what is still missing, each with a stable code
// the app translates and a plain detail for logs. Local servers (model servers, the embedding
// server, the voice server) are asked over loopback with short timeouts; nothing in the cloud is
// contacted by a check.
import { listServerModels, memoryMb, sizeHint } from './models.js';
import { isLoopbackUrl } from './loopback.js';

/**
 * @typedef {object} Check
 * @property {string} id
 * @property {'ok' | 'info' | 'warn' | 'fail'} state
 * @property {string} code
 * @property {string} detail
 */

/**
 * @param {object} deps
 * @param {import('./hub.js').Hub} deps.hub
 * @param {Array<Record<string, any>>} deps.brains   the configured brain entries
 * @param {string} deps.timeZone
 * @param {number} deps.now
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {AbortSignal} [deps.signal]
 * @returns {Promise<{ checks: Check[], ready: boolean }>}
 */
export async function runChecks({ hub, brains, timeZone, now, fetchImpl, signal }) {
  /** @type {Check[]} */
  const checks = [];
  if (brains.length === 0) {
    checks.push({ id: 'brains', state: 'warn', code: 'no_model', detail: 'no language model is configured; answers are templates until one is added (a local model server, or a cloud model with its key)' });
  }
  for (const brain of brains) {
    const id = `brain:${brain.id}`;
    const base = typeof brain.baseUrl === 'string' ? brain.baseUrl : null;
    if ((brain.type === 'openai-compat' || brain.type === undefined) && base && isLoopbackUrl(base)) {
      const probe = await listServerModels(base, { fetchImpl, signal });
      if (!probe.reachable) checks.push({ id, state: 'fail', code: 'model_server_unreachable', detail: `the model server at ${base} does not answer (${probe.code})` });
      else if (brain.model && probe.models.length > 0 && !probe.models.includes(brain.model)) checks.push({ id, state: 'warn', code: 'model_missing', detail: `the server lists no model ${brain.model}; it offers ${probe.models.slice(0, 5).join(', ')}` });
      else checks.push({ id, state: 'ok', code: 'model_server_ready', detail: `${base} answers${probe.models.length ? ` with ${probe.models.length} models` : ''}` });
    } else {
      checks.push({ id, state: 'info', code: 'cloud_model', detail: `${brain.type} is not probed: a check never reaches the internet` });
    }
  }

  const index = hub.get('retrieval');
  const dense = index?.stats().dense ?? null;
  if (!index) checks.push({ id: 'search', state: 'info', code: 'search_off', detail: 'the search index is not loaded' });
  else if (!dense) checks.push({ id: 'search', state: 'info', code: 'keyword_only', detail: 'no embedding server is configured; search ranks by keywords alone' });
  else {
    const probe = await listServerModels(dense.url, { fetchImpl, signal });
    checks.push(probe.reachable ? { id: 'search', state: 'ok', code: 'embeddings_ready', detail: `${dense.url} answers (model ${dense.model})` } : { id: 'search', state: 'warn', code: 'embeddings_unreachable', detail: `${dense.url} does not answer; search falls back to keywords` });
  }

  const voice = hub.get('voice');
  if (!voice || !voice.describe().configured) checks.push({ id: 'voice', state: 'info', code: 'voice_off', detail: 'no voice server is configured' });
  else {
    const probe = await voice.probe(signal);
    checks.push(probe.ok ? { id: 'voice', state: 'ok', code: 'voice_ready', detail: `${probe.voices} voices` } : { id: 'voice', state: 'warn', code: 'voice_unreachable', detail: `the voice server does not answer (${probe.code})` });
  }

  const feeds = hub.get('feeds');
  for (const source of feeds?.health() ?? []) {
    checks.push({ id: `feed:${source.id}`, state: source.state === 'up' ? 'ok' : source.type === 'csv' ? 'info' : 'warn', code: `feed_${source.state}`, detail: source.detail ?? source.state });
  }

  const local = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(now));
  checks.push({ id: 'time_zone', state: 'info', code: 'time_zone', detail: `${timeZone}, now ${local}` });
  const memory = memoryMb();
  checks.push({ id: 'memory', state: 'info', code: 'memory', detail: `${memory.totalMb} MB in all, ${memory.freeMb} MB free; local models up to ${sizeHint(memory.totalMb).maxParameters} parameters fit` });
  return { checks, ready: !checks.some((c) => c.state === 'fail' || c.code === 'no_model') };
}
