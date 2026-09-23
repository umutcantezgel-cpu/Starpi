import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assignCitations } from '../../src/js/retrieval.js';
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

const citations = assignCitations(hits, { excerptChars: 1_600 });

describe('synthesizeAnswer', () => {
  it('answers only with sentences that exist in the sources and cites each one', () => {
    const md = synthesizeAnswer({ query: 'Wann ist der Launch von Projekt Beta?', hits, citations, knownTitles: [], modelAvailable: false });
    assert.match(md, /3\. März/);
    assert.doesNotMatch(md, /Projekt Alpha|45\.000|Sarah|Michael/);
    assert.match(md, /no AI model was used/);
    // The label is Markdown-escaped; rendered, it reads [Doc: Projekt Beta Kickoff, Chunk: 1].
    assert.match(md, /\\\[Doc: Projekt Beta Kickoff, Chunk: 1\\\]/);
  });

  it('admits when nothing matches and lists real titles only', () => {
    const md = synthesizeAnswer({ query: 'Quartalszahlen Asien', hits: [], citations: [], knownTitles: ['Handbuch'], modelAvailable: true });
    assert.match(md, /No matching excerpts/);
    assert.match(md, /Handbuch/);
    assert.doesNotMatch(md, /no AI model was used/);
  });

  it('lists documents on request in English and German and greets without inventing content', () => {
    const list = (query) => synthesizeAnswer({ query, hits: [], citations: [], knownTitles: ['A', 'B'], modelAvailable: true });
    assert.match(list('Welche Dokumente sind hinterlegt?'), /Available documents \(2\)/);
    assert.match(list('Which documents are available?'), /Available documents \(2\)/);
    assert.doesNotMatch(list('What is the budget for the documentation team?'), /Available documents \(2\)/);
    assert.ok(isGreeting('Hallo Starpi'));
    assert.ok(isGreeting('Hello there'));
    assert.match(synthesizeAnswer({ query: 'hallo', hits: [], citations: [], knownTitles: [], modelAvailable: true }), /No documents yet/);
  });

  it('escapes titles so they cannot inject Markdown links', () => {
    const md = synthesizeAnswer({ query: 'list documents', hits: [], citations: [], knownTitles: ['[x](javascript:alert(1))'], modelAvailable: true });
    assert.doesNotMatch(md, /(?<!\\)\[x\](?!\\)/);
  });
});

describe('describeTrace', () => {
  it('reports the retrieval method, hit counts and engine', () => {
    const t = describeTrace({ query: 'q', method: 'Postgres full-text search', hits, engineLabel: 'Cloud', durationMs: 1234 });
    assert.match(t, /Postgres full-text search/);
    assert.match(t, /1 excerpts from 1 documents/);
    assert.match(t, /1\.2 s/);
  });
});
