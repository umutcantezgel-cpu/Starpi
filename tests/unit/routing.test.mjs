// Auto routing (src/js/ai/hybrid.js): explicit modes win, a classifier can only tighten a route,
// attachments and references route to the sources, the workspace probe picks grounded, mixed or
// free on the routing cases (tests/fixtures/routing, English and German, then French, Spanish,
// Italian and Turkish over a workspace with files in all six languages), nothing but an attachment routes to the
// sources while there are none, and the Web toggle with a model that cannot search goes through a
// search API into a grounded answer, never for a question kept on this device.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { decideRoute, namesSources, namesTitle, PROBE_THRESHOLDS, probeRoute, searchWebHits, stricter, webHits } from '../../src/js/ai/hybrid.js';
import { loadShippedLanguages } from '../../src/js/core/lang/index.js';
import { BM25Index } from '../../src/js/rag/bm25.js';
import { probeIndex } from '../../src/js/rag/hybrid.js';

const fixture = (/** @type {string} */ name) => JSON.parse(readFileSync(new URL(`../fixtures/routing/${name}`, import.meta.url), 'utf8'));

/**
 * The routing workspace as a BM25 index, and a probe over it.
 * @param {string[]} [files]  fixture files whose chunks it holds
 */
function workspace(files = ['workspace.json']) {
  const index = new BM25Index();
  /** @type {Map<string, number>} */
  const per = new Map();
  /** @type {Array<{ docId: string, docName: string, text: string }>} */
  const chunks = files.flatMap((f) => fixture(f).chunks);
  index.add(
    chunks.map((c) => {
      const i = per.get(c.docId) ?? 0;
      per.set(c.docId, i + 1);
      return { ...c, chunkIndex: i, start: 0, end: c.text.length };
    }),
  );
  const names = [...new Set(chunks.map((c) => c.docName))];
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
      const d = await decideRoute({ question: c.q, mode: 'auto', attachments, workspaceProbe: probe, names, documents: names.length });
      if (d.route === c.route) hits += 1;
      else misses.push(`${c.q} -> ${d.route} (expected ${c.route}; ${d.reasons.join(', ')})`);
      // The costly errors: a question about the files answered freely, or a general one from the files.
      assert.ok(Math.abs(RANK[/** @type {'free'} */ (d.route)] - RANK[/** @type {'free'} */ (c.route)]) < 2, `${c.q}: ${d.route} instead of ${c.route}`);
      if (c.reference) assert.ok(d.reasons.includes('reference'), `${c.q} names the files`);
    }
    assert.ok(hits / cases.length >= 0.95, `accuracy ${hits}/${cases.length}:\n${misses.join('\n')}`);
  });

  it('routes the cases in French, Spanish, Italian and Turkish as labelled, with the same thresholds', async () => {
    await loadShippedLanguages();
    const { probe, names } = workspace(['workspace.json', 'workspace-intl.json']);
    const cases = fixture('cases-intl.json').cases;
    for (const lang of ['fr', 'es', 'it', 'tr']) {
      const own = cases.filter((/** @type {{ lang: string }} */ c) => c.lang === lang);
      assert.ok(own.length >= 5, lang);
      for (const route of ['grounded', 'free']) assert.ok(own.some((/** @type {{ route: string }} */ c) => c.route === route), `${lang}: a ${route} case`);
      assert.ok(own.some((/** @type {{ reference?: boolean }} */ c) => c.reference), `${lang}: a reference case`);
    }
    /** @type {string[]} */
    const misses = [];
    for (const c of cases) {
      const d = await decideRoute({ question: c.q, mode: 'auto', workspaceProbe: probe, names, documents: names.length });
      if (d.route !== c.route) misses.push(`${c.lang}: ${c.q} -> ${d.route} (expected ${c.route}; ${d.reasons.join(', ')})`);
      if (c.reference) assert.ok(d.reasons.includes('reference'), `${c.q} names the files`);
    }
    assert.deepEqual(misses, []);
  });

  it('stays free without a file in the workspace or a document in the library, whatever the question names', async () => {
    const empty = { mode: /** @type {const} */ ('auto'), names: [], titles: [], documents: 0, workspaceProbe: () => ({ score: 0, coverage: 0, terms: 0, matched: [], hits: 0, docId: null }) };
    const questions = [
      'How do I search for a word in the file with grep?',
      'How do I replace a string in the file using sed?',
      'How can I insert a page break in the document in Word?',
      'How do I back up my documents to the cloud?',
      'How do I handle the uploaded file in an Express server?',
      'Wie speichere ich hochgeladene Dateien in PHP?',
      'Wie füge ich im Dokument ein Inhaltsverzeichnis ein?',
      'Please improve this document: Dear Sir, I am writing to ask about the delivery.',
      ...fixture('cases.json')
        .cases.filter((/** @type {{ reference?: boolean }} */ c) => c.reference)
        .map((/** @type {{ q: string }} */ c) => c.q),
      'When is the launch of Project Beta?',
    ];
    for (const question of questions) {
      const d = await decideRoute({ ...empty, question });
      assert.deepEqual([d.route, d.reasons], ['free', ['no_sources']], question);
    }
    const attached = await decideRoute({ ...empty, question: 'Please translate this file.', attachments: [{ kind: 'document', name: 'a.docx' }] });
    assert.equal(attached.route, 'grounded', 'an attached document is a source of its own');
    const unset = await decideRoute({ ...empty, question: 'hello', modelReady: false });
    assert.deepEqual([unset.route, unset.reasons], ['grounded', ['no_sources', 'no_model']], 'without a model the sources are quoted, as before');
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
    assert.ok(namesSources('What does the document say about holidays?'));
    assert.ok(namesSources('According to my notes, when is the review?'));
    assert.ok(namesSources('Was steht laut Quelle über den Termin?'));
    assert.ok(namesSources('Fasse meine Dokumente zusammen'));
    assert.ok(namesSources('Which dates are in my notes?'));
    assert.ok(namesSources('Welche Termine stehen in meinen Notizen?'));
    assert.ok(namesSources('Summarise remote-work-policy.md for me', ['remote-work-policy.md']));
    assert.ok(namesSources('What is in the remote-work-policy?', ['remote-work-policy.md']));
    assert.ok(!namesSources('How do I document my code?'));
    assert.ok(!namesSources('What is a file system?'));
    assert.ok(!namesSources('Tell me about cats', ['a.md', 'cat']), 'names under four characters do not count');
    assert.ok(!namesSources('Take notes for me', ['notes.md']), 'a single common word without its extension does not count');
    assert.ok(namesSources('Was sagt notes.md dazu?', ['notes.md']));
  });

  it('knows the phrases of French, Spanish, Italian and Turkish, with or without accents', () => {
    for (const q of [
      'Que dit le document sur les congés ?',
      'Selon mes notes, quand a lieu la revue ?',
      'Quelles dates figurent dans mes notes ?',
      'D’après les sources, qui valide le budget ?',
      '¿Qué dice el documento sobre las vacaciones?',
      'Según mis notas, ¿cuándo es la revisión?',
      'segun mis notas, ¿cuando es la revision?',
      '¿Qué fechas hay en mis notas?',
      'Cosa dice il documento sulle ferie?',
      'Secondo le mie note, quando è la revisione?',
      'Quali date ci sono nelle mie note?',
      'Belgede ne yazıyor?',
      'Notlarıma göre toplantı ne zaman?',
      'notlarima gore toplanti ne zaman?',
      'NOTLARIMA GÖRE toplantı ne zaman?',
      'Notlarımda hangi tarihler var?',
    ])
      assert.ok(namesSources(q), q);
    for (const q of [
      'Comment chercher un mot dans mes fichiers avec grep ?',
      'Comment puis-je sauvegarder mes documents dans le cloud ?',
      '¿Cómo puedo buscar en mis archivos desde el móvil?',
      'Cómo guardar mis documentos en la nube',
      'Come posso cercare nei miei file sul portatile?',
      'Come salvare i miei documenti nel cloud?',
      'Dosyalarımda nasıl arama yapabilirim?',
      'Belgelerimden nasıl yedek alınır?',
      'Quelle est la capitale du Japon ?',
      '¿Qué es un sistema de archivos?',
      'Cos’è un file system?',
      'Dosya sistemi nedir?',
    ])
      assert.ok(!namesSources(q), q);
  });

  it('leaves how-to questions and pasted text alone', () => {
    for (const q of [
      'How do I search for a word in the file with grep?',
      'How can I insert a page break in the document in Word?',
      'How do I back up my documents to the cloud?',
      'How do I search in my files on my laptop?',
      'How to find text in my notes app?',
      'How do I handle the uploaded file in an Express server?',
      'Wie speichere ich hochgeladene Dateien in PHP?',
      'Wie füge ich im Dokument ein Inhaltsverzeichnis ein?',
      'Wie suche ich in meinen Notizen auf dem Handy?',
      'Please improve this document: Dear Sir, …',
      'Cite the sources in APA style.',
    ])
      assert.ok(!namesSources(q), q);
    assert.ok(namesSources('How do I qualify for the bonus according to my notes?'), 'a reference phrase counts in a how-to question too');
  });

  it('reads a how-to opener only against a place phrase of its own language', async () => {
    await loadShippedLanguages();
    // "comment" and "come" open French and Italian how-to questions, and English requests as well.
    for (const q of [
      'Comment on the risks in my notes.',
      'Comment on the dates in my notes.',
      'Comment further on the budget in my notes.',
      'Comment whether the plan in my files is complete.',
      'Come here and list the dates in my notes.',
      'Come prepare a summary from my notes.',
    ])
      assert.ok(namesSources(q), q);
    for (const q of ['Comment on fait pour chercher dans mes notes ?', 'Come cercare una parola nelle mie note?', 'Notlarımda nasıl arama yapabilirim?'])
      assert.ok(!namesSources(q), q);
    assert.ok(!namesSources('Wie kann man in my files suchen?'), 'English and German openers count together, as they were tuned');
    const { probe, names } = workspace();
    for (const question of ['Comment on the risks in my notes.', 'Comment on the main points in my files.']) {
      const d = await decideRoute({ question, mode: 'auto', workspaceProbe: probe, names, documents: names.length });
      assert.deepEqual([d.route, d.reasons.includes('reference')], ['grounded', true], question);
    }
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
      hits.map((h) => [h.web?.url, h.documentTitle, h.heading, h.content]),
      [
        ['https://news.example/cars', 'Car news', 'news.example', 'Electric cars sold well in 2025. Prices fell.'],
        ['https://prices.example/', 'prices.example', 'prices.example', 'Prices fell.'],
      ],
    );
    assert.ok(hits.every((h) => h.documentId === null && !h.workspace), 'a web page is no library document');
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
