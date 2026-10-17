// Shared test helpers for the orchestration tests: scripted SDK adapters that answer each call from
// a script instead of a network, a fake clock, and router dependencies wired to both. The adapters
// run through the real complete() and stream driver, so every event sequence is the contract's.
import { AiError } from '../../src/js/ai/errors.js';
import { complete } from '../../src/js/ai/index.js';
import { createPurposeCache } from '../../src/js/ai/router.js';
import { ModelWheel } from '../../src/js/ai/wheel.js';

/**
 * One scripted answer. `text` streams as one text event; `error` ends the call with that AiError
 * code; `stop` sets the stop reason (default end_turn); `served` is the model the start event names;
 * `advanceMs` moves the fake clock while the call runs.
 * @typedef {{ text?: string, error?: import('../../src/js/ai/errors.js').AiErrorCode, retryAfterMs?: number, stop?: import('../../src/js/ai/contract.js').StopReason, served?: string, advanceMs?: number }} Scripted
 */

/** @typedef {{ provider: string, model: string, req: import('../../src/js/ai/contract.js').AiRequest }} Call */

/** A clock tests move by hand. */
export function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    /** @param {number} ms */
    advance(ms) {
      t += ms;
    },
  };
}

/**
 * Scripted adapters for several providers. `script(call, index)` returns the answer of a call; the
 * index counts the calls to the same model.
 * @param {(call: Call, index: number) => Scripted | Promise<Scripted>} script
 * @param {{ advance?: (ms: number) => void }} [clock]
 */
export function scriptedProviders(script, clock) {
  /** @type {Call[]} */
  const calls = [];
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {(provider: import('../../src/js/ai/contract.js').ProviderId) => import('../../src/js/ai/stream.js').SdkAdapter} */
  const adapter = (provider) => ({
    kind: 'sdk',
    id: provider,
    dialect: 'scripted',
    async *stream(req) {
      const call = { provider, model: req.model, req };
      calls.push(call);
      const key = `${provider}:${req.model}`;
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      const answer = await script(call, index);
      if (answer.advanceMs) clock?.advance?.(answer.advanceMs);
      yield { type: 'start', provider, model: answer.served ?? req.model };
      if (answer.error) {
        yield { type: 'end', stopReason: answer.error === 'timeout' ? 'timeout' : 'error', error: new AiError(answer.error, { provider, retryAfterMs: answer.retryAfterMs ?? null }) };
        return;
      }
      if (answer.text) yield { type: 'text', delta: answer.text };
      yield { type: 'end', stopReason: answer.stop ?? 'end_turn' };
    },
  });
  /** @type {Map<string, import('../../src/js/ai/stream.js').SdkAdapter>} */
  const adapters = new Map();
  return {
    calls,
    /** @type {import('../../src/js/ai/router.js').RouterDeps['complete']} */
    complete(req, options) {
      if (!adapters.has(req.provider)) adapters.set(req.provider, adapter(req.provider));
      return complete(req, { ...options, adapter: adapters.get(req.provider), transport: null });
    },
  };
}

/**
 * Router dependencies for a test: the scripted providers, a wheel and a cache of their own, no
 * device, nothing simulated, the fake clock, English.
 * @param {ReturnType<typeof scriptedProviders>} providers
 * @param {ReturnType<typeof fakeClock>} clock
 * @param {Partial<import('../../src/js/ai/router.js').RouterDeps>} [overrides]
 * @returns {Partial<import('../../src/js/ai/router.js').RouterDeps> & { wheel: ModelWheel, cache: ReturnType<typeof createPurposeCache> }}
 */
export function testDeps(providers, clock, overrides = {}) {
  return {
    complete: providers.complete,
    configured: () => [],
    liveModels: () => null,
    caps: () => null,
    device: () => null,
    selection: () => null,
    wheel: new ModelWheel({ now: clock.now }),
    cache: createPurposeCache({ storageKey: null }),
    simulated: () => false,
    now: clock.now,
    locale: () => 'en',
    ...overrides,
  };
}

/**
 * The text of the last user message of a request.
 * @param {import('../../src/js/ai/contract.js').AiRequest} req
 */
export function lastUserText(req) {
  const last = [...req.messages].reverse().find((m) => m.role === 'user');
  return last ? last.content.map((p) => (p.type === 'text' ? p.text : '')).join('') : '';
}

/**
 * The system text of a request: req.system and the system messages.
 * @param {import('../../src/js/ai/contract.js').AiRequest} req
 */
export function systemText(req) {
  return [req.system ?? '', ...req.messages.filter((m) => m.role === 'system').map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))].join('\n');
}
