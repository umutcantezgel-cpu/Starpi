// The knowledge graph found in workspace files (src/js/graph-extract.js): every relation a model
// names is checked against the chunk it cites, and the ones the chunk does not support are dropped
// and counted; without a model (none set up, offline) names that share a sentence are linked; the
// results are kept per document and merged with the entities added by hand in the shared knowledge
// base (mocked here), marked auto and manual.
import 'fake-indexeddb/auto';
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { messageText } from '../../src/js/ai/contract.js';
import { getPurpose, graphPassages } from '../../src/js/ai/purposes.js';
import { configureRouter } from '../../src/js/ai/router.js';
import {
  appModelRunner,
  batchInput,
  capitalisedPhrases,
  checkTriple,
  cooccurrenceGraph,
  createGraphStore,
  extractDocs,
  loadMergedGraph,
  makeBatches,
  mergeGraphs,
  namedIn,
  needsReading,
  passageOf,
  readDocChunks,
  RECORD_PREFIX,
  verifyAnswer,
} from '../../src/js/graph-extract.js';
import { createWorkspace } from '../../src/js/rag/workspace-core.js';
import { openAppDb } from '../../src/js/store/schema.js';
import { fakeClock, lastUserText, scriptedProviders, testDeps } from './router-fakes.mjs';

let seq = 0;
const dbName = () => `graph-extract-${(seq += 1)}`;

const GARDEN = [
  { doc: 'ws-1', docName: 'garden.md', chunk: 0, text: 'Mara Jensen leads the Riverside project. The Riverside project buys solar panels from Nordwind Energy.' },
  { doc: 'ws-1', docName: 'garden.md', chunk: 1, text: 'Tom Berger reviews the budget with Mara Jensen every Tuesday.' },
];
const LIBRARY = [{ doc: 'ws-2', docName: 'library.md', chunk: 0, text: 'The Elm Street Library lends seed packets. Priya Natarajan runs the seed exchange at the Elm Street Library.' }];

/** @param {string} docId @param {string} name @param {typeof GARDEN} chunks */
const docOf = (docId, name, chunks, textSha256 = `sha-${docId}`) => ({ docId, name, textSha256, chunks });

/** A model answer as the purpose returns it for a batch of the garden chunks (labelled d1). */
const GARDEN_ANSWER = {
  entities: [
    { name: 'Mara Jensen', type: 'person' },
    { name: 'Riverside project', type: 'project' },
    { name: 'Nordwind Energy', type: 'organization' },
    { name: 'Tom Berger', type: 'person' },
    { name: 'Atlantis Holdings', type: 'organization' },
  ],
  relations: [
    { from: 'Mara Jensen', to: 'Riverside project', label: 'leads', quote: 'Mara Jensen leads the Riverside project', cite: { doc: 'd1', chunk: 0 } },
    { from: 'Riverside projects', to: 'Nordwind Energy', label: 'buys from', quote: 'buys solar panels from Nordwind Energy', cite: { doc: 'd1', chunk: 0 } },
    // The cited chunk names Tom Berger but not the project.
    { from: 'Tom Berger', to: 'Riverside project', label: 'audits', quote: 'Tom Berger reviews the budget', cite: { doc: 'd1', chunk: 1 } },
    // Neither end is in the cited chunk.
    { from: 'Atlantis Holdings', to: 'Mara Jensen', label: 'funds', quote: 'Atlantis Holdings funds Mara Jensen', cite: { doc: 'd1', chunk: 1 } },
    // A passage the batch does not have, and no passage at all.
    { from: 'Tom Berger', to: 'Mara Jensen', label: 'meets', quote: 'Tom Berger reviews the budget with Mara Jensen', cite: { doc: 'd7', chunk: 0 } },
    { from: 'Tom Berger', to: 'Mara Jensen', label: 'works with', quote: 'Tom Berger reviews the budget with Mara Jensen' },
    // Both ends the same thing.
    { from: 'Mara Jensen', to: 'mara jensen', label: 'is', quote: 'Mara Jensen', cite: { doc: 'd1', chunk: 0 } },
    // Supported, with a quote that is not in the chunk: kept, without the quote.
    { from: 'Tom Berger', to: 'Mara Jensen', label: 'reviews the budget with', quote: 'Tom and Mara meet daily', cite: { doc: 'd1', chunk: 1 } },
  ],
};

