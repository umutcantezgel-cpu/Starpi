// The model wheel with a fake clock: 429 cooldowns follow Retry-After, the breaker opens after three
// failures, stays open for a minute and lets one probe through, a 404 marks the model for ten
// minutes, slow fast-role models move to the back, and failures the request caused never count.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_COOLDOWN_MS, FAILURE_THRESHOLD, ModelWheel, NOT_FOUND_MS, OPEN_MS, SLOW_FAST_MS, SLOW_FOR_MS } from '../../src/js/ai/wheel.js';
import { fakeClock } from './router-fakes.mjs';

const P = /** @type {const} */ ('openai');

function setup() {
  const clock = fakeClock();
  return { clock, wheel: new ModelWheel({ now: clock.now }) };
}

describe('429 cooldown', () => {
  it('waits for the Retry-After, else for the default cooldown, and leaves the breaker alone', () => {
    const { clock, wheel } = setup();
    wheel.failed(P, 'm', 'rate_limited', { retryAfterMs: 7000 });
    assert.equal(wheel.blocked(P, 'm'), 'cooldown');
    assert.equal(wheel.waitMs(P, 'm'), 7000);
    assert.equal(wheel.status(P, 'm').failures, 0);
    clock.advance(6999);
    assert.equal(wheel.acquire(P, 'm'), 'cooldown');
    clock.advance(1);
    assert.equal(wheel.acquire(P, 'm'), null);
    wheel.failed(P, 'n', 'rate_limited');
    assert.equal(wheel.waitMs(P, 'n'), DEFAULT_COOLDOWN_MS);
    for (let i = 0; i < 5; i += 1) wheel.failed(P, 'n', 'rate_limited', { retryAfterMs: 10 });
    assert.equal(wheel.status(P, 'n').circuit, 'closed');
    assert.equal(wheel.status(P, 'n').last429, clock.now());
  });

  it('keeps the longer of two cooldowns', () => {
    const { wheel } = setup();
    wheel.failed(P, 'm', 'rate_limited', { retryAfterMs: 30_000 });
    wheel.failed(P, 'm', 'rate_limited', { retryAfterMs: 1000 });
    assert.equal(wheel.waitMs(P, 'm'), 30_000);
  });
});

describe('circuit breaker', () => {
  it('opens after three failures in a row, then lets exactly one probe through after a minute', () => {
    const { clock, wheel } = setup();
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i += 1) wheel.failed(P, 'm', 'server');
    assert.equal(wheel.status(P, 'm').circuit, 'closed');
    wheel.failed(P, 'm', 'network');
    assert.equal(wheel.status(P, 'm').circuit, 'open');
    assert.equal(wheel.acquire(P, 'm'), 'circuit_open');
    assert.equal(wheel.waitMs(P, 'm'), OPEN_MS);
    clock.advance(OPEN_MS);
    assert.equal(wheel.status(P, 'm').circuit, 'half-open');
    assert.equal(wheel.acquire(P, 'm'), null, 'the probe');
    assert.equal(wheel.acquire(P, 'm'), 'probing', 'nobody else while the probe runs');
    wheel.failed(P, 'm', 'stream_cut');
    assert.equal(wheel.status(P, 'm').circuit, 'open', 'a failed probe opens it again at once');
    clock.advance(OPEN_MS);
    assert.equal(wheel.acquire(P, 'm'), null);
    wheel.succeeded(P, 'm', { latencyMs: 800 });
    const health = wheel.status(P, 'm');
    assert.equal(health.circuit, 'closed');
    assert.equal(health.failures, 0);
    assert.equal(health.lastLatencyMs, 800);
    assert.equal(health.available, true);
  });

  it('gives up a probe that never reported back after the open time', () => {
    const { clock, wheel } = setup();
    for (let i = 0; i < 3; i += 1) wheel.failed(P, 'm', 'server');
    clock.advance(OPEN_MS);
    assert.equal(wheel.acquire(P, 'm'), null);
    clock.advance(OPEN_MS - 1);
    assert.equal(wheel.blocked(P, 'm'), 'probing');
    clock.advance(1);
    assert.equal(wheel.acquire(P, 'm'), null);
  });

  it('a success between failures starts the count again', () => {
    const { wheel } = setup();
    wheel.failed(P, 'm', 'server');
    wheel.failed(P, 'm', 'server');
    wheel.succeeded(P, 'm');
    wheel.failed(P, 'm', 'server');
    wheel.failed(P, 'm', 'server');
    assert.equal(wheel.status(P, 'm').circuit, 'closed');
  });

  it('never counts what the request caused itself, nor key, quota and access problems', () => {
    const { clock, wheel } = setup();
    for (const code of /** @type {const} */ (['bad_request', 'context_length', 'deadline', 'aborted', 'auth', 'quota', 'cors', 'refusal', 'bad_request', 'deadline'])) wheel.failed(P, 'm', code);
    assert.equal(wheel.status(P, 'm').circuit, 'closed');
    assert.equal(wheel.status(P, 'm').failures, 0);
    assert.equal(wheel.status(P, 'm').errors, 10);
    for (let i = 0; i < 3; i += 1) wheel.failed(P, 'm', 'timeout');
    clock.advance(OPEN_MS);
    assert.equal(wheel.acquire(P, 'm'), null);
    wheel.failed(P, 'm', 'deadline');
    assert.equal(wheel.status(P, 'm').circuit, 'half-open', 'a deadline during the probe neither opens nor closes');
    assert.equal(wheel.acquire(P, 'm'), null, 'and the next call probes again');
  });

  it('closes on an answer that failed validation: the model works', () => {
    const { wheel } = setup();
    wheel.failed(P, 'm', 'server');
    wheel.failed(P, 'm', 'server');
    wheel.failed(P, 'm', 'invalid_output');
    wheel.failed(P, 'm', 'server');
    assert.equal(wheel.status(P, 'm').circuit, 'closed');
  });

  it('keeps every provider and model apart', () => {
    const { wheel } = setup();
    for (let i = 0; i < 3; i += 1) wheel.failed('openai', 'shared-id', 'server');
    assert.equal(wheel.blocked('openai', 'shared-id'), 'circuit_open');
    assert.equal(wheel.blocked('groq', 'shared-id'), null);
    assert.equal(wheel.blocked('openai', 'other'), null);
  });

  it('follows its own limits', () => {
    const clock = fakeClock();
    const wheel = new ModelWheel({ now: clock.now, failureThreshold: 1, openMs: 5000 });
    wheel.failed(P, 'm', 'server');
    assert.equal(wheel.waitMs(P, 'm'), 5000);
  });
});

