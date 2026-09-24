// The sample files behind "Try with sample files": every suggested question must find its facts in
// the right file, and the extractive answer must pass the source check without a single flag.
import './setup.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blocksFromMarkdown, groundAnswer } from '../../src/js/core/grounding.js';
import { setLocale } from '../../src/js/i18n/index.js';
import { BM25Index } from '../../src/js/rag/bm25.js';
import { chunkText } from '../../src/js/rag/chunker.js';
import { extractText } from '../../src/js/rag/parser.js';
import { assignCitations } from '../../src/js/retrieval.js';
import { synthesizeAnswer } from '../../src/js/synthesizer.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const de = JSON.parse(readFileSync(path.join(ROOT, 'src/locales/de.json'), 'utf8'));
const en = JSON.parse(readFileSync(path.join(ROOT, 'src/locales/en.json'), 'utf8'));
const demoSource = readFileSync(path.join(ROOT, 'src/js/demo.js'), 'utf8');

const FILES = {
  en: ['en/nebula-plan.md', 'en/nebula-risks.csv', 'en/nebula-kickoff.pdf'],
  de: ['de/nebula-projektplan.md', 'de/nebula-risiken.csv', 'de/nebula-kickoff.pdf'],
};
const EXPECT = {
  en: { launch: ['12 May 2027', 'Lena Park'], budget: ['480,000 EUR', '310,000 EUR'], risks: ['Marta Silva', 'Lena Park'] },
  de: { launch: ['12. Mai 2027', 'Lena Park'], budget: ['480.000 €', '310.000 €'], risks: ['Marta Silva', 'Lena Park'] },
};

for (const [locale, files] of Object.entries(FILES)) {
  describe(`sample files (${locale})`, async () => {
    const index = new BM25Index();
    for (const [d, rel] of files.entries()) {
      const name = /** @type {string} */ (rel.split('/').pop());
      const { text } = await extractText(new File([readFileSync(path.join(ROOT, 'public/samples', rel))], name));
      index.add(chunkText(text).map((c) => ({ docId: `d${d}`, docName: name, chunkIndex: c.index, start: c.start, end: c.end, text: c.text })));
    }
    const dict = locale === 'de' ? de : en;

    it('matches the list the app loads', () => {
      assert.ok(demoSource.includes(`${locale}: [${files.map((f) => `'${f}'`).join(', ')}]`));
    });

    for (const q of /** @type {const} */ (['launch', 'budget', 'risks'])) {
      it(`answers "${dict.demo[`q_${q}_question`]}" with cited facts that pass the source check`, () => {
        setLocale(locale);
        const query = dict.demo[`q_${q}_question`];
        const hits = index.search(query, 6).map((h) => ({
          documentId: h.chunk.docId,
          documentTitle: h.chunk.docName,
          heading: '',
          content: h.chunk.text,
          tags: [],
          rank: h.score,
          workspace: { docId: h.chunk.docId, chunkIndex: h.chunk.chunkIndex, start: h.chunk.start, end: h.chunk.end },
        }));
        const citations = assignCitations(hits, { excerptChars: 1600 });
        const answer = synthesizeAnswer({ query, hits, citations, knownTitles: [], modelAvailable: false });
        for (const fact of EXPECT[/** @type {'en' | 'de'} */ (locale)][q]) assert.ok(answer.includes(fact), `${fact} missing in:\n${answer}`);
        const sources = citations.map((c) => ({ label: c.label, doc: c.doc, heading: c.heading, text: c.text, delivered: /** @type {const} */ ('full') }));
        const report = groundAnswer(blocksFromMarkdown(answer, sources), sources, { citedOnly: true });
        assert.ok(report.counts.supported >= 2, JSON.stringify(report.counts));
        assert.equal(report.counts.weak + report.counts.unsupported, 0, JSON.stringify(report.sentences.filter((s) => s.reasons.length)));
      });
    }
  });
}
