// @ts-check
// The brain contract: one request and one event shape for every language model the companion can
// use. A brain is
//   { id, kind, locality: 'none' | 'local' | 'cloud', model, hosts, stream(request, { signal }) }
// and `stream` yields
//   { type: 'text', text } | { type: 'reasoning', text } | { type: 'end', stopReason, model, usage }
// ending with exactly one `end`. Brains never decide where data may go; the router does.
import { fail } from '../lib/errors.js';
import { isDataClass } from '../contracts/data-classes.js';

/** @typedef {'system' | 'user' | 'assistant'} MessageRole */
/** @typedef {{ role: MessageRole, content: string }} BrainMessage */

/**
 * @typedef {object} BrainRequest
 * @property {BrainMessage[]} messages
 * @property {import('../contracts/data-classes.js').DataClass} dataClass
 * @property {number} [maxTokens]
 * @property {number} [temperature]
 * @property {string} [purpose]
 * @property {string} [brain]          a brain id the caller prefers
 */

/**
 * @typedef {{ type: 'text', text: string } | { type: 'reasoning', text: string } | { type: 'end', stopReason: import('./stop-reasons.js').StopReason, model: string | null, usage: { input: number, output: number } | null }} BrainEvent
 */

/**
 * @typedef {object} Brain
 * @property {string} id
 * @property {string} kind
 * @property {import('../contracts/data-classes.js').Locality} locality
 * @property {string | null} model
 * @property {readonly string[]} hosts   host:443 entries it needs (cloud brains)
 * @property {number} [memoryMb]          for local brains: the model's memory, for admission
 * @property {(request: BrainRequest, options: { signal: AbortSignal }) => AsyncIterable<BrainEvent>} stream
 */

export const MAX_MESSAGES = 200;
export const MAX_MESSAGE_CHARS = 200_000;

/**
 * Checks a request before any brain sees it.
 * @param {unknown} request
 * @returns {BrainRequest}
 */
export function checkBrainRequest(request) {
  const r = /** @type {any} */ (request);
  if (!r || typeof r !== 'object') throw fail('brain_request_invalid', 'a request is an object', { status: 400 });
  if (!isDataClass(r.dataClass)) throw fail('brain_request_invalid', 'dataClass is public, personal, sensitive or secret', { status: 400 });
  if (!Array.isArray(r.messages) || r.messages.length === 0 || r.messages.length > MAX_MESSAGES) throw fail('brain_request_invalid', `messages is a list of 1 to ${MAX_MESSAGES}`, { status: 400 });
  for (const m of r.messages) {
    if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > MAX_MESSAGE_CHARS) {
      throw fail('brain_request_invalid', 'each message has a role (system, user, assistant) and text content', { status: 400 });
    }
  }
  if (r.maxTokens !== undefined && !(Number.isInteger(r.maxTokens) && r.maxTokens > 0 && r.maxTokens <= 128_000)) throw fail('brain_request_invalid', 'maxTokens is 1 to 128000', { status: 400 });
  if (r.temperature !== undefined && !(typeof r.temperature === 'number' && r.temperature >= 0 && r.temperature <= 2)) throw fail('brain_request_invalid', 'temperature is 0 to 2', { status: 400 });
  return r;
}

/**
 * The system text and the turns of a request, for APIs that take the system prompt apart.
 * @param {BrainMessage[]} messages
 */
export function splitSystem(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  return { system, turns };
}

/**
 * Throws an HTTP failure of a provider as a CompanionError with a stable code.
 * @param {string} brain
 * @param {Response} response
 */
export async function providerError(brain, response) {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    // the body is not needed
  }
  const status = response.status;
  const code = status === 401 || status === 403 ? 'brain_auth' : status === 404 ? 'brain_not_found' : status === 429 ? 'brain_rate_limited' : status >= 500 ? 'brain_unavailable' : 'brain_bad_request';
  return fail(code, `${brain} answered ${status}${detail ? `: ${detail.replace(/\s+/g, ' ')}` : ''}`, { status: 502, details: { providerStatus: status } });
}

/**
 * A failure while reaching a provider (no answer at all) or from an SDK, as a CompanionError with a
 * stable code. An abort by the caller is passed on unchanged.
 * @param {string} brain
 * @param {unknown} err
 * @param {AbortSignal} signal
 */
export function transportError(brain, err, signal) {
  if (signal.aborted) return err;
  const e = /** @type {any} */ (err);
  if (e?.name === 'CompanionError') return err;
  if (e?.name === 'TimeoutError') return fail('brain_timeout', `${brain} did not answer in time`, { status: 504, cause: err });
  if (typeof e?.status === 'number') {
    const status = e.status;
    const code = status === 401 || status === 403 ? 'brain_auth' : status === 404 ? 'brain_not_found' : status === 429 ? 'brain_rate_limited' : status >= 500 ? 'brain_unavailable' : 'brain_bad_request';
    return fail(code, `${brain} answered ${status}`, { status: 502, cause: err, details: { providerStatus: status } });
  }
  return fail('brain_unreachable', `${brain} could not be reached`, { status: 502, cause: err });
}
