// Version 3 of the source check: relations within a statement and across neighbouring statements
// (changes, comparisons, orders in time, carried-over values, shares), checked against the values
// the cited excerpts give. Versions 1 and 2 stay available and give exactly the reports they gave;
// receipts recompute relations with the version they record.
import './setup.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { applyRelations, blocksFromMarkdown, GROUNDING, GROUNDING_VERSIONS, groundAnswer, REASON_CODES, REASON_CODES_V1, REASON_CODES_V2, reasonCodes, receiptAdvisory } from '../../src/js/core/grounding.js';
import { changesIn, findRelations } from '../../src/js/core/relations.js';
import { extractFacts, guessLanguage, indexSource } from '../../src/js/core/facts.js';
import { buildReceipt, validateReceipt, verifyReceipt } from '../../src/js/core/receipt.js';
import { EXTRACTOR } from '../../src/js/rag/parser.js';
import { loadCorpora, loadItems, loadParaphrases, loadV2Items } from '../../scripts/eval-source-check.mjs';

const REPORT_EN = [
  'The museum counted 48,200 visitors in 2024 and 61,500 visitors in 2025.',
  'The east gallery had 12,400 visitors, the west gallery 9,800.',
  'Ticket revenue fell from 310,000 EUR to 280,000 EUR.',
  'Membership rose from 1,200 to 1,500.',
  'The café opened on 3 April 2025. The new lift was installed on 17 June 2025.',
  'Energy costs fell from 90,000 EUR to 45,000 EUR after the switch to heat pumps.',
].join(' ');
const REPORT_DE = [
  'Das Museum zählte 48.200 Besuche im Jahr 2024 und 61.500 Besuche im Jahr 2025.',
  'Die Ostgalerie hatte 12.400 Besuche, die Westgalerie 9.800.',
  'Die Ticketeinnahmen sanken von 310.000 Euro auf 280.000 Euro.',
  'Die Zahl der Mitglieder stieg von 1.200 auf 1.500.',
  'Das Café wurde am 3. April 2025 eröffnet. Der neue Aufzug wurde am 17. Juni 2025 eingebaut.',
].join(' ');

/** @param {string} text @param {string} label */
const source = (text, label) => ({ label, doc: label.slice(6, label.indexOf(',')), heading: '', text, delivered: /** @type {const} */ ('full') });
const EN = [source(REPORT_EN, '[Doc: report.md, Chunk: 1]')];
const DE = [source(REPORT_DE, '[Doc: bericht.md, Chunk: 1]')];

/**
 * The checked statements (verdict and reason codes) and the relations of an answer whose statements
 * (separated by " || ") all cite the one excerpt.
 * @param {string} answer
 * @param {ReturnType<typeof source>[]} sources
 * @param {number} [version]
 */
function check(answer, sources, version = 3) {
  const markdown = answer
    .split(' || ')
    .map((s) => `${s} ${sources[0].label}`)
    .join(' ');
  const report = groundAnswer(blocksFromMarkdown(markdown, sources), sources, { version });
  return {
    report,
    sentences: report.sentences.filter((s) => s.verdict !== 'neutral').map((s) => `${s.verdict}${s.reasons.length ? `:${s.reasons.map((r) => r.code).join('+')}` : ''}`),
    relations: (report.relations ?? []).map((r) => `${r.kind}/${r.verdict}`),
  };
}
const en = (/** @type {string} */ answer) => check(answer, EN);
const de = (/** @type {string} */ answer) => check(answer, DE);