describe('checking relations against the cited chunk', () => {
  it('drops and counts every relation whose cited chunk does not name both ends', () => {
    const [batch] = makeBatches(GARDEN);
    assert.deepEqual(batchInput(batch).passages.map((p) => [p.doc, p.chunk]), [['d1', 0], ['d1', 1]]);
    const checked = verifyAnswer(GARDEN_ANSWER, batch);
    assert.deepEqual(checked.dropped, { relations: 5, entities: 1 });
    assert.deepEqual(checked.reasons, { object: 1, subject: 1, cite: 2, same: 1, entity: 1 });
    const part = /** @type {import('../../src/js/graph-extract.js').DocPart} */ (checked.parts.get('ws-1'));
    assert.deepEqual(
      part.triples.map((t) => [t.subject, t.predicate, t.object, t.cite.chunk, t.quote ?? null]),
      [
        ['Mara Jensen', 'leads', 'Riverside project', 0, 'Mara Jensen leads the Riverside project'],
        ['Riverside projects', 'buys from', 'Nordwind Energy', 0, 'buys solar panels from Nordwind Energy'],
        ['Tom Berger', 'reviews the budget with', 'Mara Jensen', 1, null],
      ],
    );
    for (const t of part.triples) assert.equal(t.kind, 'model');
    // Entities: the ones some chunk names, with the model's types; the unnamed one is gone.
    assert.deepEqual(
      [...part.entities.values()].map((e) => [e.name, e.type]),
      [
        ['Mara Jensen', 'person'],
        ['Riverside project', 'project'],
        ['Riverside projects', 'other'],
        ['Nordwind Energy', 'organization'],
        ['Tom Berger', 'person'],
      ],
    );
    assert.deepEqual(part.dropped, { relations: 5, entities: 1 });
  });

  it('matches names the way the source check matches words', () => {
    const passage = passageOf('Die Gemeinschaftsgärten am Fluss werden von Mara Jensen und Jana Mueller geleitet. Model X300 ships in 2027.');
    assert.equal(namedIn('Mara Jensen', passage), true);
    assert.equal(namedIn('mara  JENSEN', passage), true, 'case and spacing do not matter');
    assert.equal(namedIn('Jana Müller', passage), true, 'umlauts are folded');
    assert.equal(namedIn('Community Garden', passageOf('The community gardens open in spring.')), true, 'inflection is tolerated');
    assert.equal(namedIn('Mara Olsen', passage), false, 'every word of the name must be there');
    assert.equal(namedIn('Model X200', passage), false, 'a word with a digit must appear as it is');
    assert.equal(namedIn('Model X300', passage), true);
    assert.equal(namedIn('2027', passage), true);
    assert.equal(namedIn('', passage), false);
    const passages = new Map([['ws-1#0', passage]]);
    assert.equal(checkTriple({ subject: 'Mara Jensen', predicate: 'leads', object: 'Model X300', cite: { doc: 'ws-1', chunk: 0 }, kind: 'model' }, passages), null);
    assert.equal(checkTriple({ subject: 'Mara Jensen', predicate: 'leads', object: 'Model X300', cite: { doc: 'ws-1', chunk: 1 }, kind: 'model' }, passages), 'cite');
  });

  it('batches chunks across documents with short labels the model cites', () => {
    const batches = makeBatches([...GARDEN, ...LIBRARY], { maxChunks: 2 });
    assert.equal(batches.length, 2);
    const two = makeBatches([...GARDEN, ...LIBRARY]);
    assert.equal(two.length, 1);
    assert.deepEqual([...two[0].labelOf], [['ws-1', 'd1'], ['ws-2', 'd2']]);
    const bySize = makeBatches([...GARDEN, ...LIBRARY], { maxChars: 120 });
    assert.ok(bySize.length >= 2, 'a batch stays under its character budget');
  });
});

