// The check of free answers that cite web pages (src/js/rag/web-check.js): quoted page text runs the
// full source check, grounded segments run the gate's web mode, bare citations are labelled cited
// and not checked, and a stored check is read back safely.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkWebAnswer, gateGrounding, labelledAnswer, pageSources, readWebCheck, webCheckKind } from '../../src/js/rag/web-check.js';

const TEXT = 'The bridge opened in 1932. It is 1,149 metres long.';
const PAGE = { url: 'https://bridges.example/harbour', title: 'Harbour bridge facts' };

describe('webCheckKind', () => {
  it('tells what the citations of a provider allow', () => {
    assert.equal(webCheckKind('anthropic', [{ ...PAGE, citedText: 'It opened in 1932.' }]), 'checked');
    assert.equal(webCheckKind('anthropic', [{ ...PAGE }]), 'cited');
    assert.equal(webCheckKind('gemini', [{ ...PAGE, start: 0, end: 26, citedText: 'The bridge opened in 1932.' }]), 'segments');
    assert.equal(webCheckKind('openai', [{ ...PAGE, start: 0, end: 26 }]), 'cited');
    assert.equal(webCheckKind('openai', []), 'none');
    assert.equal(webCheckKind('anthropic', [{ url: 'ftp://x.example/', title: '', citedText: 'x' }]), 'none');
  });
});

describe('checkWebAnswer', () => {
  it('checks an answer against the text its pages quote', () => {
    const citations = [
      { ...PAGE, citedText: 'The harbour bridge opened in 1932.', start: 0, end: 27 },
      { url: 'https://facts.example/length', title: '', citedText: 'The bridge is 1,149 metres long.', start: 27, end: TEXT.length },
    ];
    const pages = pageSources(citations);
    assert.deepEqual(
      [...pages.values()].map((p) => [p.label, p.doc]),
      [
        ['[Doc: Harbour bridge facts, Chunk: 1]', 'Harbour bridge facts'],
        ['[Doc: facts.example, Chunk: 2]', 'facts.example'],
      ],
    );
    assert.equal(labelledAnswer(TEXT, citations, pages), 'The bridge opened in 1932. [Doc: Harbour bridge facts, Chunk: 1] It is 1,149 metres long. [Doc: facts.example, Chunk: 2]');
    assert.deepEqual(checkWebAnswer({ text: TEXT, provider: 'anthropic', citations, question: 'How long is the bridge?' }), { kind: 'checked', pages: 2, supported: 2, flagged: 0, total: 2 });
    const wrong = checkWebAnswer({ text: 'The bridge opened in 1938. It is 1,149 metres long.', provider: 'anthropic', citations });
    assert.equal(wrong.kind, 'checked');
    assert.equal(wrong.flagged, 1);
    assert.equal(wrong.supported, 1);
  });

  it('checks the numbers of a Gemini answer against its grounded segments', () => {
    const inside = [{ ...PAGE, start: 0, end: TEXT.length, citedText: TEXT }];
    assert.deepEqual(gateGrounding(inside), { segments: [{ start: 0, end: TEXT.length, sources: [0] }], sources: [{ uri: PAGE.url, title: PAGE.title }] });
    assert.deepEqual(checkWebAnswer({ text: TEXT, provider: 'gemini', citations: inside, locale: 'en' }), { kind: 'segments', pages: 1, flagged: 0, total: 2 });
    const partly = [{ ...PAGE, start: 0, end: 26, citedText: 'The bridge opened in 1932.' }];
    const r = checkWebAnswer({ text: TEXT, provider: 'gemini', citations: partly, locale: 'en' });
    assert.deepEqual([r.kind, r.flagged, r.total], ['segments', 1, 2]);
  });

  it('labels other citations cited, not checked', () => {
    assert.deepEqual(checkWebAnswer({ text: TEXT, provider: 'xai', citations: [PAGE, PAGE] }), { kind: 'cited', pages: 1 });
    assert.deepEqual(checkWebAnswer({ text: TEXT, provider: 'openai', citations: [] }), { kind: 'none', pages: 0 });
  });
});

describe('readWebCheck', () => {
  it('reads a stored check and drops anything else', () => {
    assert.deepEqual(readWebCheck({ kind: 'checked', pages: 2, supported: 1, flagged: 1, total: 2, extra: 'x' }), { kind: 'checked', pages: 2, supported: 1, flagged: 1, total: 2 });
    assert.deepEqual(readWebCheck({ kind: 'cited', pages: -1, total: 1.5 }), { kind: 'cited', pages: 0 });
    assert.equal(readWebCheck({ kind: 'verified' }), null);
    assert.equal(readWebCheck(null), null);
    assert.equal(readWebCheck('checked'), null);
  });
});