describe('version 3 of the source check', () => {
  it('is the current version, with versions 1 and 2 still available', () => {
    assert.deepEqual(GROUNDING, { id: 'starpi-grounding', version: 3 });
    assert.deepEqual([...GROUNDING_VERSIONS], [1, 2, 3]);
    assert.deepEqual([...REASON_CODES], [...REASON_CODES_V2, 'relation_inverted', 'relation_unsupported']);
    assert.equal(reasonCodes(1), REASON_CODES_V1);
    assert.equal(reasonCodes(2), REASON_CODES_V2);
    assert.equal(reasonCodes(3), REASON_CODES);
    const answer = `Ticket revenue rose from 310,000 EUR to 280,000 EUR ${EN[0].label}.`;
    assert.equal(groundAnswer(blocksFromMarkdown(answer, EN), EN).algorithm.version, 3);
    assert.throws(() => groundAnswer(blocksFromMarkdown(answer, EN), EN, { version: 4 }), /unknown rules version 4/);
  });

  it('gives exactly the version 1 and version 2 reports of every labelled answer (golden)', async () => {
    const corpora = await loadCorpora();
    const items = [...(await loadItems()), ...(await loadV2Items({ unblind: true })), ...(await loadParaphrases())];
    for (const [version, pin] of /** @type {Array<[number, string]>} */ ([
      [1, 'dd7d43f9384eaf82b8b428d2950648dcf8395fe422156b92a95d889433ce5894'],
      [2, 'e1ec01d0eeaeef2224533fb1b37b8d5a9ff08dda69954f0a067bf7ca4fcb530e'],
    ])) {
      const hash = createHash('sha256');
      for (const item of items) {
        const sources = corpora[item.corpus];
        hash.update(`${item.id}\n${JSON.stringify(groundAnswer(blocksFromMarkdown(item.answer, sources), sources, { version }))}\n`);
      }
      assert.equal(hash.digest('hex'), pin, `version ${version}: the whole report, byte for byte`);
    }
  });
});

describe('changes', () => {
  it('flags a change that goes the other way than the excerpt says, and keeps a faithful one', () => {
    assert.deepEqual(en('Ticket revenue rose from 310,000 EUR to 280,000 EUR.').relations, ['comparative/inverted']);
    assert.deepEqual(en('Ticket revenue fell from 310,000 EUR to 280,000 EUR.'), { report: en('Ticket revenue fell from 310,000 EUR to 280,000 EUR.').report, sentences: ['supported'], relations: ['comparative/supported'] });
    // Both values swapped, the verb fitting the swap: the excerpt's order decides.
    assert.deepEqual(en('Membership fell from 1,500 to 1,200.').relations, ['comparative/inverted']);
    assert.deepEqual(de('Die Ticketeinnahmen stiegen von 310.000 Euro auf 280.000 Euro.').sentences, ['weak:relation_inverted']);
  });

  it('reads a value after "to" against the excerpt change that ends there', () => {
    assert.deepEqual(en('Membership fell to 1,500.').relations, ['comparative/inverted']);
    assert.deepEqual(en('Membership rose to 1,500.').sentences, ['supported']);
  });

  it('reads "up from" and "down from" with the value before them', () => {
    assert.deepEqual(en('The museum counted 61,500 visitors in 2025, down from 48,200 in 2024.').sentences, ['weak:relation_inverted']);
    assert.deepEqual(en('The museum counted 61,500 visitors in 2025, up from 48,200 in 2024.').sentences, ['supported']);
  });

  it('checks a stated factor against the values, and a bare factor against the excerpt change of the same thing', () => {
    assert.deepEqual(en('Membership doubled from 1,200 to 1,500.').sentences, ['weak:relation_unsupported']);
    assert.deepEqual(en('Energy costs halved after the switch to heat pumps.').sentences, ['supported']);
    assert.deepEqual(en('Energy costs doubled after the switch to heat pumps.').sentences, ['weak:relation_inverted']);
  });

  it('finds the values of each verb of a clause with two changes', () => {
    const facts = extractFacts('Access requests rose from 12 to 19 and incidents fell from 40 to 10.');
    const changes = changesIn('Access requests rose from 12 to 19 and incidents fell from 40 to 10.', facts);
    assert.deepEqual(
      changes.map((c) => [c.dir, c.from?.surface, c.to?.surface]),
      [
        [1, '12', '19'],
        [-1, '40', '10'],
      ],
    );
    // A German verb at the end of its clause takes the values before it.
    const de2 = 'Die CPU-Last ist von 64 % auf 41 % gesunken.';
    assert.deepEqual(changesIn(de2, extractFacts(de2)).map((c) => [c.dir, c.from?.surface, c.to?.surface]), [[-1, '64', '41']]);
  });
});

