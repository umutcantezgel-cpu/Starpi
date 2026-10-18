// Auto routing (src/js/ai/hybrid.js): explicit modes win, a classifier can only tighten a route,
// attachments and references route to the sources, the workspace probe picks grounded, mixed or
// free on the routing cases (tests/fixtures/routing), and the Web toggle with a model that cannot
// search goes through a search API into a grounded answer, never for a question kept on this device.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { decideRoute, namesSources, namesTitle, PROBE_THRESHOLDS, probeRoute, searchWebHits, stricter, webHits } from '../../src/js/ai/hybrid.js';
import { BM25Index } from '../../src/js/rag/bm25.js';
import { probeIndex } from '../../src/js/rag/hybrid.js';

const fixture = (/** @type {string} */ name) => JSON.parse(readFileSync(new URL(`../fixtures/routing/${name}`, import.meta.url), 'utf8'));

/** The routing workspace as a BM25 index, and a probe over it. */
function workspace() {
  const index = new BM25Index();
  /** @type {Map<string, number>} */
  const per = new Map();
  index.add(
    fixture('workspace.json').chunks.map((/** @type {{ docId: string, docName: string, text: string }} */ c) => {
      const i = per.get(c.docId) ?? 0;
      per.set(c.docId, i + 1);
      return { ...c, chunkIndex: i, start: 0, end: c.text.length };
    }),
  );
  const names = [...new Set(fixture('workspace.json').chunks.map((/** @type {{ docName: string }} */ c) => c.docName))];
  return { probe: (/** @type {string} */ q) => probeIndex(index, q), names };
}

const RANK = { free: 0, mixed: 1, grounded: 2 };

