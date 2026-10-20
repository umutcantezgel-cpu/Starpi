// The paired companion as a provider of the AI layer: the adapter asks the companion's /v1/chat with
// the stored pairing, streams the released units, takes withdrawn ones back in the live view, ends
// with the companion's own text and label in one opaque block, continues the companion's
// conversation and sends a question that stays on this device as `sensitive`. The pickers offer it
// once paired, and the router never runs a purpose on it nor caches its answers.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMPANION_BLOCK, companionAiError, conversationOf, createCompanionAdapter, liveText, questionOf } from '../../src/js/ai/adapters/companion.js';
import { capsFor } from '../../src/js/ai/catalog/models.js';
import { complete, validateEventSequence } from '../../src/js/ai/index.js';
import { getPurpose } from '../../src/js/ai/purposes.js';
import { hashInput, planChain, purposeCacheKey, runPurpose } from '../../src/js/ai/router.js';
import { createPairing } from '../../src/js/companion/pair.js';
import { assistantGroups, COMPANION_VALUE, parsePickerValue } from '../../src/js/models/choices.js';
import { routeOf, setCompanionPaired } from '../../src/js/providers.js';
import { normalizeAssistant } from '../../src/js/state.js';
import { fakeCompanion, memoryLinkStore, memoryMarker, settle } from './companion-fakes.mjs';
import { fakeClock, scriptedProviders, testDeps } from './router-fakes.mjs';

/** A pairing against a fake companion, paired. */
async function paired(companion = fakeCompanion()) {
  const pairing = createPairing({ store: memoryLinkStore(), marker: memoryMarker(), fetch: companion.fetch, voiceLink: () => {} });
  await pairing.pair({ code: 'ABCDEFGH', origin: companion.origin });
  await settle();
  return { companion, pairing };
}

/**
 * The companion's answer of one turn.
 * @param {string} text
 * @param {Record<string, unknown>} [extra]
 */
const answerOf = (text, extra = {}) => ({ id: 'ans-1', text, units: [], withheld: [], sources: [], mode: 'free', dataClass: 'personal', model: 'small-local', locality: 'local', source: 'model', notice: null, counts: { released: 1, withheld: 0 }, ...extra });

/**
 * Runs one call through the real complete() and stream driver.
 * @param {import('../../src/js/ai/stream.js').SdkAdapter} adapter
 * @param {import('../../src/js/ai/contract.js').AiRequest} req
 */
async function run(adapter, req) {
  const call = complete(req, { adapter, transport: null });
  /** @type {import('../../src/js/ai/contract.js').AiEvent[]} */
  const events = [];
  for await (const ev of call.events) events.push(ev);
  return { events, result: await call.result };
}

/** @param {string} text @returns {import('../../src/js/ai/contract.js').AiRequest} */
const ask = (text) => ({ provider: 'companion', model: 'starpi-core', system: 'The app has rules of its own.', messages: [{ role: 'user', content: [{ type: 'text', text }] }] });