describe('comparisons', () => {
  it('binds both sides to their values in the excerpt: two things, two periods, two stated values', () => {
    assert.deepEqual(en('The west gallery had more visitors than the east gallery.').sentences, ['weak:relation_inverted']);
    assert.deepEqual(en('The east gallery had more visitors than the west gallery.').relations, ['comparative/supported']);
    assert.deepEqual(en('There were fewer visitors in 2025 than in 2024.').sentences, ['weak:relation_inverted']);
    assert.deepEqual(en('There were more visitors in 2025 than in 2024.').sentences, ['supported']);
    assert.deepEqual(en('Ticket revenue of 280,000 EUR was higher than the 310,000 EUR before.').relations, ['comparative/inverted']);
    assert.deepEqual(de('Die Westgalerie hatte mehr Besuche als die Ostgalerie.').sentences, ['weak:relation_inverted']);
  });

  it('leaves thresholds, negated comparisons and stated differences alone', () => {
    assert.deepEqual(en('Tickets larger than 280,000 EUR need approval.').relations, []);
    assert.deepEqual(en('The west gallery did not have more visitors than the east gallery.').relations, []);
    assert.deepEqual(en('The east gallery had 2,600 more visitors than the west gallery.').relations, []);
  });
});

describe('orders in time', () => {
  it('compares the dates the excerpt gives the two events', () => {
    assert.deepEqual(en('The new lift was installed before the café opened.').sentences, ['weak:relation_inverted']);
    assert.deepEqual(en('The café opened after the new lift was installed.').sentences, ['weak:relation_inverted']);
    assert.deepEqual(en('The café opened on 3 April 2025, before the new lift was installed.').relations, ['temporal/supported']);
    assert.deepEqual(de('Das Café wurde eröffnet, nachdem der neue Aufzug eingebaut worden war.').sentences, ['weak:relation_inverted']);
    assert.deepEqual(de('Der neue Aufzug wurde vor der Eröffnung des Cafés eingebaut.').sentences, ['weak:relation_inverted']);
  });

  it('does not read a duration or a time as an event', () => {
    assert.deepEqual(en('The café opened after 7 days of testing.').relations, []);
  });
});

describe('values carried over from the statement before', () => {
  it('compares "it rose to B" with the single value of the statement before', () => {
    const answer = 'The museum counted 48,200 visitors in 2024. || In 2025 the number fell to 61,500.';
    const r = en(answer);
    assert.deepEqual(r.sentences, ['supported', 'weak:relation_inverted']);
    const relation = r.report.relations?.find((x) => x.kind === 'reference');
    assert.ok(relation, JSON.stringify(r.report.relations));
    const checked = r.report.sentences.flatMap((s, i) => (s.verdict === 'neutral' ? [] : [i]));
    assert.deepEqual(relation.sentences, checked, 'both statements, in answer order');
    assert.deepEqual(en('The museum counted 48,200 visitors in 2024. || In 2025 the number rose to 61,500.').sentences, ['supported', 'supported']);
    assert.deepEqual(de('Die Zahl der Mitglieder lag zuerst bei 1.200. || Danach sank sie auf 1.500.').sentences, ['supported', 'weak:relation_inverted']);
  });

  it('pairs only with a statement that refers back and a value of a matching unit', () => {
    // No word that refers back: the two statements are not paired.
    assert.deepEqual(en('The museum counted 48,200 visitors in 2024. || In 2025 the museum fell to 61,500.').relations.filter((r) => r.startsWith('reference')), []);
    const statements = [
      { text: 'The share was 4 %.', cites: [0] },
      { text: 'It fell to 61,500.', cites: [0] },
    ];
    assert.deepEqual(findRelations(statements, [{ text: 'The share was 4 %. The museum counted 61,500 visitors.' }], { split: (s) => [s] }), []);
  });
});