describe('decideRoute', () => {
  it('keeps an explicit mode and a project mode, whatever the question carries', async () => {
    const { probe } = workspace();
    const doc = [{ kind: 'pdf', name: 'a.pdf' }];
    assert.equal((await decideRoute({ question: 'What budget did the board approve?', mode: 'free', attachments: doc, workspaceProbe: probe })).route, 'free');
    assert.equal((await decideRoute({ question: 'hello', mode: 'grounded', workspaceProbe: probe })).route, 'grounded');
    const project = await decideRoute({ question: 'hello', mode: 'auto', project: { mode: 'grounded' }, workspaceProbe: probe });
    assert.deepEqual([project.route, project.reasons], ['grounded', ['project']]);
    const explicit = await decideRoute({ question: 'x', mode: 'grounded', web: { on: true, native: false, searchApi: true } });
    assert.deepEqual(explicit.retrieval.sources, ['workspace', 'supabase'], 'an explicit mode never adds the web');
  });

  it('routes the routing cases as labelled: no free question to the sources, no source question to the free chat', async () => {
    const { probe, names } = workspace();
    const cases = fixture('cases.json').cases;
    assert.ok(cases.length >= 40);
    /** @type {string[]} */
    const misses = [];
    let hits = 0;
    for (const c of cases) {
      const attachments = (c.files ?? []).map((/** @type {string} */ kind) => ({ kind, name: `file.${kind === 'image' ? 'png' : 'pdf'}` }));
      const d = await decideRoute({ question: c.q, mode: 'auto', attachments, workspaceProbe: probe, names });
      if (d.route === c.route) hits += 1;
      else misses.push(`${c.q} -> ${d.route} (expected ${c.route}; ${d.reasons.join(', ')})`);
      // The costly errors: a question about the files answered freely, or a general one from the files.
      assert.ok(Math.abs(RANK[/** @type {'free'} */ (d.route)] - RANK[/** @type {'free'} */ (c.route)]) < 2, `${c.q}: ${d.route} instead of ${c.route}`);
      if (c.reference) assert.ok(d.reasons.includes('reference'), `${c.q} names the files`);
    }
    assert.ok(hits / cases.length >= 0.95, `accuracy ${hits}/${cases.length}:\n${misses.join('\n')}`);
  });

  it('keeps the probe thresholds in order', () => {
    assert.ok(PROBE_THRESHOLDS.weak < PROBE_THRESHOLDS.strong);
    assert.equal(probeRoute(null), 'free');
    assert.equal(probeRoute({ score: 0.9, coverage: 1, terms: 3, matched: ['a'], hits: 1, docId: 'd' }), 'free', 'one matched term of three is chance');
    assert.equal(probeRoute({ score: 0.9, coverage: 1, terms: 1, matched: ['nebula'], hits: 1, docId: 'd' }), 'grounded', 'a one-word question that matches');
    assert.equal(probeRoute({ score: 0.35, coverage: 0.5, terms: 4, matched: ['a', 'b'], hits: 1, docId: 'd' }), 'mixed');
    assert.equal(probeRoute({ score: 0.6, coverage: 0.4, terms: 5, matched: ['a', 'b'], hits: 1, docId: 'd' }), 'mixed', 'a high score with low coverage is a weaker match');
  });

  it('lets a classifier tighten the route but never loosen it', async () => {
    const { probe } = workspace();
    const doc = [{ kind: 'document', name: 'a.docx' }];
    const looser = await decideRoute({ question: 'Translate this.', mode: 'auto', attachments: doc, workspaceProbe: probe, hooks: { classify: () => ({ route: 'free', reasons: ['chit-chat'] }) } });
    assert.equal(looser.route, 'grounded');
    assert.deepEqual(looser.reasons.slice(0, 3), ['classifier', 'chit-chat', 'attachment']);
    const tighter = await decideRoute({ question: 'What is the capital of France?', mode: 'auto', workspaceProbe: probe, hooks: { classify: async () => ({ route: 'grounded' }) } });
    assert.equal(tighter.route, 'grounded');
    const own = await decideRoute({ question: 'hello', mode: 'auto', workspaceProbe: probe, hooks: { classify: () => ({ route: 'custom-route' }) } });
    assert.equal(own.route, 'custom-route', 'a route of its own counts as the strictest');
    const broken = await decideRoute({
      question: 'What is the capital of France?',
      mode: 'auto',
      workspaceProbe: probe,
      hooks: {
        classify: () => {
          throw new Error('boom');
        },
      },
    });
    assert.equal(broken.route, 'free');
    assert.equal(stricter('grounded', 'free'), 'grounded');
    assert.equal(stricter('free', 'mixed'), 'mixed');
  });

  it('keeps questions with images only free, and quotes the sources when no model is set up', async () => {
    const image = [{ kind: 'image', name: 'a.png' }];
    assert.deepEqual((await decideRoute({ question: 'What is this?', mode: 'auto', attachments: image })).reasons, ['images_only']);
    assert.equal((await decideRoute({ question: 'What is this?', mode: 'auto', attachments: image, modelReady: false })).route, 'free');
    const none = await decideRoute({ question: 'hello', mode: 'auto', modelReady: false });
    assert.deepEqual([none.route, none.reasons], ['grounded', ['no_model']]);
  });

  it('takes fewer passages for mixed answers and none for free ones', async () => {
    const { probe } = workspace();
    const mixed = await decideRoute({ question: 'Do companies pay for a second monitor at home?', mode: 'auto', workspaceProbe: probe });
    assert.equal(mixed.route, 'mixed');
    assert.equal(mixed.retrieval.topK, 3);
    assert.ok(mixed.probe && mixed.probe.matched.includes('monitor'));
    const free = await decideRoute({ question: 'How do I boil an egg?', mode: 'auto', workspaceProbe: probe });
    assert.deepEqual(free.retrieval.sources, []);
  });

  it('sends a web question to the search API when the model cannot search, never from this device', async () => {
    const web = await decideRoute({ question: 'Latest news about electric cars?', mode: 'auto', web: { on: true, native: false, searchApi: true } });
    assert.equal(web.route, 'grounded');
    assert.deepEqual(web.retrieval.sources, ['workspace', 'supabase', 'web']);
    assert.ok(web.reasons.includes('web_search_api'));
    const native = await decideRoute({ question: 'Latest news about electric cars?', mode: 'auto', web: { on: true, native: true, searchApi: true } });
    assert.equal(native.route, 'free', 'a model that searches itself answers freely with its own search');
    const here = await decideRoute({ question: 'Latest news about electric cars?', mode: 'auto', deviceOnly: true, web: { on: true, native: false, searchApi: true } });
    assert.deepEqual([here.route, here.reasons.at(-1)], ['free', 'web_device_only']);
    const none = await decideRoute({ question: 'Latest news?', mode: 'auto', web: { on: true, native: false, searchApi: false } });
    assert.deepEqual([none.route, none.reasons.at(-1)], ['free', 'web_unavailable']);
  });
});