describe('the companion adapter', () => {
  it('streams released units and ends with the companion text and label in one opaque block', async () => {
    const { companion, pairing } = await paired();
    companion.handlers.set('POST /v1/chat', () => ({
      events: [
        { event: 'start', data: { conversation: 'conv-1', turn: 1 } },
        { event: 'sources', data: { mode: 'free', dataClass: 'personal', sources: [], tools: [] } },
        { event: 'unit', data: { text: 'The kettle is in the left cupboard.', cites: [], kind: 'sentence' } },
        { event: 'unit', data: { text: 'The cups are above it.', cites: [], kind: 'sentence' } },
        { event: 'done', data: { conversation: 'conv-1', turn: 1, answer: answerOf('The kettle is in the left cupboard. The cups are above it.') } },
      ],
    }));
    /** @type {string[]} */
    const seen = [];
    const { events, result } = await run(createCompanionAdapter({ pairing: async () => pairing, onText: (t) => seen.push(t) }), ask('Where is the kettle?'));
    assert.deepEqual(validateEventSequence(events), []);
    assert.deepEqual(
      events.filter((e) => e.type === 'text').map((e) => /** @type {any} */ (e).delta),
      ['The kettle is in the left cupboard.', ' The cups are above it.'],
    );
    assert.deepEqual(seen, ['The kettle is in the left cupboard.', 'The kettle is in the left cupboard. The cups are above it.']);
    assert.equal(result.error, null);
    assert.equal(result.provider, 'companion');
    assert.equal(result.text, 'The kettle is in the left cupboard. The cups are above it.');
    const block = /** @type {any} */ (result.opaque[0].block);
    assert.equal(block.kind, COMPANION_BLOCK);
    assert.deepEqual(
      { conversation: block.conversation, turn: block.turn, mode: block.mode, source: block.source, notice: block.notice, withheld: block.withheld, locality: block.locality, model: block.model },
      { conversation: 'conv-1', turn: 1, mode: 'free', source: 'model', notice: null, withheld: 0, locality: 'local', model: 'small-local' },
    );
    const [req] = companion.calls('POST', '/v1/chat');
    assert.deepEqual(req.body, { question: 'Where is the kettle?', mode: 'free' }, 'only the question goes, never the app system prompt');
    assert.equal(req.headers.authorization, 'Bearer tok_0123456789abcdefghijklmnopqrstuvwxyzABCDE');
    assert.equal(req.init.cache, 'no-store', 'no HTTP cache keeps it');
  });

  it('takes withdrawn units back in the live view and keeps the companion text as released', async () => {
    const { companion, pairing } = await paired();
    companion.handlers.set('POST /v1/chat', () => ({
      events: [
        { event: 'unit', data: { text: 'First try.', cites: [], kind: 'sentence' } },
        { event: 'reset', data: { withdrawn: 1 } },
        { event: 'unit', data: { text: 'Second answer.', cites: [], kind: 'sentence' } },
        { event: 'done', data: { conversation: 'conv-2', turn: 3, answer: answerOf('Second answer.', { withheld: [{ reason: 'link', kind: 'sentence' }] }) } },
      ],
    }));
    /** @type {string[]} */
    const seen = [];
    const { result } = await run(createCompanionAdapter({ pairing: async () => pairing, onText: (t) => seen.push(t) }), ask('Again?'));
    assert.deepEqual(seen, ['First try.', '', 'Second answer.']);
    const block = /** @type {any} */ (result.opaque[0].block);
    assert.equal(block.text, 'Second answer.', 'the stored answer is the companion text');
    assert.equal(block.withheld, 1);
  });

  it('continues the companion conversation, asks in sources mode, and keeps a device-only question sensitive', async () => {
    const { companion, pairing } = await paired();
    companion.handlers.set('POST /v1/chat', () => ({ events: [{ event: 'done', data: { conversation: 'conv-7', turn: 2, answer: answerOf('It is on Friday [S1].'.replace(' [S1]', ''), { mode: 'sources' }) } }] }));
    const earlier = { kind: COMPANION_BLOCK, conversation: 'conv-7', turn: 1, text: 'Hello.', mode: 'free', source: 'model', notice: null, withheld: 0, locality: 'local', model: null, dataClass: 'personal' };
    /** @type {import('../../src/js/ai/contract.js').AiRequest} */
    const req = {
      provider: 'companion',
      model: 'starpi-core',
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }, { type: 'opaque', provider: 'companion', model: 'starpi-core', block: earlier }] },
        { role: 'user', content: [{ type: 'text', text: 'When is the meeting?' }] },
      ],
    };
    assert.equal(conversationOf(req), 'conv-7');
    const { result } = await run(createCompanionAdapter({ pairing: async () => pairing, mode: 'sources', dataClass: 'sensitive' }), req);
    assert.equal(result.error, null);
    assert.deepEqual(companion.calls('POST', '/v1/chat')[0].body, { question: 'When is the meeting?', mode: 'sources', dataClass: 'sensitive', conversation: 'conv-7', after: 1 });
    assert.equal(/** @type {any} */ (result.opaque[0].block).mode, 'sources');
  });

  it('asks nothing without a pairing, and names the companion code of a failure', async () => {
    const companion = fakeCompanion();
    const unpaired = createPairing({ store: memoryLinkStore(), marker: memoryMarker(), fetch: companion.fetch, voiceLink: () => {} });
    const { result } = await run(createCompanionAdapter({ pairing: async () => unpaired }), ask('Hello?'));
    assert.equal(result.error?.code, 'auth');
    assert.equal(result.error?.providerCode, 'not_paired');
    assert.equal(companion.requests.length, 0);

    const { companion: busy, pairing } = await paired();
    busy.handlers.set('POST /v1/chat', () => ({ status: 409, body: { error: { code: 'conversation_busy', message: 'wait' } } }));
    const failed = await run(createCompanionAdapter({ pairing: async () => pairing }), ask('Hello?'));
    assert.equal(failed.result.error?.code, 'rate_limited');
    assert.equal(failed.result.error?.providerCode, 'conversation_busy');
    assert.equal(companionAiError({ code: 'connector_down' }).code, 'server');
    assert.equal(companionAiError({ code: 'connector_down' }).providerCode, 'connector_down');
    const long = await run(createCompanionAdapter({ pairing: async () => pairing }), ask('x'.repeat(8001)));
    assert.equal(long.result.error?.code, 'context_length');
  });

  it('keeps a long answer alive while the companion works', async () => {
    const { companion, pairing } = await paired();
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => (release = () => resolve(undefined)));
    companion.handlers.set('POST /v1/chat', async () => {
      await held;
      return { events: [{ event: 'done', data: { conversation: 'conv-3', turn: 1, answer: answerOf('Done.') } }] };
    });
    const adapter = createCompanionAdapter({ pairing: async () => pairing, heartbeatMs: 5 });
    const call = complete(ask('Slow?'), { adapter, transport: null, idleTimeoutMs: 50 });
    setTimeout(release, 150);
    const result = await call.result;
    assert.equal(result.error, null, 'the idle limit did not end it');
    assert.equal(result.text, 'Done.');
  });

  it('reads the question with its text files, joins live units by their kind, and is text only', () => {
    const data = Buffer.from('line one').toString('base64');
    assert.equal(questionOf({ provider: 'companion', model: 'starpi-core', messages: [{ role: 'user', content: [{ type: 'file', mime: 'text/plain', name: 'notes.txt', data }, { type: 'text', text: 'Summarize it.' }] }] }), 'notes.txt\n\nline one\n\nSummarize it.');
    assert.equal(liveText([{ text: 'Intro.', kind: 'sentence' }, { text: '- a', kind: 'item' }, { text: '- b', kind: 'item' }, { text: 'End.', kind: 'sentence' }]), 'Intro.\n\n- a\n- b\n\nEnd.');
    const caps = capsFor('companion', 'starpi-core');
    assert.equal(caps.vision, false);
    assert.equal(caps.tools, false);
    assert.equal(caps.local, true);
  });
});

