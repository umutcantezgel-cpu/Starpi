// The companion tier and source (src/js/companion/tier.js) and the chat's retrieval-source hook
// (src/js/chat/hooks.js): passages above the class ceiling never come, a question that stays on
// this device may take sensitive passages, a disabled source or an unpaired browser asks nothing,
// a failing or slow source adds nothing; answers stream through unchanged; notices have texts.
import './setup.mjs';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { registerRetrievalSource, sourceHits } from '../../src/js/chat/hooks.js';
import { CompanionError } from '../../src/js/companion/client.js';
import { createPairing } from '../../src/js/companion/pair.js';
import { askCompanion, ceilingFor, companionSource, noticeKey, NOTICE_CODES, passagesToHits, streamCompanion } from '../../src/js/companion/tier.js';
import { hasKey } from '../../src/js/i18n/index.js';
import { fakeCompanion, memoryLinkStore, memoryMarker } from './companion-fakes.mjs';

/** @param {string} id @param {string} dataClass @param {string} [collection] */
const passage = (id, dataClass, collection = 'documents') => ({ id, collection, title: `Title ${id}`, dataClass, chunk: 0, start: 0, end: 10, text: `Text of ${id}.`, score: 0.5, keywordScore: 2.5, similarity: null });

/** A paired pairing against a fake companion. */
async function pairedCompanion() {
  const companion = fakeCompanion();
  const pairing = createPairing({ store: memoryLinkStore(), marker: memoryMarker(), fetch: companion.fetch, voiceLink: () => {} });
  await pairing.pair({ code: 'ABCDEFGH', origin: companion.origin });
  return { companion, pairing };
}

describe('companion passages', () => {
  it('keeps only passages up to the ceiling, as library hits', () => {
    const hits = passagesToHits([passage('doc-1', 'public'), passage('note-1', 'personal', 'notes'), passage('doc-2', 'sensitive'), passage('doc-3', 'secret'), { id: 'x' }, null], 'personal');
    assert.deepEqual(hits.map((h) => h.documentId), ['companion:doc-1', 'companion:note-1']);
    assert.equal(hits[0].documentTitle, 'Title doc-1');
    assert.equal(hits[0].content, 'Text of doc-1.');
    assert.equal(hits[0].rank, 2.5);
    assert.equal(hits[0].heading, 'Companion document');
    assert.equal(hits[1].heading, 'Companion note');
    assert.equal(hits[0].workspace, undefined);
    assert.deepEqual(passagesToHits('nope', 'secret'), []);
  });

  it('lets a question that stays on this device take sensitive passages, never secret ones', () => {
    assert.equal(ceilingFor({ deviceOnly: true }, { enabled: true, cloudCeiling: 'public' }), 'sensitive');
    assert.equal(ceilingFor({ deviceOnly: false }, { enabled: true, cloudCeiling: 'personal' }), 'personal');
    assert.equal(ceilingFor({ deviceOnly: false }, { enabled: true, cloudCeiling: 'public' }), 'public');
  });
});

describe('companion source', () => {
  it('asks nothing while it is off or nothing is paired', async () => {
    const { companion, pairing } = await pairedCompanion();
    const off = companionSource(async () => pairing, { settings: () => ({ enabled: false, cloudCeiling: 'personal' }) });
    assert.deepEqual(await off.search('room size', { deviceOnly: false }), { hits: [], label: '' });
    assert.equal(companion.calls('POST', '/v1/retrieval/search').length, 0);

    const lone = createPairing({ store: memoryLinkStore(), marker: memoryMarker(), fetch: companion.fetch, voiceLink: () => {} });
    const unpaired = companionSource(async () => lone, { settings: () => ({ enabled: true, cloudCeiling: 'personal' }) });
    assert.deepEqual(await unpaired.search('room size', { deviceOnly: false }), { hits: [], label: '' });
    assert.equal(companion.calls('POST', '/v1/retrieval/search').length, 0);
  });

  it('asks with the ceiling of the question and drops what is above it', async () => {
    const { companion, pairing } = await pairedCompanion();
    companion.handlers.set('POST /v1/retrieval/search', () => ({ body: { passages: [passage('doc-1', 'personal'), passage('doc-2', 'sensitive')], dense: 'off' } }));
    const source = companionSource(async () => pairing, { settings: () => ({ enabled: true, cloudCeiling: 'personal' }) });
    const cloud = await source.search('room size', { deviceOnly: false });
    assert.deepEqual(cloud.hits.map((h) => h.documentId), ['companion:doc-1']);
    assert.equal(cloud.label, 'companion: 1 passage');
    const device = await source.search('room size', { deviceOnly: true });
    assert.deepEqual(device.hits.map((h) => h.documentId), ['companion:doc-1', 'companion:doc-2']);
    const bodies = companion.calls('POST', '/v1/retrieval/search').map((r) => r.body);
    assert.deepEqual(bodies.map((b) => b.maxClass), ['personal', 'sensitive']);
    assert.deepEqual(bodies[0].collections, ['notes', 'documents']);
    assert.equal(bodies[0].query, 'room size');
  });

  it('says so when the companion does not answer', async () => {
    const { companion, pairing } = await pairedCompanion();
    companion.handlers.set('POST /v1/retrieval/search', () => ({ status: 503, body: { error: { code: 'module_stopped', message: 'x' } } }));
    const source = companionSource(async () => pairing, { settings: () => ({ enabled: true, cloudCeiling: 'personal' }) });
    assert.deepEqual(await source.search('room size', { deviceOnly: false }), { hits: [], label: 'companion unavailable' });
  });
});