describe('shares', () => {
  it('checks "X % of" against the two values of the statement', () => {
    const text = 'Of the 61,500 visitors, 12,300 were pupils.';
    const run = (/** @type {string} */ statement) => findRelations([{ text: statement, cites: [0] }], [{ text }], { split: (s) => [s] }).map((r) => r.verdict);
    assert.deepEqual(run('Of the 61,500 visitors, 12,300 were pupils, 20 % of all visitors.'), ['supported']);
    assert.deepEqual(run('Of the 61,500 visitors, 12,300 were pupils, 30 % of all visitors.'), ['unsupported']);
  });
});

describe('relation findings', () => {
  it('are weak reasons of their statement with the relation and the excerpt passage, and never make a verdict better', () => {
    const { report } = en('Ticket revenue rose from 310,000 EUR to 280,000 EUR.');
    const s = report.sentences.find((x) => x.verdict !== 'neutral');
    const reason = s?.reasons.find((r) => r.code === 'relation_inverted');
    assert.deepEqual(reason, { code: 'relation_inverted', level: 'weak', fact: 'rose from 310,000 EUR to 280,000 EUR', cites: [0], found: 'Ticket revenue fell from 310,000 EUR to 280,000 EUR' });
    // An unsupported statement stays unsupported.
    const results = [{ block: 0, start: 0, end: 10, text: 'Membership fell from 1,500 to 1,200.', cites: [0], citeSource: /** @type {const} */ ('own'), verdict: /** @type {const} */ ('unsupported'), reasons: [{ code: /** @type {const} */ ('missing_fact'), level: /** @type {const} */ ('unsupported') }], overlap: null, crossLanguage: false }];
    const ctx = { sources: EN, indexes: [indexSource(EN[0].text)], given: null, citedOnly: false, version: 3 };
    const after = applyRelations(results, ctx).sentences[0];
    assert.equal(after.verdict, 'unsupported');
    assert.deepEqual(after.reasons.map((r) => r.code), ['missing_fact', 'relation_inverted']);
    // Version 2 leaves the results as they are.
    assert.equal(applyRelations(results, { ...ctx, version: 2 }).sentences, results);
  });

  it('skip statements compared across languages and context-only statements, but read them as the statement before', () => {
    const statements = [
      { text: 'Membership was 1,200 at the start.', cites: [0], context: true },
      { text: 'Then it fell to 1,500.', cites: [0] },
    ];
    const found = findRelations(statements, [{ text: 'Membership was 1,200 at the start and 1,500 at the end.' }], { split: (s) => [s] });
    assert.deepEqual(found.map((f) => [f.kind, f.verdict, f.sentences]), [['reference', 'inverted', [0, 1]]]);
    assert.deepEqual(findRelations([{ ...statements[1], context: true }], [{ text: 'x' }], { split: (s) => [s] }), []);
    assert.equal(guessLanguage('Then it fell to 1,500.'), 'en');
  });
});

