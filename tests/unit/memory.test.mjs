// Memory (ai/memory.js): notes ranked by relevance × recency × use, at most 8 notes (800 characters)
// going along with a question, notes stored only by an explicit act, scopes per project, the
// system note of a conversation, suggestions that are never stored, and the notes sealed with the
// vault while a passphrase is set (real WebCrypto, a fake IndexedDB).
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { createKeyStore } from '../../src/js/ai/keys.js';
import {
  BASE_RELEVANCE,
  cleanFactText,
  createMemoryStore,
  DEFAULT_PREFS,
  defaultScopeFor,
  MEMORY_EXPORT,
  MEMORY_LIMITS,
  MemoryError,
  memoryNote,
  pickFacts,
  rankFacts,
  recencyOf,
  RECENCY_FLOOR,
  SEAL_PURPOSE,
  scopesFor,
  suggestFacts,
  suggestionNotes,
  systemNoteFor,
  useWeightOf,
} from '../../src/js/ai/memory.js';
import { openAppDb } from '../../src/js/store/schema.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
let seq = 0;

/**
 * @param {Partial<import('../../src/js/ai/memory.js').Fact> & { id: string, text: string }} f
 * @returns {import('../../src/js/ai/memory.js').Fact}
 */
const fact = (f) => ({ scope: 'global', source: 'explicit', createdAt: NOW, usedAt: null, weight: 1, sealed: false, ...f });

/**
 * A memory store on a fresh database.
 * @param {{ vault?: import('../../src/js/ai/memory.js').MemoryVault | null, now?: () => number }} [opts]
 */
async function setup(opts = {}) {
  const db = await openAppDb({ name: `memory-test-${(seq += 1)}`, factory: new IDBFactory() });
  let clock = NOW;
  let ids = 0;
  const store = createMemoryStore({ open: async () => db, now: opts.now ?? (() => clock), uuid: () => `n${(ids += 1)}`, vault: opts.vault ?? null });
  return { db, store, tick: (/** @type {number} */ ms) => (clock += ms) };
}

describe('ranking', () => {
  it('halves recency every 30 days since the last use (or the save)', () => {
    assert.equal(recencyOf({ createdAt: NOW, usedAt: null }, NOW), 1);
    assert.equal(recencyOf({ createdAt: NOW - 30 * DAY, usedAt: null }, NOW), 0.5);
    assert.equal(recencyOf({ createdAt: NOW - 90 * DAY, usedAt: NOW - 30 * DAY }, NOW), 0.5);
  });

  it('weighs a note used often a little higher, never more than double', () => {
    assert.equal(useWeightOf(1), 1);
    assert.ok(useWeightOf(5) > 1 && useWeightOf(5) < useWeightOf(20));
    assert.equal(useWeightOf(50), 2);
    assert.equal(useWeightOf(5000), 2);
    assert.equal(useWeightOf(Number.NaN), 1);
  });

  it('orders by relevance to the question, then recency and use', () => {
    const facts = [
      fact({ id: 'a', text: 'I prefer answers in metric units' }),
      fact({ id: 'b', text: 'My cat is called Pixel', createdAt: NOW - DAY }),
      fact({ id: 'c', text: 'I am learning the cello', createdAt: NOW - 400 * DAY }),
    ];
    const ranked = rankFacts(facts, 'how heavy is my cat Pixel in kilograms?', { now: NOW });
    assert.equal(ranked[0].fact.id, 'b');
    assert.equal(ranked[0].parts.relevance, 1);
    // No shared word: the base relevance keeps lasting preferences in the running, by recency.
    assert.deepEqual(
      ranked.slice(1).map((r) => r.fact.id),
      ['a', 'c'],
    );
    assert.ok(Math.abs(ranked[2].parts.recency - (RECENCY_FLOOR + (1 - RECENCY_FLOOR) * 0.5 ** (400 / 30))) < 1e-9);
    assert.ok(Math.abs(ranked[1].score - BASE_RELEVANCE) < 1e-9);
  });

  it('lets a much-used note beat an equally relevant one used once', () => {
    const facts = [fact({ id: 'once', text: 'I write in British English' }), fact({ id: 'often', text: 'I write in British English too', weight: 40 })];
    assert.equal(rankFacts(facts, 'write an email', { now: NOW })[0].fact.id, 'often');
  });

  it('puts every note that shares a word with the question before the ones that do not', () => {
    const facts = [
      fact({ id: 'old-match', text: 'My grandmother keeps bees in Ghent', createdAt: NOW - 500 * DAY }),
      ...Array.from({ length: 9 }, (_, i) => fact({ id: `busy${i}`, text: `Weekly routine number ${i}`, usedAt: NOW, weight: 50 })),
    ];
    const ranked = rankFacts(facts, 'How do bees survive the winter?', { now: NOW });
    assert.equal(ranked[0].fact.id, 'old-match');
    // On score alone a recent, much-used note that matches nothing would rank higher.
    assert.ok(ranked[1].score > ranked[0].score);
    assert.equal(pickFacts(facts, 'How do bees survive the winter?', { now: NOW })[0].id, 'old-match');
  });
});