describe('the extract_graph purpose with passages', () => {
  const input = batchInput(makeBatches([...GARDEN, ...LIBRARY])[0]);

  it('heads every passage with its label and asks for the cite', () => {
    const def = /** @type {import('../../src/js/ai/purposes.js').PurposeDef} */ (getPurpose('extract_graph'));
    assert.deepEqual(def.checkInput(input), []);
    assert.deepEqual(def.checkInput({ passages: [{ doc: 'd1', chunk: 0, text: '   ' }] }), ['input:empty']);
    for (const locale of /** @type {const} */ (['en', 'de'])) {
      const [system, user] = def.buildMessages(input, { locale });
      assert.match(messageText(system), /"cite"/);
      assert.match(messageText(user), /\[doc=d1 chunk=0\]\nMara Jensen leads/);
      assert.match(messageText(user), /\[doc=d2 chunk=0\]\nThe Elm Street Library/);
    }
    assert.doesNotMatch(messageText(def.buildMessages({ text: 'Mara leads the project.' }, { locale: 'en' })[0]), /"cite"/, 'a text input is unchanged');
    assert.deepEqual(graphPassages({ passages: [{ doc: 'bad label]', chunk: 0, text: 'x' }, { doc: 'd1', chunk: -1, text: 'x' }, { doc: 'd1', chunk: 2, text: ' ok ' }] }), [{ doc: 'd1', chunk: 2, text: 'ok' }]);
  });

  it('keeps every relation of an answer for the caller to check and count', () => {
    const def = /** @type {import('../../src/js/ai/purposes.js').PurposeDef} */ (getPurpose('extract_graph'));
    const res = def.validate(JSON.stringify(GARDEN_ANSWER), input);
    assert.equal(res.ok, true);
    const value = /** @type {{ relations: Array<{ from: string, cite?: { doc: string, chunk: number } }> }} */ (res.value);
    assert.equal(value.relations.length, GARDEN_ANSWER.relations.length);
    assert.equal(value.relations[0].from, 'Mara Jensen');
    assert.deepEqual(value.relations[0].cite, { doc: 'd1', chunk: 0 });
    assert.equal(value.relations[6].from, 'Mara Jensen', 'a name is spelled as the entity list spells it');
    const counted = verifyAnswer(res.value, makeBatches([...GARDEN, ...LIBRARY])[0]);
    assert.equal(counted.dropped.relations, 5);
  });
});

describe('a run with a model', () => {
  it('reads the documents through the router, checks every answer and counts what it drops', async () => {
    const clock = fakeClock();
    // A scripted model: for each passage it states one relation the passage supports and one it
    // does not (the unsupported one pairs the passage's first name with a name it never mentions).
    const providers = scriptedProviders((call) => {
      const text = lastUserText(call.req);
      const passages = [...text.matchAll(/\[doc=(d\d+) chunk=(\d+)\]\n([^\n]+)/g)].map((m) => ({ doc: m[1], chunk: Number(m[2]), text: m[3] }));
      const relations = passages.flatMap((p) => {
        const names = [...p.text.matchAll(/(?:[A-Z][a-z]+ ){1,2}(?:[A-Z][a-z]+)/g)].map((m) => m[0].trim());
        if (names.length < 2) return [];
        return [
          { from: names[0], to: names[1], label: 'is linked to', quote: p.text.slice(0, 30), cite: { doc: p.doc, chunk: p.chunk } },
          { from: names[0], to: 'Zephyr Logistics', label: 'hires', quote: p.text.slice(0, 30), cite: { doc: p.doc, chunk: p.chunk } },
        ];
      });
      const entities = [...new Set(relations.flatMap((r) => [r.from, r.to]))].map((name) => ({ name, type: 'other' }));
      return { text: JSON.stringify({ entities, relations }) };
    }, clock);
    configureRouter(testDeps(providers, clock, { configured: () => ['openai'], selection: () => ({ provider: 'openai', model: 'gpt-5-mini' }) }));
    try {
      const runner = await appModelRunner();
      assert.ok(runner, 'a configured provider makes a runner');
      assert.equal(runner.leavesDevice, true, 'its passages leave the device');
      assert.equal(await appModelRunner({ deviceOnly: true }), null, 'on this device only, without a loaded model: none');

      /** @type {Array<{ done: number, total: number }>} */
      const seen = [];
      const report = await extractDocs([docOf('ws-1', 'garden.md', GARDEN), docOf('ws-2', 'library.md', LIBRARY)], { run: runner.run, onProgress: (p) => seen.push(p) });
      assert.equal(report.batches, 1);
      assert.equal(report.answered, 1);
      assert.equal(report.modelUsed, true);
      assert.equal(providers.calls.length, 1, 'one call for both small documents');
      assert.deepEqual(seen.at(-1), { done: 3, total: 3 });
      assert.deepEqual(report.graphs.map((g) => [g.docId, g.mode]), [['ws-1', 'model'], ['ws-2', 'model']]);
      // Three passages with two names each: three supported relations, three dropped.
      assert.equal(report.dropped.relations, 3);
      assert.equal(report.graphs.reduce((n, g) => n + g.triples.length, 0), 3);
      assert.equal(report.graphs.reduce((n, g) => n + g.dropped.relations, 0), 3);
      for (const g of report.graphs) for (const t of g.triples) assert.equal(t.cite.doc, g.docId, 'the cite names the real document');
      assert.ok(!report.graphs.some((g) => g.entities.some((e) => e.name === 'Zephyr Logistics')), 'a name no chunk mentions never enters the graph');
    } finally {
      configureRouter(testDeps(scriptedProviders(() => ({ error: 'server' })), clock));
    }
  });

  it('stops at the call limit and leaves the rest for the next run; a cancelled run keeps finished documents', async () => {
    const answers = { calls: 0 };
    /** @type {import('../../src/js/graph-extract.js').RunBatch} */
    const run = async (input) => {
      answers.calls += 1;
      return { value: { entities: [], relations: input.passages.map((p) => ({ from: 'Mara Jensen', to: 'Tom Berger', label: 'meets', quote: 'x', cite: { doc: p.doc, chunk: p.chunk } })) } };
    };
    const docs = [docOf('ws-1', 'garden.md', GARDEN), docOf('ws-2', 'library.md', LIBRARY)];
    const limited = await extractDocs(docs, { run, maxBatches: 1, batch: { maxChunks: 2 } });
    assert.equal(answers.calls, 1);
    assert.deepEqual(limited.graphs.map((g) => g.docId), ['ws-1']);
    assert.equal(limited.deferred, 1);

    const controller = new AbortController();
    const cancelled = await extractDocs(docs, {
      run: async (input) => {
        const res = await run(input);
        controller.abort();
        return res;
      },
      signal: controller.signal,
      batch: { maxChunks: 2 },
    });
    assert.equal(cancelled.cancelled, true);
    assert.deepEqual(cancelled.graphs.map((g) => [g.docId, g.mode]), [['ws-1', 'model']]);
  });
});