describe('retrieval sources of the chat', () => {
  /** @type {Array<() => void>} */
  const undo = [];
  afterEach(() => undo.splice(0).forEach((fn) => fn()));

  it('joins the hits and labels of every source, and skips a failing or slow one', async () => {
    const hit = { documentId: 'companion:doc-1', documentTitle: 'A', heading: '', content: 'x', tags: [], rank: 1 };
    undo.push(registerRetrievalSource({ id: 'one', search: async (_q, ctx) => ({ hits: [hit], label: ctx.deviceOnly ? 'here' : 'anywhere' }) }));
    undo.push(registerRetrievalSource({ id: 'broken', search: async () => Promise.reject(new Error('down')) }));
    undo.push(registerRetrievalSource({ id: 'slow', search: () => new Promise((resolve) => setTimeout(() => resolve({ hits: [hit], label: 'late' }), 200)) }));
    const warn = console.warn;
    console.warn = () => {};
    try {
      const r = await sourceHits('q', { deviceOnly: true, timeoutMs: 50 });
      assert.deepEqual(r.hits, [hit]);
      assert.deepEqual(r.labels, ['here']);
    } finally {
      console.warn = warn;
    }
  });

  it('replaces a source registered again under its id', async () => {
    undo.push(registerRetrievalSource({ id: 'same', search: async () => ({ hits: [], label: 'first' }) }));
    undo.push(registerRetrievalSource({ id: 'same', search: async () => ({ hits: [], label: 'second' }) }));
    assert.deepEqual((await sourceHits('q', { deviceOnly: false })).labels, ['second']);
    assert.throws(() => registerRetrievalSource(/** @type {any} */ ({ id: 'x' })), TypeError);
  });
});

describe('companion answers', () => {
  it('stream through unchanged and end with the finished answer', async () => {
    const { companion, pairing } = await pairedCompanion();
    const answer = { id: 'a1', text: 'One. Two.', units: [], withheld: [], sources: [], mode: 'sources', dataClass: 'personal', model: 'local-model', locality: 'local', source: 'model', notice: null, counts: { released: 2, withheld: 0 } };
    companion.handlers.set('POST /v1/chat', () => ({
      events: [
        { event: 'start', data: { conversation: 'chat-1', turn: 1 } },
        { event: 'unit', data: { text: 'One.', cites: ['S1'], kind: 'sentence' } },
        { event: 'reset', data: { withdrawn: 1 } },
        { event: 'unit', data: { text: 'One.', cites: ['S1'], kind: 'sentence' } },
        { event: 'unit', data: { text: 'Two.', cites: [], kind: 'sentence' } },
        { event: 'done', data: { conversation: 'chat-1', turn: 1, dataClass: 'personal', answer } },
      ],
    }));
    /** @type {string[]} */
    const seen = [];
    const done = await streamCompanion(pairing, { question: ' How big is the room? ', mode: 'sources' }, { onUnit: (u) => seen.push(u.text), onReset: (e) => seen.push(`-${e.withdrawn}`) });
    assert.deepEqual(seen, ['One.', '-1', 'One.', 'Two.']);
    assert.equal(done.conversation, 'chat-1');
    assert.deepEqual(done.answer, answer);
    assert.deepEqual(companion.calls('POST', '/v1/chat')[0].body, { question: 'How big is the room?', mode: 'sources' });
  });

  it('fail when the stream ends without its answer', async () => {
    const { companion, pairing } = await pairedCompanion();
    companion.handlers.set('POST /v1/chat', () => ({ events: [{ event: 'start', data: { conversation: 'c', turn: 1 } }] }));
    await assert.rejects(streamCompanion(pairing, { question: 'q' }), (err) => err instanceof CompanionError && err.code === 'stream_failed');
    await assert.rejects(streamCompanion(pairing, { question: '   ' }), (err) => err instanceof CompanionError && err.code === 'question_empty');
  });

  it('ask one question as JSON without conversation members', async () => {
    const { companion, pairing } = await pairedCompanion();
    companion.handlers.set('POST /v1/ask', () => ({ body: { answer: { id: 'a', text: 'Template.', notice: 'no_model', source: 'template' } } }));
    const answer = await askCompanion(pairing, { question: 'q', mode: 'free', conversation: 'chat-1', tools: true });
    assert.equal(answer.text, 'Template.');
    assert.deepEqual(companion.calls('POST', '/v1/ask')[0].body, { question: 'q', mode: 'free' });
  });

  it('have a text for every notice of the companion’s router, in both languages', () => {
    for (const code of NOTICE_CODES) {
      assert.equal(noticeKey(code), `companion.notice.${code}`);
      assert.ok(hasKey(`companion.notice.${code}`, 'en') && hasKey(`companion.notice.${code}`, 'de'), code);
    }
    assert.equal(noticeKey('something_new'), 'companion.notice.other');
    assert.equal(noticeKey(null), null);
  });
});
