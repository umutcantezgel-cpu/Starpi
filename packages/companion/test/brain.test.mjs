import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAiFake } from '../../../scripts/fakes/openai.mjs';
import { createAnthropicFake } from '../../../scripts/fakes/anthropic.mjs';
import { createGeminiFake } from '../../../scripts/fakes/gemini.mjs';
import { readSse } from '../src/brain/sse.js';
import { mapStopReason } from '../src/brain/stop-reasons.js';
import { createOpenAiCompatBrain } from '../src/brain/openai-compat.js';
import { createAnthropicBrain } from '../src/brain/anthropic.js';
import { createGeminiBrain } from '../src/brain/gemini.js';
import { createNoneBrain } from '../src/brain/none.js';
import { createBrainRouter, REST_AFTER_FAILURES } from '../src/brain/router.js';
import { buildBrains, localityOf } from '../src/brain/index.js';
import { openCapability } from '../src/egress/guard.js';
import { createAdmission } from '../src/admission/admission.js';
import { createBreaker } from '../src/breaker/breaker.js';
import { manualClock } from '../src/lib/clock.js';

/** @param {string} text */
const streamOf = (text) => new Response(text).body;
/** @param {string} text @param {import('../src/contracts/data-classes.js').DataClass} [dataClass] @param {string} [brain] */
const ask = (text, dataClass = 'public', brain) => ({ messages: [{ role: /** @type {const} */ ('system'), content: 'Answer briefly.' }, { role: /** @type {const} */ ('user'), content: text }], dataClass, brain });

/** A scripted brain for router tests. */
function scripted(id, locality, script) {
  return {
    id,
    kind: 'test',
    locality,
    model: `${id}-model`,
    hosts: [],
    calls: 0,
    async *stream() {
      this.calls += 1;
      yield* script(this.calls);
    },
  };
}

test('SSE: events, multi-line data, comments, CRLF and a cut-off last block', async () => {
  const events = [];
  for await (const e of readSse(streamOf(': hi\r\nevent: a\r\ndata: 1\r\ndata: 2\r\n\r\ndata: {"x":1}\n\ndata: tail'))) events.push(e);
  assert.deepEqual(events, [{ event: 'a', data: '1\n2' }, { event: 'message', data: '{"x":1}' }, { event: 'message', data: 'tail' }]);
});

test('stop reasons map per dialect; unknown ones are errors', () => {
  assert.equal(mapStopReason('openai', 'length'), 'max_tokens');
  assert.equal(mapStopReason('anthropic', 'refusal'), 'refusal');
  assert.equal(mapStopReason('gemini', 'SAFETY'), 'refusal');
  assert.equal(mapStopReason('openai', 'weird'), 'error');
});

test('adapters stream from the local fakes: openai-compatible (Authorization only with a secret), Anthropic SDK, Gemini', async (t) => {
  const openai = createOpenAiFake({ gapMs: 0 });
  const anthropic = createAnthropicFake({ gapMs: 0 });
  const gemini = createGeminiFake({ gapMs: 0 });
  const [o, a, g] = await Promise.all([openai.listen(), anthropic.listen(), gemini.listen()]);
  t.after(async () => {
    await Promise.all([openai.close?.(), anthropic.close?.(), gemini.close?.()]);
  });
  const collect = async (brain, request) => {
    let text = '';
    let end = null;
    for await (const e of brain.stream(request, { signal: new AbortController().signal })) {
      if (e.type === 'text') text += e.text;
      if (e.type === 'end') end = e;
    }
    return { text, end };
  };
  const local = createOpenAiCompatBrain({ id: 'local', baseUrl: `${o.url}/flavor/ollama/v1`, model: 'llama3.2', locality: 'local', fetch });
  const r1 = await collect(local, ask('Hello'));
  assert.match(r1.text, /simulated answer/);
  assert.equal(r1.end?.stopReason, 'end_turn');
  const reqs = (await (await fetch(`${o.url}/__fake/requests`)).json());
  const last = (reqs.requests ?? reqs).at(-1);
  assert.equal(last.headers.authorization, undefined, 'no secret, no Authorization header');
  const keyed = createOpenAiCompatBrain({ id: 'keyed', baseUrl: `${o.url}/v1`, model: 'gpt-5-mini', locality: 'cloud', fetch, apiKey: () => 'sk-local-test' });
  await collect(keyed, ask('Hello'));
  const after = (await (await fetch(`${o.url}/__fake/requests`)).json());
  assert.notEqual((after.requests ?? after).at(-1).headers.authorization, undefined, 'a configured secret is sent');

  const claude = createAnthropicBrain({ id: 'claude', baseUrl: a.url, fetch, apiKey: () => 'k' });
  const r2 = await collect(claude, ask('Hello'));
  assert.match(r2.text, /simulated answer/);
  assert.equal(r2.end?.model, 'claude-opus-5-5');
  const recorded = await (await fetch(`${a.url}/__fake/requests`)).json();
  const body = (Array.isArray(recorded) ? recorded : recorded.requests).at(-1)?.body;
  assert.equal(body.system, 'Answer briefly.');
  assert.equal(body.fallbacks, undefined, 'no silent switch to another model');
  assert.equal(body.thinking, undefined);

  const gem = createGeminiBrain({ id: 'gem', baseUrl: g.url, fetch, apiKey: () => 'k' });
  const r3 = await collect(gem, ask('Hello'));
  assert.match(r3.text, /simulated answer/);
  await assert.rejects(collect(createGeminiBrain({ id: 'nokey', baseUrl: g.url, fetch, apiKey: () => null }), ask('x')), (err) => /** @type {any} */ (err).code === 'brain_auth');
});

