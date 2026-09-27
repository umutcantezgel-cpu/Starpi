import './setup.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blocksFromMarkdown, groundAnswer } from '../../src/js/core/grounding.js';
import { buildReceipt, canonicalJson, RECEIPT_SCHEMA, sha256Hex, validateReceipt, verifyReceipt } from '../../src/js/core/receipt.js';
import { CHUNKER, chunkText } from '../../src/js/rag/chunker.js';
import { EXTRACTOR, extractText } from '../../src/js/rag/parser.js';
import { makePdf } from '../fixtures/pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts/verify-receipt.mjs');

const tools = {
  extractor: EXTRACTOR,
  extract: async (/** @type {Uint8Array} */ bytes, /** @type {string} */ name) => {
    const r = await extractText(new File([bytes], name));
    return { text: r.text, pdfjs: r.pdfjs };
  },
};

/**
 * A receipt for an answer about one file, built the way the app builds it.
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {string} answer  may contain {label}
 */
async function receiptFor(bytes, name, answer) {
  const { text, pages, pdfjs } = await extractText(new File([bytes], name));
  const chunk = chunkText(text)[0];
  const label = `[Doc: ${name}, Chunk: 1]`;
  const answerText = answer.replaceAll('{label}', label);
  const sources = [{ label, doc: name, heading: '', text: chunk.text, delivered: /** @type {const} */ ('full') }];
  return buildReceipt({
    createdAt: '2026-09-24T01:00:00.000Z',
    version: '1.1.0',
    answer: { text: answerText, engine: 'cloud', locale: 'en' },
    question: 'When does the beta start?',
    grounding: groundAnswer(blocksFromMarkdown(answerText, sources), sources),
    citations: [
      {
        label,
        doc: name,
        heading: '',
        source: 'workspace',
        delivered: 'full',
        text: chunk.text,
        truncated: false,
        document: {
          name,
          kind: name.split('.').pop() ?? '',
          bytes: bytes.length,
          fileSha256: await sha256Hex(bytes),
          textSha256: await sha256Hex(text),
          textChars: text.length,
          pages,
          extractor: { ...EXTRACTOR, pdfjs },
          chunker: { ...CHUNKER, size: 500, overlap: 50 },
        },
        chunk: { index: 0, start: chunk.start, end: chunk.end },
      },
      { label: '[Doc: Handbook, Chunk: 1]', doc: 'Handbook', heading: 'Travel', source: 'knowledge', delivered: 'full', text: 'Trains are booked in second class.', truncated: false, documentId: 'kb-1' },
    ],
  });
}

const PDF = makePdf(['Kickoff notes', 'The beta starts at the Hamburg depot on 1 February 2027.', 'The steering group meets every Tuesday at 10:00.']);
const MD = new TextEncoder().encode('# Plan\n\nThe approved budget is 480,000 EUR.\n');

describe('receipt building', () => {
  it('hashes with SHA-256 over UTF-8 and serializes canonically', async () => {
    assert.equal(await sha256Hex('Größe'), createHash('sha256').update('Größe', 'utf8').digest('hex'));
    assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined, 'ä': { z: 2, y: 1 } }), '{"a":[true,null,"x"],"b":1,"ä":{"y":1,"z":2}}');
    assert.throws(() => canonicalJson({ n: Number.NaN }));
  });

  it('records file and text fingerprints, offsets and verdicts, and an id over the rest', async () => {
    const r = await receiptFor(PDF, 'kickoff.pdf', 'The beta starts on 1 February 2027 {label}. The group meets every Friday {label}.');
    assert.equal(r.schema, RECEIPT_SCHEMA);
    assert.equal(r.citations[0].document?.fileSha256, createHash('sha256').update(PDF).digest('hex'));
    assert.equal(r.citations[0].verifiable, true);
    assert.equal(r.citations[1].verifiable, false);
    assert.deepEqual(r.grounding?.sentences.map((s) => s.verdict), ['supported', 'unsupported']);
    const { id, ...body } = r;
    assert.equal(id, await sha256Hex(canonicalJson(body)));
    assert.deepEqual(validateReceipt(JSON.parse(JSON.stringify(r))).ok, true);
  });

  it('leaves the question and excerpt texts out on request, keeping their fingerprints', async () => {
    const full = await receiptFor(MD, 'plan.md', 'The budget is 480,000 EUR {label}.');
    const { buildReceipt: build } = await import('../../src/js/core/receipt.js');
    assert.ok(full.question);
    const lean = await build(
      {
        createdAt: full.createdAt,
        version: '1.1.0',
        answer: { text: full.answer.text, engine: 'cloud', locale: 'en' },
        question: 'q',
        grounding: null,
        citations: [{ label: 'l', doc: 'd', heading: '', source: 'knowledge', delivered: 'full', text: 'excerpt', truncated: false }],
      },
      { includeQuestion: false, includeExcerpts: false },
    );
    assert.equal(lean.question, null);
    assert.equal(lean.citations[0].excerpt.text, null);
    assert.equal(lean.citations[0].excerpt.sha256, await sha256Hex('excerpt'));
  });
});