describe('injection limits', () => {
  it('passes at most 8 notes with a question', () => {
    const facts = Array.from({ length: 20 }, (_, i) => fact({ id: `f${i}`, text: `note number ${i} about gardening` }));
    const picked = pickFacts(facts, 'gardening', { now: NOW });
    assert.equal(picked.length, MEMORY_LIMITS.injectedFacts);
    assert.equal(MEMORY_LIMITS.injectedFacts, 8);
  });

  it('keeps the notes within 800 characters, passing over one that does not fit for a shorter one', () => {
    const long = 'x'.repeat(290);
    const facts = [
      fact({ id: 'l1', text: `garden 1 ${long}` }),
      fact({ id: 'l2', text: `garden 2 ${long}` }),
      fact({ id: 'l3', text: `garden 3 ${long}` }),
      fact({ id: 'short', text: 'garden gnome' }),
    ];
    const picked = pickFacts(facts, 'garden', { now: NOW });
    const chars = picked.reduce((n, f) => n + f.text.length, 0);
    assert.ok(chars <= MEMORY_LIMITS.injectedChars, `${chars} characters`);
    assert.deepEqual(picked.map((f) => f.id).sort(), ['l1', 'l2', 'short'].sort());
    // A caller cannot raise the limits.
    assert.equal(pickFacts(facts, 'garden', { now: NOW, maxFacts: 50, maxChars: 5000 }).length, 3);
  });

  it('heads the turn note "User notes (may be outdated)", one note per line', () => {
    const note = memoryNote([{ text: 'I live in Lisbon' }, { text: '  I   like\ntea ' }], 'en');
    assert.equal(note, 'User notes (may be outdated):\n- I live in Lisbon\n- I like tea');
    assert.match(memoryNote([{ text: 'Ich wohne in Lissabon' }], 'de'), /^Notizen des Nutzers \(können veraltet sein\):/);
    assert.equal(memoryNote([], 'en'), '');
  });

  it('passes each text once, even when it is kept in two scopes', () => {
    const picked = pickFacts([fact({ id: 'g', text: 'I like tea' }), fact({ id: 'p', text: 'I  LIKE tea', scope: 'p1' }), fact({ id: 'o', text: 'I like coffee too' })], 'tea or coffee', { now: NOW });
    assert.equal(picked.length, 2);
    assert.equal(memoryNote(picked, 'en').match(/like tea/gi)?.length, 1);
  });

  it('keeps one line of at most 300 characters per note', () => {
    assert.equal(cleanFactText(`a\n\nb\t c ${'y'.repeat(400)}`).length, MEMORY_LIMITS.factChars);
    assert.ok(!cleanFactText('one\ntwo').includes('\n'));
  });
});

