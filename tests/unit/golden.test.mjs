// Receipts record which extraction, chunking and source-check rules produced them (EXTRACTOR,
// CHUNKER, GROUNDING). These pins fail when a change alters the output for the same input; then
// bump the matching version so old receipts are reported as "version differs" instead of "mismatch",
// and update the pin.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blocksFromMarkdown, GROUNDING, groundAnswer } from '../../src/js/core/grounding.js';
import { CHUNKER, chunkText } from '../../src/js/rag/chunker.js';
import { EXTRACTOR, extractText } from '../../src/js/rag/parser.js';
import { makePdf } from '../fixtures/pdf.mjs';
import { loadCorpora, loadItems } from '../../scripts/eval-source-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
const sample = (/** @type {string} */ rel) => readFileSync(path.join(ROOT, 'public/samples', rel));
/** @param {Uint8Array} bytes @param {string} name */
const extract = async (bytes, name) => (await extractText(new File([bytes], name))).text;

describe(`extraction pins (${EXTRACTOR.id} ${EXTRACTOR.version})`, () => {
  it('Markdown, CSV, JSON and PDF text is unchanged', async () => {
    assert.equal(sha(await extract(sample('en/nebula-plan.md'), 'nebula-plan.md')), '669f7c8278ae89bf50b5b6ffcac2fa1193f3c76949a90a9f1846a34e2baab7a5');
    assert.equal(sha(await extract(sample('de/nebula-risiken.csv'), 'nebula-risiken.csv')), '32175314ee1d48e696c397c228f0a4f54a5dd5fa6112c2616f196a7a3bf9151f');
    assert.equal(sha(await extract(sample('de/nebula-kickoff.pdf'), 'nebula-kickoff.pdf')), '1db1087be42eb533c82ee3a47ef9bb414cd7e5bf112841a52c6551a1d73d98d1');
    assert.equal(sha(await extract(Buffer.from(JSON.stringify({ a: { b: [1, 'x'] }, c: 'Größe' })), 'data.json')), '72894a9bad04ab59181db641cab564324efd876762e7ed186ed90814e795e5a3');
    assert.equal(sha(await extract(makePdf(['Line one', 'Line two: 480000 EUR']), 'fixture.pdf')), 'e33f769220234817b4ca73543d31b697a357e7981e607835b212f9f81a3ac0b3');
  });
});

describe(`chunking pins (${CHUNKER.id} ${CHUNKER.version})`, () => {
  it('chunk bounds are unchanged', async () => {
    const text = await extract(sample('en/nebula-plan.md'), 'nebula-plan.md');
    assert.equal(sha(JSON.stringify(chunkText(text).map((c) => [c.index, c.start, c.end]))), 'c313c2abed051f91ec9bddc49e2249667c4f9695655beaebd09e8ae85bc406af');
    assert.equal(sha(JSON.stringify(chunkText(text, { chunkSize: 120, chunkOverlap: 20 }).map((c) => [c.start, c.end]))), 'cd79b562fa5fee5691f67e24d6249ec7a3691349fdbd09df265035872e8007ea');
  });
});

describe(`source check pins (${GROUNDING.id} ${GROUNDING.version})`, () => {
  it('verdicts on a fixed answer are unchanged', () => {
    const sources = [
      { label: '[Doc: plan.md, Chunk: 1]', doc: 'plan.md', heading: '', text: 'Project Nebula launches on 12 May 2027. The approved budget is 480,000 EUR.', delivered: /** @type {const} */ ('full') },
      { label: '[Doc: notes.md, Chunk: 1]', doc: 'notes.md', heading: '', text: 'The steering group meets every Tuesday at 10:00.', delivered: /** @type {const} */ ('full') },
    ];
    const answer = [
      'Nebula launches on May 12, 2027 [Doc: plan.md, Chunk: 1].',
      'The budget is about 500,000 EUR [Doc: plan.md, Chunk: 1].',
      'The group meets every Friday [Doc: notes.md, Chunk: 1].',
      'The group meets every Tuesday [Doc: plan.md, Chunk: 1].',
      'It was founded in 1999.',
    ].join('\n');
    const report = groundAnswer(blocksFromMarkdown(answer, sources), sources);
    assert.deepEqual(
      report.sentences.map((s) => [s.verdict, s.reasons.map((r) => r.code).join('+')]),
      [
        ['supported', ''],
        ['weak', 'approximate'],
        ['unsupported', 'missing_fact'],
        ['weak', 'fact_elsewhere+low_overlap'],
        ['unsupported', 'uncited_missing'],
      ],
    );
  });

  it('verdicts and reasons on every statement of the 308 labelled answers are unchanged', async () => {
    const corpora = await loadCorpora();
    const lines = (await loadItems()).flatMap((item) => {
      const sources = corpora[item.corpus];
      return groundAnswer(blocksFromMarkdown(item.answer, sources), sources).sentences.map((s) => `${item.id}|${s.verdict}|${s.reasons.map((r) => `${r.code}:${r.fact ?? ''}`).join(',')}`);
    });
    assert.equal(sha(lines.join('\n')), 'e2d8d04e18bf66c0796cc5b1f4959d20214b514233eac2fd1b6b307fdb3d587c');
  });
});