describe('validateReceipt', () => {
  it('rejects other schemas, bad hashes, out-of-range citation indexes and oversized text', async () => {
    const r = JSON.parse(JSON.stringify(await receiptFor(MD, 'plan.md', 'The budget is 480,000 EUR {label}.')));
    assert.deepEqual(validateReceipt({ schema: 'x' }), { ok: false, error: 'not_a_receipt', path: 'schema' });
    assert.deepEqual(validateReceipt({ ...r, schema: 'starpi.receipt/v2' }), { ok: false, error: 'unsupported_version', path: 'schema' });
    assert.equal(validateReceipt({ ...r, id: 'abc' }).ok, false);
    const badCite = structuredClone(r);
    badCite.grounding.sentences[0].cites = [9];
    assert.deepEqual(validateReceipt(badCite), { ok: false, error: 'citation indexes', path: 'grounding.sentences[0].cites' });
    const huge = structuredClone(r);
    huge.citations[0].excerpt.text = 'x'.repeat(30_000);
    assert.equal(validateReceipt(huge).ok, false);
    const negative = structuredClone(r);
    negative.citations[0].chunk.start = -1;
    assert.equal(validateReceipt(negative).ok, false);
  });
});

describe('verifyReceipt', () => {
  it('reproduces every workspace passage from the original files and recomputes the verdicts', async () => {
    const r = await receiptFor(PDF, 'kickoff.pdf', 'The beta starts on 1 February 2027 {label}. The group meets every Friday {label}.');
    const report = await verifyReceipt(r, [{ name: 'renamed.pdf', bytes: PDF }], tools);
    assert.equal(report.idMatches, true);
    assert.equal(report.answerMatches, true);
    assert.deepEqual(report.citations.map((c) => [c.file, c.text, c.passage, c.chunk]), [
      ['match', 'match', 'match', 'match'],
      ['not_verifiable', null, null, null],
    ]);
    assert.deepEqual(report.summary, { reproduced: 1, verifiable: 1 });
    assert.deepEqual(report.grounding?.differences, []);
  });

  it('reports a missing or modified file', async () => {
    const r = await receiptFor(MD, 'plan.md', 'The budget is 480,000 EUR {label}.');
    const changed = new TextEncoder().encode('# Plan\n\nThe approved budget is 520,000 EUR.\n');
    const report = await verifyReceipt(r, [{ name: 'plan.md', bytes: changed }], tools);
    assert.equal(report.citations[0].file, 'missing');
    assert.deepEqual(report.summary, { reproduced: 0, verifiable: 1 });
  });

  it('detects an edited receipt: answer, excerpt and id', async () => {
    const r = await receiptFor(MD, 'plan.md', 'The budget is 480,000 EUR {label}.');
    const edited = structuredClone(r);
    edited.answer.text = edited.answer.text.replace('480,000', '520,000');
    edited.citations[0].excerpt.text = edited.citations[0].excerpt.text?.replace('480,000', '520,000') ?? null;
    const report = await verifyReceipt(edited, [{ name: 'plan.md', bytes: MD }], tools);
    assert.equal(report.idMatches, false);
    assert.equal(report.answerMatches, false);
    assert.equal(report.citations[0].excerptConsistent, false);
    assert.equal(report.citations[0].passage, 'match', 'the file passage itself is still genuine');
  });

  it('recomputes a cut excerpt on the part that reached the model, so a genuine receipt has no differences', async () => {
    const excerpt = `${'The steering group reviewed the plan in detail. '.repeat(8)}The approved budget is 480,000 EUR.`;
    const label = '[Doc: Budget 2026, Chunk: 1]';
    const delivered = excerpt.slice(0, 200);
    const answer = `The approved budget is 480,000 EUR ${label}.`;
    const sources = [{ label, doc: 'Budget 2026', heading: '', text: delivered, delivered: /** @type {const} */ ('partial') }];
    const grounding = groundAnswer(blocksFromMarkdown(answer, sources), sources);
    assert.equal(grounding.sentences[0].verdict, 'unsupported', 'the value is in the part that did not reach the model');
    const citation = { label, doc: 'Budget 2026', heading: '', source: /** @type {const} */ ('knowledge'), delivered: /** @type {const} */ ('partial'), text: excerpt, truncated: false, documentId: 'kb-2' };
    const withLength = await buildReceipt({ createdAt: '2026-09-24T01:00:00.000Z', version: '1.1.0', answer: { text: answer, engine: 'cloud', locale: 'en' }, question: 'Budget?', grounding, citations: [{ ...citation, deliveredChars: delivered.length }] });
    assert.equal(validateReceipt(JSON.parse(JSON.stringify(withLength))).ok, true);
    const ok = await verifyReceipt(withLength, [], tools);
    assert.equal(ok.grounding?.recomputed, 1);
    assert.deepEqual(ok.grounding?.differences, []);
    // Without the delivered length the statement cannot be recomputed and is left out, not reported as changed.
    const without = await buildReceipt({ createdAt: '2026-09-24T01:00:00.000Z', version: '1.1.0', answer: { text: answer, engine: 'cloud', locale: 'en' }, question: 'Budget?', grounding, citations: [citation] });
    const skipped = await verifyReceipt(without, [], tools);
    assert.equal(skipped.grounding?.recomputed, 0);
    assert.deepEqual(skipped.grounding?.differences, []);
  });

  it('leaves out passages quoted in reasons when the excerpt texts are left out', async () => {
    const label = '[Doc: plan.md, Chunk: 1]';
    const text = 'The budget is 480,000 EUR. It is split into 95,000 EUR for infrastructure and 75,000 EUR for training. CONFIDENTIAL';
    const answer = `Of the budget, 75,000 EUR is reserved for infrastructure ${label}.`;
    const sources = [{ label, doc: 'plan.md', heading: '', text, delivered: /** @type {const} */ ('full') }];
    const grounding = groundAnswer(blocksFromMarkdown(answer, sources), sources);
    assert.equal(grounding.sentences[0].reasons[0].code, 'fact_context');
    const draft = { createdAt: '2026-09-24T01:00:00.000Z', version: '1.1.0', answer: { text: answer, engine: 'cloud', locale: 'en' }, question: 'Budget?', grounding, citations: [{ label, doc: 'plan.md', heading: '', source: /** @type {const} */ ('knowledge'), delivered: /** @type {const} */ ('full'), text, truncated: false, documentId: null }] };
    const without = await buildReceipt(draft, { includeExcerpts: false });
    assert.equal(without.grounding?.sentences[0].reasons[0].found, undefined);
    assert.ok(!JSON.stringify(without).includes('training'));
    const withText = await buildReceipt(draft);
    assert.match(withText.grounding?.sentences[0].reasons[0].found ?? '', /training/);
  });

  it('accepts every receipt the source check can produce: many reasons, long statements, long titles', async () => {
    const title = `Budget ${'x'.repeat(490)}`;
    const label = `[Doc: ${title}, Chunk: 1]`;
    const values = Array.from({ length: 22 }, (_, i) => `${11 + i}000 EUR`).join(', ');
    const long = `The plan lists ${'many words about the project '.repeat(220)}and ends here`;
    const answer = `The quarterly costs were ${values} ${label}.\n\n${long} ${label}.`;
    const sources = [{ label, doc: title, heading: '', text: 'The approved budget is 480,000 EUR.', delivered: /** @type {const} */ ('full') }];
    const grounding = groundAnswer(blocksFromMarkdown(answer, sources), sources);
    assert.ok(grounding.sentences[0].reasons.length > 20);
    assert.ok(grounding.sentences[1].text.length > 5000);
    const r = await buildReceipt({
      createdAt: '2026-09-24T01:00:00.000Z',
      version: '1.1.0',
      answer: { text: answer, engine: 'cloud', locale: 'en' },
      question: 'Costs?',
      grounding,
      citations: [{ label, doc: title, heading: '', source: 'knowledge', delivered: 'full', text: sources[0].text, truncated: false, documentId: 'kb-3' }],
    });
    assert.equal(r.grounding?.sentences[0].verdict, 'unsupported');
    const parsed = validateReceipt(JSON.parse(JSON.stringify(r)));
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.deepEqual((await verifyReceipt(r, [], tools)).grounding?.differences, []);
  });

  it('keeps passages verifiable when the chunking rules change', async () => {
    const r = structuredClone(await receiptFor(MD, 'plan.md', 'The budget is 480,000 EUR {label}.'));
    const doc = /** @type {NonNullable<typeof r.citations[0]['document']>} */ (r.citations[0].document);
    doc.chunker = { ...doc.chunker, version: 0, size: 10, overlap: 2 };
    const report = await verifyReceipt(r, [{ name: 'plan.md', bytes: MD }], tools);
    assert.equal(report.citations[0].passage, 'match');
    assert.equal(report.citations[0].chunk, 'version_differs');
  });
});