describe('explicit-only storage', () => {
  it('is off by default and stores nothing without an explicit act', async () => {
    const { store } = await setup();
    assert.deepEqual(await store.prefs(), { ...DEFAULT_PREFS });
    await assert.rejects(store.add(/** @type {any} */ ({ text: 'I like tea', source: 'model' })), (e) => e instanceof MemoryError && e.code === 'source');
    await assert.rejects(store.add(/** @type {any} */ ({ text: 'I like tea' })), (e) => e instanceof MemoryError && e.code === 'source');
    assert.deepEqual((await store.list()).facts, []);
    const kept = await store.add({ text: 'I like tea', source: 'explicit' });
    const accepted = await store.add({ text: 'I run on Sundays', source: 'suggested' });
    assert.deepEqual((await store.list()).facts.map((f) => [f.text, f.source]).sort(), [
      ['I like tea', 'explicit'],
      ['I run on Sundays', 'suggested'],
    ]);
    assert.equal(kept.weight, 1);
    assert.equal(accepted.usedAt, null);
  });

  it('sends no note while memory is off, even with notes saved', async () => {
    const { store } = await setup();
    await store.add({ text: 'I live in Lisbon', source: 'explicit' });
    assert.deepEqual(await store.recall('where do I live?', ['global'], 'en'), { note: '', facts: [] });
    await store.setPrefs({ enabled: true });
    const { note, facts } = await store.recall('where do I live?', ['global'], 'en');
    assert.match(note, /^User notes \(may be outdated\):\n- I live in Lisbon$/);
    assert.equal(facts.length, 1);
    // Going along with a question it matches counts as a use.
    const [after] = (await store.list()).facts;
    assert.equal(after.weight, 2);
    assert.equal(after.usedAt, NOW);
  });

  it('counts only the notes that match the question as used, so filler notes do not crowd out a match later', async () => {
    let clock = NOW;
    const { store } = await setup({ now: () => clock });
    await store.setPrefs({ enabled: true });
    await store.add({ text: 'My grandmother keeps bees in Ghent', source: 'explicit' });
    clock += DAY;
    for (const text of ['I play the oboe', 'I am learning Danish', 'I commute by tram', 'I bake sourdough bread', 'I collect old maps', 'I work night shifts', 'My nephew is called Joris', 'I live near a lake', 'I follow a gluten-free diet']) {
      await store.add({ text, source: 'explicit' });
    }
    // A year of questions that match no note: all notes go along to fill the slots, none counts as used.
    for (let day = 0; day < 365; day += 1) {
      clock += DAY;
      const { facts } = await store.recall('Will it snow on Thursday?', ['global'], 'en');
      assert.equal(facts.length, MEMORY_LIMITS.injectedFacts);
    }
    assert.ok((await store.list()).facts.every((f) => f.weight === 1 && f.usedAt === null));
    const { facts } = await store.recall('Do bees sleep in winter?', ['global'], 'en');
    assert.equal(facts[0].text, 'My grandmother keeps bees in Ghent');
    const after = (await store.list()).facts;
    assert.deepEqual(
      after.filter((f) => f.usedAt !== null).map((f) => [f.text, f.weight]),
      [['My grandmother keeps bees in Ghent', 2]],
    );
  });

  it('only shows suggestions: suggestFacts stores nothing and leaves out what is kept already', async () => {
    const { store } = await setup();
    await store.add({ text: 'I like tea', source: 'explicit' });
    /** @type {Array<{ purpose: string, input: any, opts: any }>} */
    const calls = [];
    const run = async (/** @type {string} */ purpose, /** @type {any} */ input, /** @type {any} */ opts) => {
      calls.push({ purpose, input, opts });
      return { ok: true, tier: 'provider', value: { memories: [{ text: 'I LIKE   tea', kind: 'preference' }, { text: 'I teach biology', kind: 'fact' }, { text: 'no', kind: 'fact' }] } };
    };
    const ideas = await suggestFacts({ question: 'I teach biology. Any tips?', answer: 'Sure.', existing: ['I like tea'] }, { run, providers: ['anthropic'], locale: 'en' });
    assert.deepEqual(ideas, [{ text: 'I teach biology', kind: 'fact' }]);
    assert.equal(calls[0].purpose, 'memory_suggest');
    assert.deepEqual(calls[0].opts.providers, ['anthropic']);
    assert.equal(calls[0].opts.cache, 'off');
    assert.deepEqual((await store.list()).facts.map((f) => f.text), ['I like tea']);
    // Notes compared on the device only (known) are left out too, without being sent.
    const again = await suggestFacts({ question: 'q', answer: 'a', existing: [], known: ['I teach biology', 'i like tea'] }, { run, providers: ['anthropic'] });
    assert.deepEqual(again, []);
    assert.deepEqual(calls[1].input.existing, []);
    // The template (no model) suggests nothing.
    assert.deepEqual(await suggestFacts({ question: 'q', answer: 'a', existing: [] }, { run: async () => ({ ok: false, tier: 'template', value: { memories: [{ text: 'made up', kind: 'fact' }] } }), providers: [] }), []);
  });

  it('refuses empty and duplicate notes and more than the limit', async () => {
    const { store, db } = await setup();
    await assert.rejects(store.add({ text: ' a ', source: 'explicit' }), (e) => e instanceof MemoryError && e.code === 'empty');
    await store.add({ text: 'I like tea', source: 'explicit' });
    await assert.rejects(store.add({ text: 'i like  TEA', source: 'explicit' }), (e) => e instanceof MemoryError && e.code === 'duplicate');
    await db.transaction('memory', 'readwrite', async (tx) => {
      for (let i = 0; i < MEMORY_LIMITS.facts; i += 1) await tx.put('memory', { id: `bulk${i}`, text: `bulk ${i}`, scope: 'global', source: 'explicit', createdAt: NOW, usedAt: null, weight: 1 });
    });
    await assert.rejects(store.add({ text: 'one more', source: 'explicit' }), (e) => e instanceof MemoryError && e.code === 'full');
  });

  it('keeps a note once wherever two copies could go along with one question', async () => {
    const { store } = await setup();
    const isDuplicate = (/** @type {unknown} */ e) => e instanceof MemoryError && e.code === 'duplicate';
    await store.add({ text: 'I like tea', source: 'explicit' });
    // A global note and a project's meet in that project's chats.
    await assert.rejects(store.add({ text: 'I like tea', scope: 'project_p1', source: 'explicit' }), isDuplicate);
    const deadline = await store.add({ text: 'Deadline is Friday', scope: 'project_p1', source: 'explicit' });
    await assert.rejects(store.add({ text: 'deadline is  friday', source: 'suggested' }), isDuplicate);
    // Two projects never meet: each may keep the same note.
    await store.add({ text: 'Deadline is Friday', scope: 'project_p2', source: 'explicit' });
    // Neither an edit nor a move may make a copy.
    const other = await store.add({ text: 'Deadline is Monday', scope: 'project_p1', source: 'explicit' });
    await assert.rejects(store.update(other.id, { text: 'Deadline is Friday' }), isDuplicate);
    await assert.rejects(store.update(deadline.id, { scope: 'global' }), isDuplicate);
    await store.update(other.id, { text: 'Deadline is Monday morning' });
    assert.deepEqual((await store.list()).facts.map((f) => `${f.scope}: ${f.text}`).sort(), [
      'global: I like tea',
      'project_p1: Deadline is Friday',
      'project_p1: Deadline is Monday morning',
      'project_p2: Deadline is Friday',
    ]);
  });

  it('edits, deletes, clears and exports notes as starpi.memory/v1', async () => {
    const { store } = await setup();
    const a = await store.add({ text: 'I like tea', source: 'explicit' });
    await store.add({ text: 'Deadline is Friday', scope: 'project_p1', source: 'suggested' });
    await store.update(a.id, { text: 'I like green tea' });
    const doc = await store.exportDoc({ exportedAt: '2026-10-18T12:00:00.000Z', version: '3.0.0-test', projectName: (id) => (id === 'project_p1' ? 'Thesis' : null) });
    assert.equal(doc.schema, MEMORY_EXPORT);
    assert.deepEqual(
      doc.facts.map((f) => [f.text, f.scope, f.project ?? null, f.source]).sort(),
      [
        ['Deadline is Friday', 'project', 'Thesis', 'suggested'],
        ['I like green tea', 'global', null, 'explicit'],
      ],
    );
    await store.remove(a.id);
    assert.equal((await store.list()).facts.length, 1);
    await store.clear();
    assert.equal((await store.list()).facts.length, 0);
  });

  it('keeps custom instructions apart from the notes', async () => {
    const { store } = await setup();
    assert.deepEqual(await store.instructions(), { aboutMe: '', howToAnswer: '' });
    await store.setInstructions({ aboutMe: '  I teach biology.  ' });
    await store.setInstructions({ howToAnswer: 'Be brief.' });
    assert.deepEqual(await store.instructions(), { aboutMe: 'I teach biology.', howToAnswer: 'Be brief.' });
    assert.equal((await store.setInstructions({ aboutMe: 'z'.repeat(5000) })).aboutMe.length, MEMORY_LIMITS.instructionChars);
  });
});