describe('without a model', () => {
  it('links capitalised names that share a sentence, checked against their chunk', async () => {
    const report = await extractDocs([docOf('ws-1', 'garden.md', GARDEN), docOf('ws-2', 'library.md', LIBRARY)], { run: null });
    assert.equal(report.batches, 0);
    assert.equal(report.modelUsed, false);
    assert.deepEqual(report.graphs.map((g) => g.mode), ['cooccurrence', 'cooccurrence']);
    const [garden, library] = report.graphs;
    assert.deepEqual(
      garden.triples.map((t) => [t.subject, t.object, t.cite.chunk, t.kind, t.predicate]),
      [
        ['Mara Jensen', 'Riverside', 0, 'cooccurrence', ''],
        ['Nordwind Energy', 'Riverside', 0, 'cooccurrence', ''],
        ['Mara Jensen', 'Tom Berger', 1, 'cooccurrence', ''],
      ],
    );
    assert.deepEqual(library.triples.map((t) => [t.subject, t.object]), [['Elm Street Library', 'Priya Natarajan']]);
    for (const g of report.graphs) {
      const passages = new Map([...GARDEN, ...LIBRARY].map((c) => [`${c.doc}#${c.chunk}`, passageOf(c.text)]));
      for (const t of g.triples) assert.equal(checkTriple(t, passages), null);
      for (const e of g.entities) assert.equal(e.type, 'other');
    }
  });

  it('falls back when no model answers, and finds no runner when nothing is set up (offline)', async () => {
    let calls = 0;
    const silent = async () => {
      calls += 1;
      return null;
    };
    const report = await extractDocs([docOf('ws-1', 'garden.md', GARDEN), docOf('ws-2', 'library.md', LIBRARY)], { run: silent, batch: { maxChunks: 1 } });
    assert.equal(calls, 2, 'two unanswered batches end the model part of the run');
    assert.equal(report.modelUsed, false);
    assert.deepEqual(report.graphs.map((g) => g.mode), ['cooccurrence', 'cooccurrence']);
    assert.ok(report.graphs[0].triples.length > 0);

    // Nothing configured and no model on the device: the router has no step, so there is no
    // runner and the graph is built on the device alone.
    configureRouter({ configured: () => [], device: () => null });
    assert.equal(await appModelRunner(), null);
    assert.equal(await appModelRunner({ deviceOnly: true }), null);
  });

  it('finds names written with capitals, not sentence starts, function words or dates', () => {
    const keys = (/** @type {string} */ s) => capitalisedPhrases(s).map((h) => h.surface);
    assert.deepEqual(keys('The Riverside project is led by Mara Jensen from the Bank of England in May 2026.'), ['Riverside', 'Mara Jensen', 'Bank of England']);
    assert.deepEqual(keys('Windows 11 runs on the old laptop.'), ['Windows 11']);
    assert.deepEqual(keys('On Monday, in March.'), []);
    assert.deepEqual(keys('Annual Report Of The Riverside Garden Club Members'), [], 'a title in capitals is not a name');
    // A single word that starts a sentence counts only where the document also writes it
    // capitalised inside a sentence.
    const doc = [{ doc: 'x', docName: 'x.md', chunk: 0, text: 'Yesterday Mara met Tom. Volunteers and Tom planted trees with Mara.' }];
    const g = cooccurrenceGraph(doc);
    assert.deepEqual([...g.entities.values()].map((e) => e.name).sort(), ['Mara', 'Tom']);
  });

  it('leaves out German nouns, which are capitalised too', () => {
    const doc = [{ doc: 'x', docName: 'x.md', chunk: 0, text: 'Mara Jensen leitet das Projekt am Fluss. Nordwind Energie liefert Mara Jensen die Solarzellen für das Projekt. Die Schule hilft Mara Jensen.' }];
    const graph = cooccurrenceGraph(doc);
    assert.deepEqual([...graph.entities.values()].map((e) => e.name).sort(), ['Mara Jensen', 'Nordwind Energie']);
    assert.deepEqual(graph.triples.map((t) => [t.subject, t.object]), [['Mara Jensen', 'Nordwind Energie']]);
  });
});