describe('scripts/verify-receipt.mjs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'starpi-receipt-'));
  const run = (/** @type {string[]} */ args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

  it('exits 0 when every passage is reproduced, 1 on a mismatch and 2 on invalid input', async () => {
    const r = await receiptFor(PDF, 'kickoff.pdf', 'The beta starts on 1 February 2027 {label}.');
    const receiptPath = path.join(dir, 'receipt.json');
    const pdfPath = path.join(dir, 'kickoff.pdf');
    writeFileSync(receiptPath, JSON.stringify(r));
    writeFileSync(pdfPath, PDF);

    const ok = run([receiptPath, pdfPath, '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    const json = JSON.parse(ok.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.summary.reproduced, 1);

    const missing = run([receiptPath]);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /0\/1 workspace excerpts reproduced/);

    writeFileSync(path.join(dir, 'bad.json'), '{"schema":"other"}');
    assert.equal(run([path.join(dir, 'bad.json')]).status, 2);
    assert.equal(run([]).status, 2);
    assert.ok(readFileSync(receiptPath, 'utf8').includes(RECEIPT_SCHEMA));
  });
});

describe('docs/spec/receipt.schema.json', () => {
  const schema = JSON.parse(readFileSync(path.join(ROOT, 'docs/spec/receipt.schema.json'), 'utf8'));

  /**
   * Validates against the subset of JSON Schema the receipt schema uses. Returns error paths.
   * @param {any} value
   * @param {any} s
   * @param {string} [at]
   * @returns {string[]}
   */
  function check(value, s, at = '$') {
    if (s.$ref) return check(value, schema.$defs[s.$ref.replace('#/$defs/', '')], at);
    if (s.anyOf) return s.anyOf.some((/** @type {any} */ alt) => check(value, alt, at).length === 0) ? [] : [`${at}: no alternative matches`];
    if ('const' in s) return value === s.const ? [] : [`${at}: not ${s.const}`];
    if (s.enum) return s.enum.includes(value) ? [] : [`${at}: ${JSON.stringify(value)} not in enum`];
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
    if (s.type && s.type !== type) return [`${at}: ${type}, expected ${s.type}`];
    /** @type {string[]} */
    const errors = [];
    if (type === 'string') {
      if (s.maxLength !== undefined && value.length > s.maxLength) errors.push(`${at}: too long`);
      if (s.pattern && !new RegExp(s.pattern).test(value)) errors.push(`${at}: pattern`);
    }
    if (type === 'integer' && s.minimum !== undefined && value < s.minimum) errors.push(`${at}: below minimum`);
    if (type === 'array') {
      if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${at}: too many items`);
      if (s.items) value.forEach((/** @type {any} */ v, /** @type {number} */ i) => errors.push(...check(v, s.items, `${at}[${i}]`)));
    }
    if (type === 'object') {
      for (const key of s.required ?? []) if (!(key in value)) errors.push(`${at}.${key}: missing`);
      for (const [key, v] of Object.entries(value)) {
        if (s.properties?.[key]) errors.push(...check(v, s.properties[key], `${at}.${key}`));
        else if (s.additionalProperties === false) errors.push(`${at}.${key}: not in the schema`);
        else if (typeof s.additionalProperties === 'object') errors.push(...check(v, s.additionalProperties, `${at}.${key}`));
      }
    }
    return errors;
  }

  it('describes every receipt the app builds, with and without the optional texts', async () => {
    const full = await receiptFor(PDF, 'kickoff.pdf', 'The beta starts on 1 February 2027 {label}. The group meets every Friday {label}.');
    assert.ok(full.grounding?.sentences.some((s) => s.reasons.length), 'the fixture should record at least one reason');
    assert.deepEqual(check(full, schema), []);
    assert.deepEqual(check(JSON.parse(JSON.stringify(full)), schema), []);
    const md = await receiptFor(MD, 'plan.md', 'The approved budget is 480,000 EUR {label}.');
    assert.deepEqual(check(md, schema), []);
  });

  it('rejects what validateReceipt rejects, and a field the format does not have', async () => {
    const r = JSON.parse(JSON.stringify(await receiptFor(MD, 'plan.md', 'The approved budget is 480,000 EUR {label}.')));
    assert.notDeepEqual(check({ ...r, schema: 'starpi.receipt/v2' }, schema), []);
    assert.notDeepEqual(check({ ...r, id: 'abc' }, schema), []);
    assert.notDeepEqual(check({ ...r, extra: 1 }, schema), []);
    r.citations[0].delivered = 'some';
    assert.notDeepEqual(check(r, schema), []);
  });

  it('lists the reason codes and verdicts of the source check', () => {
    const source = readFileSync(path.join(ROOT, 'src/js/core/grounding.js'), 'utf8');
    const typedef = /@typedef \{([^}]+)\} ReasonCode/.exec(source)?.[1] ?? '';
    const codes = [...typedef.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual([...schema.$defs.reason.properties.code.enum].sort(), codes);
    assert.deepEqual(schema.$defs.sentence.properties.verdict.enum, ['supported', 'weak', 'unsupported', 'unchecked']);
    assert.equal(schema.properties.schema.const, RECEIPT_SCHEMA);
  });
});