describe('project scoping', () => {
  it('uses the global notes outside a project and what the project allows inside one', () => {
    assert.deepEqual(scopesFor(null), ['global']);
    assert.deepEqual(scopesFor({ id: 'p1', memoryScope: 'global' }), ['global', 'p1']);
    assert.deepEqual(scopesFor({ id: 'p1', memoryScope: 'project' }), ['p1']);
    assert.deepEqual(scopesFor({ id: 'p1', memoryScope: 'off' }), []);
    assert.equal(defaultScopeFor({ id: 'p1', memoryScope: 'project' }), 'p1');
    assert.equal(defaultScopeFor({ id: 'p1', memoryScope: 'global' }), 'global');
    assert.equal(defaultScopeFor(null), 'global');
  });

  it('recalls only the notes of the allowed scopes', async () => {
    const { store } = await setup();
    await store.setPrefs({ enabled: true });
    await store.add({ text: 'I like tea', source: 'explicit' });
    await store.add({ text: 'The thesis is about tea plantations', scope: 'p1', source: 'explicit' });
    await store.add({ text: 'The garden needs tea compost', scope: 'p2', source: 'explicit' });
    const texts = async (/** @type {string[]} */ scopes) => (await store.recall('tea', scopes, 'en')).facts.map((f) => f.text).sort();
    assert.deepEqual(await texts(scopesFor(null)), ['I like tea']);
    assert.deepEqual(await texts(scopesFor({ id: 'p1', memoryScope: 'global' })), ['I like tea', 'The thesis is about tea plantations']);
    assert.deepEqual(await texts(scopesFor({ id: 'p1', memoryScope: 'project' })), ['The thesis is about tea plantations']);
    assert.deepEqual(await texts(scopesFor({ id: 'p1', memoryScope: 'off' })), []);
    // Deleting a project deletes its notes.
    assert.equal(await store.removeScope('p2'), 1);
    assert.deepEqual((await store.list()).facts.map((f) => f.scope).sort(), ['global', 'p1']);
  });

  it('lets a suggestion call send only notes of the chat\'s scopes, at most 8, and compares the rest on the device', () => {
    const facts = [
      fact({ id: 'g', text: 'I live in Lisbon' }),
      fact({ id: 'b', text: 'Project B budget is secret', scope: 'pB' }),
      ...Array.from({ length: 12 }, (_, i) => fact({ id: `a${i}`, text: `Project A note ${i} about tiles`, scope: 'pA' })),
    ];
    const turn = { question: 'Which tiles fit a kitchen?', answer: 'Glazed tiles.', now: NOW };
    const outside = suggestionNotes(facts, scopesFor(null), turn);
    assert.deepEqual(outside.existing, ['I live in Lisbon']);
    assert.equal(outside.known.length, facts.length);
    const inA = suggestionNotes(facts, scopesFor({ id: 'pA', memoryScope: 'project' }), turn);
    assert.equal(inA.existing.length, MEMORY_LIMITS.injectedFacts);
    assert.ok(inA.existing.every((text) => text.startsWith('Project A note')));
    assert.deepEqual(suggestionNotes(facts, scopesFor({ id: 'pA', memoryScope: 'off' }), turn).existing, []);
    // Whatever the caller passes, suggestFacts sends at most 8 notes.
    /** @type {any[]} */
    const sent = [];
    void suggestFacts({ question: 'q', answer: 'a', existing: facts.map((f) => f.text) }, { run: async (_p, input) => (sent.push(input), { ok: false }), providers: [] });
    assert.equal(sent[0].existing.length, MEMORY_LIMITS.injectedFacts);
  });
});