test('router: data classes decide where content may go', async () => {
  const local = scripted('local', 'local', async function* () {
    yield { type: 'text', text: 'local answer' };
    yield { type: 'end', stopReason: 'end_turn', model: 'm', usage: null };
  });
  const cloud = scripted('cloud', 'cloud', async function* () {
    yield { type: 'text', text: 'cloud answer' };
    yield { type: 'end', stopReason: 'end_turn', model: 'm', usage: null };
  });
  const router = createBrainRouter({ brains: [cloud, local], none: createNoneBrain() });
  assert.equal((await router.complete(ask('x', 'public'))).brain, 'cloud');
  assert.equal((await router.complete(ask('x', 'sensitive'))).brain, 'local');
  const secret = await router.complete(ask('x', 'secret'));
  assert.deepEqual({ source: secret.source, notice: secret.notice, calls: local.calls + cloud.calls }, { source: 'template', notice: 'class_secret', calls: 2 });
  const strict = createBrainRouter({ brains: [cloud, local], none: createNoneBrain(), policy: { personalToCloud: false } });
  assert.equal((await strict.complete(ask('x', 'personal'))).brain, 'local');
  assert.equal((await router.complete(ask('x', 'sensitive', 'cloud'))).notice, 'no_brain_for_class');
  assert.equal((await createBrainRouter({ brains: [], none: createNoneBrain() }).complete(ask('x'))).notice, 'no_model');
});

test('router: no silent switch between local and cloud, withdrawn text after a mid-answer failure, refusals passed on', async () => {
  const explode = () => {
    throw Object.assign(new Error('down'), { code: 'brain_unreachable' });
  };
  const failingLocal = scripted('local', 'local', async function* () {
    yield* explode();
  });
  const cloud = scripted('cloud', 'cloud', async function* () {
    yield { type: 'text', text: 'cloud' };
    yield { type: 'end', stopReason: 'end_turn', model: 'm', usage: null };
  });
  const router = createBrainRouter({ brains: [failingLocal, cloud], none: createNoneBrain() });
  const r = await router.complete(ask('x'));
  assert.deepEqual({ source: r.source, notice: r.notice, cloudCalls: cloud.calls }, { source: 'template', notice: 'brain_unavailable', cloudCalls: 0 });
  assert.deepEqual(r.attempts, [{ brain: 'local', error: 'brain_unreachable' }]);

  const secondLocal = scripted('local2', 'local', async function* () {
    yield { type: 'text', text: 'second' };
    yield { type: 'end', stopReason: 'end_turn', model: 'm', usage: null };
  });
  const fallback = await createBrainRouter({ brains: [failingLocal, secondLocal, cloud], none: createNoneBrain() }).complete(ask('x'));
  assert.equal(fallback.brain, 'local2', 'local to local is fine');

  const midway = scripted('mid', 'local', async function* () {
    yield { type: 'text', text: 'half an ans' };
    throw new Error('cut');
  });
  /** @type {string[]} */
  const seen = [];
  const cut = await createBrainRouter({ brains: [midway, secondLocal], none: createNoneBrain() }).complete(ask('x'), { onEvent: (e) => seen.push(e.type) });
  assert.deepEqual({ notice: cut.notice, reset: cut.reset }, { notice: 'brain_failed_midway', reset: true });
  assert.deepEqual(seen, ['text', 'reset']);

  const refusing = scripted('ref', 'cloud', async function* () {
    yield { type: 'end', stopReason: 'refusal', model: 'm', usage: null };
  });
  assert.equal((await createBrainRouter({ brains: [refusing], none: createNoneBrain() }).complete(ask('x'))).notice, 'refusal');
});