describe('reading the workspace and keeping results', () => {
  const PLAN = '# Riverside garden\n\nMara Jensen leads the Riverside garden. Nordwind Energy supplies the pumps.\n\nTom Berger keeps the budget for Mara Jensen.';

  it('reads the chunks the workspace keeps, and the same chunks again for a file kept in memory only', async () => {
    const name = dbName();
    const workspace = createWorkspace({ openDb: () => openAppDb({ name }), fileRoot: null });
    await workspace.init();
    const doc = await workspace.ingest(new File([PLAN], 'plan.md', { type: 'text/markdown' }), { chunkSize: 60, chunkOverlap: 10 });
    assert.ok(doc.chunks > 1);
    const fromStore = await readDocChunks(doc, { openDb: () => openAppDb({ name }), text: null });
    assert.equal(fromStore.length, doc.chunks);
    assert.deepEqual(fromStore.map((c) => c.text), workspace.head(doc.docId, 10).map((h) => h.text));

    // Memory only: no stored chunks; the text is chunked again with the document's settings.
    const again = await readDocChunks({ ...doc, stored: false }, { openDb: () => openAppDb({ name }), text: (id) => workspace.text(id) });
    assert.deepEqual(again, fromStore);
    assert.deepEqual(await readDocChunks({ ...doc, stored: false, chunker: { ...doc.chunker, version: 99 } }, { openDb: null, text: (id) => workspace.text(id) }), [], 'other chunking rules: nothing');
  });

  it('keeps results in the database, or in memory only when files are', async () => {
    const name = dbName();
    const openDb = () => openAppDb({ name });
    const report = await extractDocs([docOf('ws-1', 'garden.md', GARDEN), docOf('ws-2', 'library.md', LIBRARY)], { run: null, now: () => 42 });
    const store = createGraphStore({ openDb });
    await store.save(report.graphs, { persist: true });
    const db = await openDb();
    assert.equal((await db.getAll('settings')).filter((r) => String(r.key).startsWith(RECORD_PREFIX)).length, 2);
    assert.deepEqual((await createGraphStore({ openDb }).load()).map((g) => g.docId).sort(), ['ws-1', 'ws-2'], 'a reload sees them');

    // Memory only: the stored copy goes, this page keeps its own.
    await store.save([report.graphs[0]], { persist: false });
    assert.deepEqual((await createGraphStore({ openDb }).load()).map((g) => g.docId), ['ws-2']);
    assert.deepEqual((await store.load()).map((g) => g.docId).sort(), ['ws-1', 'ws-2']);
    await store.clear();
    assert.deepEqual(await store.load(), []);
    assert.deepEqual(await createGraphStore({ openDb }).load(), []);
  });

  it('reads a document again when its text changed, or when a model can now read it', () => {
    const doc = /** @type {any} */ ({ docId: 'ws-1', textSha256: 'a' });
    const graph = /** @type {any} */ ({ docId: 'ws-1', textSha256: 'a', mode: 'cooccurrence' });
    assert.equal(needsReading(doc, undefined, false), true);
    assert.equal(needsReading(doc, graph, false), false);
    assert.equal(needsReading(doc, graph, true), true);
    assert.equal(needsReading(doc, { ...graph, mode: 'model' }, true), false);
    assert.equal(needsReading({ ...doc, textSha256: 'b' }, { ...graph, mode: 'model' }, true), true);
  });
});