describe('404 mark', () => {
  it('skips a model the provider does not serve for ten minutes', () => {
    const { clock, wheel } = setup();
    wheel.failed(P, 'gone', 'not_found');
    assert.equal(wheel.blocked(P, 'gone'), 'not_found');
    assert.equal(wheel.waitMs(P, 'gone'), NOT_FOUND_MS);
    clock.advance(NOT_FOUND_MS);
    assert.equal(wheel.blocked(P, 'gone'), null);
  });
});

describe('slow fast-role demotion', () => {
  it('moves a slow, timed-out or rejected fast model behind the others for a while', () => {
    const { clock, wheel } = setup();
    const models = ['a', 'b', 'c'];
    wheel.succeeded(P, 'a', { latencyMs: SLOW_FAST_MS + 1, role: 'fast' });
    assert.deepEqual(wheel.order(P, models, 'fast'), ['b', 'c', 'a']);
    wheel.failed(P, 'b', 'timeout', { role: 'fast' });
    assert.deepEqual(wheel.order(P, models, 'fast'), ['c', 'a', 'b'], 'the slow ones keep their order');
    wheel.failed(P, 'c', 'invalid_output', { role: 'fast' });
    assert.deepEqual(wheel.order(P, models, 'fast'), ['a', 'b', 'c']);
    assert.deepEqual(wheel.order(P, models, 'reasoning'), models, 'other roles keep the preference order');
    clock.advance(SLOW_FOR_MS);
    assert.deepEqual(wheel.order(P, ['c', 'b', 'a'], 'fast'), ['c', 'b', 'a']);
  });

  it('marks only calls made for the fast role, and a quick answer marks the model fast again', () => {
    const { wheel } = setup();
    wheel.succeeded(P, 'a', { latencyMs: 30_000, role: 'reasoning' });
    assert.equal(wheel.status(P, 'a').slowUntil, 0);
    wheel.succeeded(P, 'a', { latencyMs: 30_000, role: 'fast' });
    assert.ok(wheel.status(P, 'a').slowUntil > 0);
    wheel.succeeded(P, 'a', { latencyMs: 900, role: 'fast' });
    assert.equal(wheel.status(P, 'a').slowUntil, 0);
  });
});

describe('snapshot and listeners', () => {
  it('reports every model it has seen and tells listeners about outcomes', () => {
    const { wheel } = setup();
    /** @type {string[]} */
    const seen = [];
    const off = wheel.onChange((h) => seen.push(`${h.provider}/${h.model}:${h.circuit}`));
    wheel.succeeded('anthropic', 'x', { latencyMs: 10 });
    wheel.failed('gemini', 'y', 'not_found');
    off();
    wheel.failed('gemini', 'y', 'server');
    assert.deepEqual(seen, ['anthropic/x:closed', 'gemini/y:closed']);
    assert.deepEqual(wheel.snapshot().map((h) => [h.provider, h.model, h.available]), [['anthropic', 'x', true], ['gemini', 'y', false]]);
    wheel.onChange(() => {
      throw new Error('listener bug');
    });
    assert.doesNotThrow(() => wheel.succeeded('anthropic', 'x'));
    wheel.reset();
    assert.deepEqual(wheel.snapshot(), []);
  });

  it('release() frees a probe without an outcome', () => {
    const { clock, wheel } = setup();
    for (let i = 0; i < 3; i += 1) wheel.failed(P, 'm', 'server');
    clock.advance(OPEN_MS);
    assert.equal(wheel.acquire(P, 'm'), null);
    wheel.release(P, 'm');
    assert.equal(wheel.acquire(P, 'm'), null);
  });
});