describe('the companion in the app', () => {
  it('is offered by the pickers once paired, as one value', () => {
    const base = { hw: null, pools: null, keyed: [], models: {}, server: false, serverModels: [] };
    assert.equal(assistantGroups(base).some((g) => g.id === 'companion'), false, 'not before pairing');
    const groups = assistantGroups({ ...base, companion: true });
    const group = groups.find((g) => g.id === 'companion');
    assert.deepEqual(group?.items.map((i) => [i.value, i.labelKey, Boolean(i.disabled)]), [[COMPANION_VALUE, 'companion.card.title', false]]);
    assert.equal(groups.indexOf(/** @type {any} */ (group)), 2, 'next to the models on this device');
    const stale = assistantGroups({ ...base, current: COMPANION_VALUE }).find((g) => g.id === 'companion');
    assert.equal(stale?.items[0].disabled, true, 'a stored choice of an unpaired companion stays visible, disabled');
    assert.deepEqual(parsePickerValue(COMPANION_VALUE), { assistant: COMPANION_VALUE });
    assert.equal(parsePickerValue('companion:other'), null);
    assert.equal(normalizeAssistant(COMPANION_VALUE), COMPANION_VALUE);
  });

  it('is reached only while paired', () => {
    assert.equal(routeOf('companion'), 'none', 'a browser that never paired');
    setCompanionPaired(true);
    assert.equal(routeOf('companion'), 'companion');
    setCompanionPaired(false);
    assert.equal(routeOf('companion'), 'none');
  });

  it('never runs a purpose and never enters the answer cache', async () => {
    const clock = fakeClock();
    const providers = scriptedProviders(() => ({ text: JSON.stringify({ queries: ['meeting day'] }) }), clock);
    const deps = testDeps(providers, clock, { configured: () => /** @type {any} */ (['companion', 'openai']), liveModels: () => ['gpt-5-nano'], selection: (p) => (p === 'companion' ? { provider: 'companion', model: 'starpi-core' } : null) });
    const def = /** @type {import('../../src/js/ai/purposes.js').PurposeDef} */ (getPurpose('query_rewrite'));
    const steps = planChain(def, { provider: 'companion', model: 'starpi-core' }, deps);
    assert.ok(steps.length > 0);
    assert.ok(steps.every((s) => s.provider !== 'companion'), 'not even when picked');
    const input = { question: 'When is the meeting?' };
    const key = purposeCacheKey('query_rewrite', 'en', hashInput(input));
    deps.cache.set(key, { kind: 'value', output: { queries: ['from the companion'] }, provider: 'companion', model: 'starpi-core', simulated: false, at: clock.now() });
    const res = await runPurpose('query_rewrite', input, { deps, provider: 'companion', cache: 'prefer' });
    assert.notEqual(res.tier, 'cache', 'an entry of the companion is never served');
    assert.ok(providers.calls.every((c) => c.provider !== 'companion'));
  });

});
