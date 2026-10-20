// @ts-check
// Hints for choosing a local model: what the model servers on this machine offer (their
// OpenAI-shaped `GET <base>/models` route) and which model sizes the machine's memory can hold. The
// hints only suggest; nothing is downloaded or changed.
import { totalmem, freemem } from 'node:os';
import { isLoopbackUrl } from './loopback.js';
import { trimTrailingSlashes } from '../lib/text.js';

export const PROBE_TIMEOUT_MS = 2_000;

/**
 * Model sizes by memory, for 4-bit quantised weights with room for the rest of the system.
 * @param {number} totalMb
 */
export function sizeHint(totalMb) {
  if (totalMb < 6_000) return { maxParameters: '1-3 billion', note: 'a small model; answers are short and plain' };
  if (totalMb < 12_000) return { maxParameters: '3-8 billion', note: 'a mid-sized model fits next to other programs' };
  if (totalMb < 24_000) return { maxParameters: '8-14 billion', note: 'a larger model fits when few other programs run' };
  if (totalMb < 48_000) return { maxParameters: '14-32 billion', note: 'a large model fits; the first answer takes longer to start' };
  return { maxParameters: '32-70 billion', note: 'a very large model fits; check its speed before relying on it' };
}

/**
 * The models a local server lists, or why it could not be asked.
 * @param {string} baseUrl  an OpenAI-shaped base, e.g. http://127.0.0.1:11434/v1
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<{ reachable: boolean, models: string[], code: string | null }>}
 */
export async function listServerModels(baseUrl, { fetchImpl = globalThis.fetch, signal } = {}) {
  if (!isLoopbackUrl(baseUrl)) return { reachable: false, models: [], code: 'not_local' };
  const limit = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${trimTrailingSlashes(baseUrl)}/models`, { headers: { accept: 'application/json' }, redirect: 'error', signal: signal ? AbortSignal.any([signal, limit]) : limit });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { reachable: true, models: [], code: `http_${res.status}` };
    }
    const text = await res.text();
    const parsed = text.length <= 1024 * 1024 ? JSON.parse(text) : null;
    const list = Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : [];
    const models = list.map((/** @type {any} */ m) => (typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : null)).filter((/** @type {unknown} */ m) => typeof m === 'string').slice(0, 200);
    return { reachable: true, models, code: null };
  } catch {
    return { reachable: false, models: [], code: limit.aborted ? 'timeout' : 'unreachable' };
  }
}

/** The machine's memory in MB. */
export const memoryMb = () => ({ totalMb: Math.round(totalmem() / 1_048_576), freeMb: Math.round(freemem() / 1_048_576) });