describe('system note', () => {
  it('joins the assistant, project and custom instructions, and is empty without them', () => {
    assert.equal(systemNoteFor({}, 'en'), '');
    assert.equal(systemNoteFor({ instructions: { aboutMe: ' ', howToAnswer: '' }, project: { name: 'P', instructions: '' } }, 'en'), '');
    const note = systemNoteFor({ assistant: { name: 'Tutor "X"', instructions: 'Explain step by step.' }, project: { name: 'Thesis', instructions: 'Cite sources.' }, instructions: { aboutMe: 'I teach.', howToAnswer: 'Be brief.' } }, 'en');
    const order = ['The user set up', 'You act as the assistant', 'Explain step by step.', 'project "Thesis"', 'Cite sources.', 'I teach.', 'Be brief.'].map((s) => note.indexOf(s));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), note);
    assert.ok(!note.includes('"X"'), 'quotes in a name are defused');
    assert.match(systemNoteFor({ instructions: { aboutMe: 'Ich unterrichte.' } }, 'de'), /^Der Nutzer hat für dieses Gespräch/);
  });

  it('stays the same from turn to turn (no date, no notes)', () => {
    const input = { project: { name: 'Thesis', instructions: 'Cite sources.' } };
    assert.equal(systemNoteFor(input, 'en'), systemNoteFor(input, 'en'));
    assert.ok(!/\d{4}/.test(systemNoteFor(input, 'en')));
  });
});