test('router: a failing brain rests, the breaker and the admission take part', async () => {
  const clock = manualClock();
  const flaky = scripted('flaky', 'local', async function* (n) {
    if (n <= REST_AFTER_FAILURES) throw new Error('nope');
    yield { type: 'text', text: 'back' };
    yield { type: 'end', stopReason: 'end_turn', model: 'm', usage: null };
  });
  const breaker = createBreaker({ clock, minEvents: 1000 });
  const router = createBrainRouter({ brains: [flaky], none: createNoneBrain(), clock, breaker });
  for (let i = 0; i < REST_AFTER_FAILURES; i += 1) await router.complete(ask('x'));
  assert.equal(router.describe()[0].resting, true);
  assert.equal((await router.complete(ask('x'))).notice, 'no_brain_for_class');
  clock.advance(61_000);
  assert.equal((await router.complete(ask('x'))).text, 'back');

  const admission = createAdmission({ budgetMb: 1000, clock });
  const sized = { ...scripted('sized', 'local', async function* () {
    assert.deepEqual(admission.stats().models, ['sized:sized-model']);
    yield { type: 'text', text: 'ok' };
    yield { type: 'end', stopReason: 'end_turn', model: 'm', usage: null };
  }), memoryMb: 600 };
  await createBrainRouter({ brains: [sized], none: createNoneBrain(), admission, clock }).complete(ask('x'));
  assert.deepEqual(admission.stats().models, [], 'the lease is released after the answer');

  const isolating = createBreaker({ clock, minEvents: 1, thresholds: { isolated: { errorRate: 0.5 } } });
  isolating.record(false);
  const cloud = scripted('cloud', 'cloud', async function* () {
    yield { type: 'text', text: 'c' };
    yield { type: 'end', stopReason: 'end_turn', model: 'm', usage: null };
  });
  assert.equal((await createBrainRouter({ brains: [cloud], none: createNoneBrain(), breaker: isolating }).complete(ask('x'))).notice, 'no_brain_for_class', 'isolated: no cloud call leaves');
});

test('building brains: locality, egress list, private hosts and config problems', () => {
  assert.deepEqual(localityOf('http://127.0.0.1:11434/v1'), { locality: 'local', host: '127.0.0.1' });
  assert.equal(localityOf('https://api.groq.com/openai/v1').locality, 'cloud');
  assert.throws(() => localityOf('http://192.168.1.20:11434/v1'), (err) => /** @type {any} */ (err).code === 'brain_private_host');
  assert.throws(() => localityOf('http://api.example.com/v1'), (err) => /** @type {any} */ (err).code === 'brain_config');
  const secret = () => 'k';
  assert.throws(() => buildBrains({ config: [{ id: 'claude', type: 'anthropic', secret: 'anthropic' }], secret, capability: null }), (err) => /** @type {any} */ (err).code === 'egress_not_listed');
  const capability = openCapability(['api.anthropic.com:443', 'api.groq.com:443'], fetch);
  const built = buildBrains({
    config: [
      { id: 'local', type: 'openai-compat', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2', memoryMb: 4096 },
      { id: 'claude', type: 'anthropic', secret: 'anthropic', model: 'claude-sonnet-5-5' },
      { id: 'groq', type: 'cloud', preset: 'groq', secret: 'groq' },
    ],
    secret,
    capability,
  });
  assert.deepEqual(built.map((b) => [b.id, b.locality, b.model]), [['local', 'local', 'llama3.2'], ['claude', 'cloud', 'claude-sonnet-5-5'], ['groq', 'cloud', 'llama-3.3-70b-versatile']]);
  assert.throws(() => buildBrains({ config: [{ id: 'none', type: 'cloud', preset: 'nope' }], secret, capability }), (err) => /** @type {any} */ (err).code === 'brain_config');
});