describe('references', () => {
  it('knows the generic phrases in English and German and the names of documents', () => {
    assert.ok(namesSources('What does it say in the document about holidays?'));
    assert.ok(namesSources('Was steht laut Quelle über den Termin?'));
    assert.ok(namesSources('Fasse meine Dokumente zusammen'));
    assert.ok(namesSources('Summarise remote-work-policy.md for me', ['remote-work-policy.md']));
    assert.ok(namesSources('What is in the remote-work-policy?', ['remote-work-policy.md']));
    assert.ok(!namesSources('How do I document my code?'));
    assert.ok(!namesSources('What is a file system?'));
    assert.ok(!namesSources('Tell me about cats', ['a.md', 'cat']), 'names under four characters do not count');
    assert.ok(!namesSources('Take notes for me', ['notes.md']), 'a single common word without its extension does not count');
    assert.ok(namesSources('Was sagt notes.md dazu?', ['notes.md']));
  });
});

describe('titles of the knowledge base', () => {
  it('routes a question that names the subject of a library document to the sources', async () => {
    const titles = ['Project Beta Kickoff', 'Quarterly report.pdf'];
    assert.ok(namesTitle('When is the launch of Project Beta?', titles));
    assert.ok(namesTitle('Wann ist der Launch von Projekt Beta?', ['Projekt Beta Kickoff']));
    assert.ok(namesTitle('Summarise the quarterly report', titles));
    assert.ok(!namesTitle('What is a project?', titles), 'one word of a title is not its subject');
    assert.ok(!namesTitle('Beta project ideas', titles), 'the words in another order');
    const d = await decideRoute({ question: 'When is the launch of Project Beta?', mode: 'auto', titles });
    assert.deepEqual([d.route, d.reasons], ['grounded', ['title']]);
  });
});

describe('web passages', () => {
  const answer = {
    text: 'Electric cars sold well in 2025. Prices fell. Nothing else.',
    segments: [
      { start: 0, end: 32, sources: [0] },
      { start: 33, end: 45, sources: [0, 1] },
    ],
    sources: [
      { uri: 'https://news.example/cars', title: 'Car news' },
      { uri: 'https://prices.example/', title: '' },
      { uri: 'https://unused.example/', title: 'Unused' },
    ],
    queries: [],
    suggestionsHtml: null,
  };

  it('turns the pages of a search answer into passages of the parts that rest on them', () => {
    const hits = webHits(answer);
    assert.deepEqual(
      hits.map((h) => [h.documentId, h.documentTitle, h.heading, h.content]),
      [
        ['https://news.example/cars', 'Car news', 'news.example', 'Electric cars sold well in 2025. Prices fell.'],
        ['https://prices.example/', 'prices.example', 'prices.example', 'Prices fell.'],
      ],
    );
    assert.equal(webHits(answer, 1).length, 1);
  });

  it('never throws when the search fails and returns nothing without a search', async () => {
    assert.deepEqual(await searchWebHits('q', { search: null }), []);
    const failing = async () => {
      throw new Error('offline');
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(await searchWebHits('q', { search: failing }), []);
    } finally {
      console.warn = warn;
    }
    assert.equal((await searchWebHits('q', { search: async () => answer })).length, 2);
  });
});