describe('merging with the entities added by hand', () => {
  /** Rows as the shared knowledge base (Supabase) returns them. */
  const MANUAL = {
    entities: [
      { id: '6b1f0c3e-0000-4000-8000-000000000001', name: 'Mara Jensen', entity_type: 'person', description: 'Leads the garden.' },
      { id: '6b1f0c3e-0000-4000-8000-000000000002', name: 'Riverside project', entity_type: 'project', description: null },
      { id: '6b1f0c3e-0000-4000-8000-000000000003', name: 'City council', entity_type: 'regulation', description: null },
    ],
    relations: [{ source_entity_id: '6b1f0c3e-0000-4000-8000-000000000001', target_entity_id: '6b1f0c3e-0000-4000-8000-000000000002', relation_type: 'leads' }],
  };
  /** @type {import('../../src/js/graph-extract.js').DocGraph[]} */
  const GRAPHS = [
    {
      v: 1,
      docId: 'ws-1',
      docName: 'garden.md',
      textSha256: 'sha-ws-1',
      mode: 'model',
      at: 1,
      entities: [
        { name: 'mara jensen', type: 'person' },
        { name: 'Riverside project', type: 'project' },
        { name: 'Nordwind Energy', type: 'organization' },
      ],
      triples: [
        { subject: 'Mara Jensen', predicate: 'Leads', object: 'Riverside project', cite: { doc: 'ws-1', chunk: 0 }, kind: 'model' },
        { subject: 'Riverside project', predicate: 'buys from', object: 'Nordwind Energy', cite: { doc: 'ws-1', chunk: 0 }, quote: 'buys solar panels from Nordwind Energy', kind: 'model' },
        { subject: 'Mara Jensen', predicate: '', object: 'Riverside project', cite: { doc: 'ws-1', chunk: 0 }, kind: 'cooccurrence' },
      ],
      dropped: { relations: 4, entities: 1 },
    },
    {
      v: 1,
      docId: 'ws-2',
      docName: 'library.md',
      textSha256: 'sha-ws-2',
      mode: 'cooccurrence',
      at: 2,
      entities: [
        { name: 'Elm Street Library', type: 'other' },
        { name: 'Priya Natarajan', type: 'other' },
        { name: 'Nordwind Energy', type: 'other' },
      ],
      triples: [
        { subject: 'Elm Street Library', predicate: '', object: 'Priya Natarajan', cite: { doc: 'ws-2', chunk: 0 }, kind: 'cooccurrence' },
        { subject: 'Nordwind Energy', predicate: '', object: 'Priya Natarajan', cite: { doc: 'ws-2', chunk: 3 }, kind: 'cooccurrence' },
      ],
      dropped: { relations: 1, entities: 0 },
    },
  ];

  it('marks every entity and relation auto or manual and joins the ones with the same name', () => {
    const view = mergeGraphs(MANUAL, GRAPHS);
    const byName = new Map(view.entities.map((e) => [e.name, e]));
    const mara = byName.get('Mara Jensen');
    assert.deepEqual([mara?.id, mara?.origin, mara?.description, mara?.docs], ['6b1f0c3e-0000-4000-8000-000000000001', 'both', 'Leads the garden.', ['ws-1']]);
    assert.equal(byName.get('City council')?.origin, 'manual');
    const nordwind = byName.get('Nordwind Energy');
    assert.deepEqual([nordwind?.id, nordwind?.origin, nordwind?.entity_type, nordwind?.docs], ['auto:nordwind energy', 'auto', 'organization', ['ws-1', 'ws-2']]);
    assert.equal(view.entities.filter((e) => e.name.toLowerCase() === 'mara jensen').length, 1, 'one node per name');

    const rel = (/** @type {string} */ a, /** @type {string} */ b) => view.relations.filter((r) => r.source_entity_id === byName.get(a)?.id && r.target_entity_id === byName.get(b)?.id);
    // The hand-made "leads" stays; the same relation found in a file and the co-occurrence of two
    // linked entities add nothing.
    assert.deepEqual(rel('Mara Jensen', 'Riverside project').map((r) => [r.relation_type, r.origin]), [['leads', 'manual']]);
    const buys = rel('Riverside project', 'Nordwind Energy');
    assert.deepEqual(buys.map((r) => [r.relation_type, r.origin, r.kind, r.quote]), [['buys from', 'auto', 'model', 'buys solar panels from Nordwind Energy']]);
    assert.deepEqual(buys[0].cites, [{ doc: 'ws-1', chunk: 0, docName: 'garden.md' }]);
    assert.deepEqual(rel('Elm Street Library', 'Priya Natarajan').map((r) => [r.origin, r.kind]), [['auto', 'cooccurrence']]);

    assert.equal(view.summary.docs, 2);
    assert.deepEqual(view.summary.dropped, { relations: 5, entities: 1 });
    assert.deepEqual(view.summary.modes, { model: 1, cooccurrence: 1, mixed: 0 });
    assert.deepEqual(view.summary.docNames, { 'ws-1': 'garden.md', 'ws-2': 'library.md' });
    assert.equal(view.summary.hidden, 0);
    const limited = mergeGraphs(MANUAL, GRAPHS, { maxAuto: 1 });
    assert.equal(limited.summary.hidden, 2);
    assert.deepEqual(limited.entities.filter((e) => e.origin === 'auto').map((e) => e.name), ['Nordwind Energy'], 'the best connected one stays');
  });

  it('loads the shared knowledge base (mocked) and the kept results, dropping those of removed or changed files', async () => {
    const name = dbName();
    const openDb = () => openAppDb({ name });
    const store = createGraphStore({ openDb });
    await store.save(GRAPHS, { persist: true });
    /** @type {string[]} */
    const asked = [];
    const supabase = {
      listEntities: async () => (asked.push('entities'), { ok: /** @type {const} */ (true), data: MANUAL.entities }),
      listRelations: async () => (asked.push('relations'), { ok: /** @type {const} */ (true), data: MANUAL.relations }),
    };
    // library.md was removed; garden.md is still there with the same text.
    const merged = await loadMergedGraph({ ...supabase, store, docs: [{ docId: 'ws-1', textSha256: 'sha-ws-1' }] });
    assert.deepEqual(asked.sort(), ['entities', 'relations']);
    assert.equal(merged.manualError, null);
    assert.equal(merged.summary.docs, 1);
    assert.ok(!merged.entities.some((e) => e.name === 'Priya Natarajan'));
    assert.deepEqual((await createGraphStore({ openDb }).load()).map((g) => g.docId), ['ws-1'], 'the removed file took its part along');

    // garden.md changed: its old result is not shown and goes too.
    const changed = await loadMergedGraph({ ...supabase, store, docs: [{ docId: 'ws-1', textSha256: 'sha-new' }] });
    assert.equal(changed.summary.docs, 0);
    assert.ok(changed.entities.every((e) => e.origin === 'manual'));
    assert.deepEqual(await store.load(), []);

    // While the documents are unknown nothing is removed.
    await store.save(GRAPHS, { persist: true });
    const unknown = await loadMergedGraph({ ...supabase, store, docs: null });
    assert.equal(unknown.summary.docs, 2);
    assert.equal((await store.load()).length, 2);
  });

  it('still shows what was found in files when the shared knowledge base is missing', async () => {
    const store = createGraphStore({ openDb: null });
    await store.save(GRAPHS, { persist: false });
    const error = { kind: /** @type {const} */ ('missing_schema'), message: 'Could not find the table' };
    const merged = await loadMergedGraph({
      listEntities: async () => ({ ok: false, error }),
      listRelations: async () => ({ ok: false, error }),
      store,
      docs: GRAPHS.map((g) => ({ docId: g.docId, textSha256: g.textSha256 })),
    });
    assert.deepEqual(merged.manualError, error);
    assert.ok(merged.entities.length > 0);
    assert.ok(merged.entities.every((e) => e.origin === 'auto' && e.id.startsWith('auto:')));
    assert.ok(merged.relations.every((r) => r.origin === 'auto'));
  });
});