describe('vault', () => {
  /** A real key store on its own fake database, with fast key derivation. */
  async function vaultSetup() {
    const keysDb = await openAppDb({ name: `memory-vault-${(seq += 1)}`, factory: new IDBFactory() });
    const keys = createKeyStore({ db: async () => keysDb, session: { read: () => '', write: () => true, remove: () => {} }, iterations: 1000 });
    await keys.ready();
    /** @type {import('../../src/js/ai/memory.js').MemoryVault} */
    const vault = { state: () => keys.vaultState(), seal: (text) => keys.seal(SEAL_PURPOSE, text), open: (sealed) => keys.open(SEAL_PURPOSE, sealed) };
    return { keys, vault, ...(await setup({ vault })) };
  }

  it('seals the notes while a passphrase is set, and hides them while the vault is locked', async () => {
    const { keys, store, db } = await vaultSetup();
    await store.add({ text: 'Plain before the vault', source: 'explicit' });
    assert.equal(await keys.unlock('correct horse battery'), 'created');
    assert.equal(await store.reconcile(), 1);
    await store.add({ text: 'My locker code is not this', source: 'explicit' });
    const raw = await db.getAll('memory');
    assert.equal(raw.length, 2);
    for (const r of raw) {
      assert.equal(r.text, '');
      assert.ok(r.sealed.ct instanceof Uint8Array);
      assert.ok(!new TextDecoder().decode(r.sealed.ct).includes('locker'));
    }
    assert.deepEqual((await store.list()).facts.map((f) => [f.text, f.sealed]).sort(), [
      ['My locker code is not this', true],
      ['Plain before the vault', true],
    ]);
    keys.lock();
    const locked = await store.list();
    assert.deepEqual(locked, { facts: [], locked: 2 });
    await store.setPrefs({ enabled: true });
    assert.deepEqual(await store.recall('locker', ['global'], 'en'), { note: '', facts: [] });
    await assert.rejects(store.add({ text: 'New while locked', source: 'explicit' }), (e) => e instanceof MemoryError && e.code === 'locked');
    assert.equal(store.canStore(), false);
    assert.equal(await keys.unlock('correct horse battery'), 'unlocked');
    assert.equal(store.canStore(), true);
    assert.equal((await store.recall('locker', ['global'], 'en')).facts[0]?.text, 'My locker code is not this');
  });

  it('binds the seal to the memory: another purpose cannot open it', async () => {
    const { keys } = await vaultSetup();
    await keys.unlock('correct horse battery');
    const sealed = await keys.seal(SEAL_PURPOSE, 'secret note');
    assert.equal(await keys.open(SEAL_PURPOSE, sealed), 'secret note');
    assert.equal(await keys.open('other', sealed), null);
  });

  it('keeps the notes read before the vault is forgotten as plain text, and can drop the others', async () => {
    const { keys, store, db } = await vaultSetup();
    await keys.unlock('correct horse battery');
    await store.add({ text: 'Read in this tab', source: 'explicit' });
    await db.put('memory', { id: 'other', text: '', sealed: await keys.seal(SEAL_PURPOSE, 'Sealed elsewhere'), scope: 'global', source: 'explicit', createdAt: NOW, usedAt: null, weight: 1 });
    await keys.forgetAll();
    assert.equal(keys.vaultState(), 'none');
    assert.equal(await store.reconcile(), 1);
    assert.deepEqual(await store.list().then((r) => [r.facts.map((f) => [f.text, f.sealed]), r.locked]), [[['Read in this tab', false]], 1]);
    assert.equal(await store.removeUnreadable(), 1);
    assert.deepEqual((await store.list()).locked, 0);
  });
});
