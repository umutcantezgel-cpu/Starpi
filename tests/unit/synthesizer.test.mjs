import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeTrace, isGreeting, splitSentences, synthesizeAnswer } from '../../src/js/synthesizer.js';

describe('splitSentences', () => {
  it('keeps ordinals, decimals and abbreviations inside sentences', () => {
    assert.deepEqual(splitSentences('Start am 3. März. Budget ca. 4.5 Mio. EUR, z. B. für Ads! Fertig?\nNeue Zeile'), [
      'Start am 3. März.',
      'Budget ca. 4.5 Mio. EUR, z. B. für Ads!',
      'Fertig?',
      'Neue Zeile',
    ]);
  });
});

const hits = [
  {
    documentId: '1',
    documentTitle: 'Projekt Beta Kickoff',
    heading: '## Überblick',
    content: 'Der Launch von Projekt Beta ist für den 3. März geplant. Anna leitet das Design.',
    tags: [],
    rank: 0.4,
  },
];

describe('synthesizeAnswer', () => {
  it('answers only with sentences that exist in the knowledge base', () => {
    const md = synthesizeAnswer({ query: 'Wann ist der Launch von Projekt Beta?', hits, knownTitles: [], modelAvailable: false });
    assert.match(md, /3\. März/);
    assert.doesNotMatch(md, /Projekt Alpha|45\.000|Sarah|Michael/);
    assert.match(md, /ohne KI Modell/);
  });

  it('admits when nothing matches and lists real titles only', () => {
    const md = synthesizeAnswer({ query: 'Quartalszahlen Asien', hits: [], knownTitles: ['Handbuch'], modelAvailable: true });
    assert.match(md, /Keine passenden Stellen/);
    assert.match(md, /Handbuch/);
    assert.doesNotMatch(md, /ohne KI Modell/);
  });

  it('lists documents on request and greets without inventing content', () => {
    assert.match(synthesizeAnswer({ query: 'Welche Dokumente sind hinterlegt?', hits: [], knownTitles: ['A', 'B'], modelAvailable: true }), /Verfügbare Dokumente \(2\)/);
    assert.ok(isGreeting('Hallo Starpi'));
    assert.match(synthesizeAnswer({ query: 'hallo', hits: [], knownTitles: [], modelAvailable: true }), /Noch keine Dokumente/);
  });

  it('escapes titles so they cannot inject Markdown links', () => {
    const md = synthesizeAnswer({ query: 'liste', hits: [], knownTitles: ['[x](javascript:alert(1))'], modelAvailable: true });
    assert.doesNotMatch(md, /(?<!\\)\[x\](?!\\)/);
  });
});

describe('describeTrace', () => {
  it('reports the retrieval method, hit counts and engine', () => {
    const t = describeTrace({ query: 'q', method: 'Postgres Volltextsuche', hits, engineLabel: 'Cloud', durationMs: 1234 });
    assert.match(t, /Postgres Volltextsuche/);
    assert.match(t, /1 Abschnitte aus 1 Dokumenten/);
    assert.match(t, /1\.2 s/);
  });
});