describe('receipts with version 3 verdicts', () => {
  /** @param {string} answer @param {number} [version] */
  async function receiptOf(answer, version = 3) {
    const grounding = groundAnswer(blocksFromMarkdown(answer, EN), EN, { version });
    const draft = {
      createdAt: '2026-10-17T12:00:00.000Z',
      version: '3.0.0',
      answer: { text: answer, engine: 'cloud', locale: 'en' },
      question: 'How did the museum do?',
      grounding,
      citations: [{ label: EN[0].label, doc: 'report.md', heading: '', source: /** @type {const} */ ('knowledge'), delivered: /** @type {const} */ ('full'), text: REPORT_EN, truncated: false, documentId: null }],
      ...receiptAdvisory(grounding),
    };
    const parsed = validateReceipt(JSON.parse(JSON.stringify(await buildReceipt(draft))));
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    return /** @type {import('../../src/js/core/receipt.js').Receipt} */ (/** @type {{ receipt: unknown }} */ (parsed).receipt);
  }
  const tools = { extractor: EXTRACTOR, extract: async () => ({ text: '', pdfjs: null }) };

  it('record the relations with statement indexes of the receipt and recompute every verdict', async () => {
    const answer = `# Visitors\n\nThe museum counted 48,200 visitors in 2024 ${EN[0].label}. In 2025 the number fell to 61,500 ${EN[0].label}. The east gallery had more visitors than the west gallery ${EN[0].label}.`;
    const receipt = await receiptOf(answer);
    assert.deepEqual(
      receipt.relations?.map((r) => [r.kind, r.verdict, r.sentences]),
      [
        ['reference', 'inverted', [0, 1]],
        ['comparative', 'supported', [2]],
      ],
    );
    assert.deepEqual(receipt.grounding?.sentences.map((s) => s.verdict), ['supported', 'weak', 'supported']);
    assert.equal(receipt.grounding?.algorithm.version, 3);
    const report = await verifyReceipt(receipt, [], tools);
    assert.deepEqual(report.grounding, { recomputed: 3, differences: [], needsConversation: false });
    assert.deepEqual(report.advisory, { secondOpinions: 0, contradicted: 0, relations: 2, flagged: 1 });
  });

  it('notice a relation verdict changed after the receipt was made', async () => {
    const receipt = await receiptOf(`The museum counted 48,200 visitors in 2024 ${EN[0].label}. In 2025 the number fell to 61,500 ${EN[0].label}.`);
    const tampered = JSON.parse(JSON.stringify(receipt));
    tampered.grounding.sentences[1].verdict = 'supported';
    tampered.grounding.sentences[1].reasons = [];
    const report = await verifyReceipt(tampered, [], tools);
    assert.deepEqual(report.grounding?.differences, [{ sentence: 1, recorded: 'supported', now: 'weak' }]);
  });

  it('recompute a version 2 receipt with version 2, without relations', async () => {
    const receipt = await receiptOf(`The museum counted 48,200 visitors in 2024 ${EN[0].label}. In 2025 the number fell to 61,500 ${EN[0].label}.`, 2);
    assert.equal(receipt.grounding?.algorithm.version, 2);
    assert.equal(receipt.relations, undefined);
    assert.deepEqual(receipt.grounding?.sentences.map((s) => s.verdict), ['supported', 'supported']);
    const report = await verifyReceipt(receipt, [], tools);
    assert.deepEqual(report.grounding, { recomputed: 2, differences: [], needsConversation: false });
    assert.deepEqual(report.warnings, []);
  });

  it('do not count a statement whose relation rests on an excerpt that is not available as a difference', async () => {
    // The value carried over stands in the excerpt the statement before cites, not in its own.
    const A = source('The museum counted 48,200 visitors in 2024.', '[Doc: a.md, Chunk: 1]');
    const B = source('In 2025 the museum counted 61,500 visitors.', '[Doc: b.md, Chunk: 1]');
    const answer = `The museum counted 48,200 visitors in 2024 ${A.label}. In 2025 the number fell to 61,500 ${B.label}.`;
    const grounding = groundAnswer(blocksFromMarkdown(answer, [A, B]), [A, B]);
    assert.deepEqual(grounding.sentences.map((x) => x.verdict), ['supported', 'weak']);
    const second = grounding.sentences[1].reasons.find((r) => r.code === 'relation_inverted');
    assert.deepEqual(second?.cites, [0, 1]);
    const citation = (/** @type {typeof A} */ c) => ({ label: c.label, doc: c.doc, heading: '', source: /** @type {const} */ ('knowledge'), delivered: /** @type {const} */ ('full'), text: c.text, truncated: false, documentId: null });
    const receipt = await buildReceipt({ createdAt: '2026-10-17T12:00:00.000Z', version: '3.0.0', answer: { text: answer, engine: 'cloud', locale: 'en' }, question: 'q', grounding, citations: [citation(A), citation(B)], ...receiptAdvisory(grounding) });
    const full = await verifyReceipt(/** @type {any} */ (JSON.parse(JSON.stringify(receipt))), [], tools);
    assert.deepEqual(full.grounding, { recomputed: 2, differences: [], needsConversation: false });
    // Without the first excerpt's text the first statement cannot be recomputed, and neither can the
    // relation of the second: it is left out instead of reported as changed.
    const without = JSON.parse(JSON.stringify(receipt));
    without.citations[0].excerpt.text = null;
    const report = await verifyReceipt(without, [], tools);
    assert.deepEqual(report.grounding, { recomputed: 0, differences: [], needsConversation: false });
  });
});
