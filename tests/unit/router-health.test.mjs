// The health client asks GET /api/health once per minute at most, shares a running request, keeps
// the last good answer when a request fails, keeps only booleans from the body, and turns them into
// the status dots of the model picker. The router reads its simulated flags from it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HEALTH_TTL_MS, createHealthClient, healthDots, parseHealth, statusDot } from '../../src/js/ai/health-client.js';
import { fakeClock } from './router-fakes.mjs';

const BODY = { version: '3.0.0', pools: { gemini: true, nvidia: false }, simulated: { openai: true, anthropic: false }, voice: { tts: true, stt: false, live: false }, research: true, access: false };

/**
 * A fetch that answers from a queue of bodies or statuses and counts its calls.
 * @param {Array<unknown>} answers  an object: 200 with that JSON; a number: that status; an Error: thrown
 */
function scriptedFetch(answers) {
  /** @type {Array<{ url: string, init: RequestInit | undefined }>} */
  const calls = [];
  /** @type {Array<() => void>} */
  const gates = [];
  let held = false;
  const fetch = async (/** @type {string} */ url, /** @type {RequestInit | undefined} */ init) => {
    calls.push({ url, init });
    if (held) await new Promise((r) => gates.push(() => r(undefined)));
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next instanceof Error) throw next;
    if (typeof next === 'number') return new Response('nope', { status: next });
    return new Response(typeof next === 'string' ? next : JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    fetch,
    calls,
    hold: () => void (held = true),
    release: () => {
      held = false;
      gates.splice(0).forEach((open) => open());
    },
  };
}

describe('reading a health answer', () => {
  it('keeps booleans in their places and nothing else', () => {
    const parsed = parseHealth({ ...BODY, pools: { gemini: true, nvidia: 3, 'Bad Key': true }, keys: ['secret'], voice: { tts: 'yes' }, version: '<script>' });
    assert.deepEqual(parsed, { version: '', pools: { gemini: true }, simulated: { openai: true, anthropic: false }, voice: { tts: false, stt: false, live: false }, research: true, access: false });
    assert.equal(parseHealth([]), null);
    assert.equal(parseHealth('ok'), null);
  });

  it('turns booleans into status dots, unknown before the first answer', () => {
    assert.deepEqual(statusDot(true), { state: 'on', tone: 'ok', icon: 'check-circle-2', labelKey: 'ai-orchestration.health.on' });
    assert.equal(statusDot(false).state, 'off');
    assert.equal(statusDot(null).state, 'unknown');
    const before = healthDots({ status: 'idle', data: null, error: null, at: null }, ['gemini']);
    assert.equal(before.pools.gemini.state, 'unknown');
    assert.equal(before.server.state, 'unknown');
    const after = healthDots({ status: 'ok', data: /** @type {any} */ (parseHealth(BODY)), error: null, at: 1 }, ['openrouter']);
    assert.deepEqual(Object.fromEntries(Object.entries(after.pools).map(([k, v]) => [k, v.state])), { openrouter: 'off', gemini: 'on', nvidia: 'off' });
    assert.equal(after.voice.tts.state, 'on');
    assert.equal(after.research.state, 'on');
    assert.equal(after.server.state, 'on');
  });
});

describe('the health client', () => {
  it('asks once, serves the answer for a minute, then asks again', async () => {
    const clock = fakeClock();
    const net = scriptedFetch([BODY]);
    const client = createHealthClient({ fetch: net.fetch, now: clock.now });
    assert.equal(client.simulated('openai'), null, 'unknown before the first answer');
    const first = await client.load();
    assert.equal(first.status, 'ok');
    assert.equal(net.calls[0].url, '/api/health');
    assert.equal(net.calls[0].init?.method, 'GET');
    assert.equal(net.calls[0].init?.credentials, 'same-origin');
    assert.equal(client.simulated('openai'), true);
    assert.equal(client.simulated('anthropic'), false);
    assert.equal(client.pool('gemini'), true);
    await client.load();
    assert.equal(net.calls.length, 1, 'fresh answers are reused');
    clock.advance(HEALTH_TTL_MS);
    await client.load();
    assert.equal(net.calls.length, 2);
    await client.load({ force: true });
    assert.equal(net.calls.length, 3);
  });

  it('shares a running request and runs a forced one after it', async () => {
    const net = scriptedFetch([BODY]);
    const client = createHealthClient({ fetch: net.fetch });
    net.hold();
    const a = client.load();
    const b = client.load();
    const forced = client.load({ force: true });
    assert.equal(client.get().status, 'pending');
    assert.equal(net.calls.length, 1, 'one request while it runs');
    assert.equal(client.load({ force: true }), forced, 'a second forced load joins the queued one');
    net.release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, rb);
    await forced;
    assert.equal(net.calls.length, 2, 'the forced load ran once more after it');
  });

  it('keeps the last good answer when a request fails, and says why', async () => {
    const clock = fakeClock();
    const net = scriptedFetch([BODY, 503, new Error('offline'), 'not json']);
    const client = createHealthClient({ fetch: net.fetch, now: clock.now });
    /** @type {string[]} */
    const seen = [];
    const off = client.subscribe((s) => seen.push(s.status));
    await client.load();
    const http = await client.load({ force: true });
    assert.equal(http.status, 'error');
    assert.equal(http.error, 'http_503');
    assert.equal(http.data?.pools.gemini, true, 'the last good answer stays');
    assert.equal((await client.load({ force: true })).error, 'network');
    assert.equal((await client.load({ force: true })).error, 'bad_response');
    assert.equal(client.dots(['gemini']).server.state, 'off');
    assert.equal(client.dots(['gemini']).pools.gemini.state, 'on');
    off();
    assert.deepEqual(seen, ['pending', 'ok', 'pending', 'error', 'pending', 'error', 'pending', 'error']);
  });
});
