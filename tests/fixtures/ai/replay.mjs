// Helpers of the adapter tests: read a recorded event-stream fixture and feed it through an
// adapter's pure halves, run a request end to end through the stream driver, and build requests.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSseParser } from '../../../src/js/ai/sse.js';
import { stream } from '../../../src/js/ai/stream.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A tool every provider accepts. */
export const LOOKUP = Object.freeze({ name: 'lookup', description: 'Looks a word up.', schema: { type: 'object', properties: { query: { type: 'string' } } }, sideEffects: false });

/**
 * @param {string} dir  dialect folder under tests/fixtures/ai
 * @param {string} name file name without .sse
 */
export function fixture(dir, name) {
  return readFileSync(path.join(HERE, dir, `${name}.sse`), 'utf8');
}

/**
 * A one-message request.
 * @param {string} provider
 * @param {string} model
 * @param {string} text
 * @param {Record<string, unknown>} [extra]
 * @returns {any}
 */
export function request(provider, model, text, extra = {}) {
  return { provider, model, messages: [{ role: 'user', content: [{ type: 'text', text }] }], ...extra };
}

/**
 * The events an adapter's parser makes of a recorded stream, fed in pieces of `chunk` characters
 * (so events and lines split across reads are covered), then its finish hook.
 * @param {any} adapter  a wire adapter, or an object with createState and parseEvent
 * @param {any} req
 * @param {string} text
 * @param {number} [chunk]
 * @returns {any[]}
 */
export function replay(adapter, req, text, chunk = 37) {
  const state = adapter.createState ? adapter.createState(req) : {};
  /** @type {any[]} */
  const out = [];
  const parser = createSseParser((ev) => out.push(...adapter.parseEvent(ev, state)));
  for (let i = 0; i < text.length; i += chunk) parser.push(text.slice(i, i + chunk));
  parser.end();
  if (adapter.finish) out.push(...adapter.finish(state));
  return out;
}

/**
 * All events of one call through the stream driver.
 * @param {any} adapter
 * @param {any} req
 * @param {any} transport
 * @param {import('../../../src/js/ai/stream.js').StreamOptions} [options]
 */
export async function run(adapter, req, transport, options) {
  const events = [];
  for await (const ev of stream(adapter, req, transport, options)) events.push(ev);
  return events;
}

/**
 * @param {any[]} events
 * @param {string} type
 */
export const ofType = (events, type) => events.filter((e) => e.type === type);

/**
 * @param {any[]} events
 * @param {'text' | 'reasoning'} type
 */
export const joined = (events, type) => ofType(events, type).map((e) => e.delta ?? '').join('');
