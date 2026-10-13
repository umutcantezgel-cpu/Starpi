// Version 2 of the source check: negations, names and values bound to the wrong thing, and version
// numbers; version 1 stays available and unchanged.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractFacts, indexSource, lookupFact } from '../../src/js/core/facts.js';
import { blocksFromMarkdown, GROUNDING, GROUNDING_VERSIONS, groundAnswer, REASON_CODES, REASON_CODES_V1 } from '../../src/js/core/grounding.js';
import { canonicalText, clausesOf, polarityDiffers, profileClause } from '../../src/js/core/polarity.js';
import { buildReceipt, validateReceipt, verifyReceipt } from '../../src/js/core/receipt.js';
import { EXTRACTOR, extractText } from '../../src/js/rag/parser.js';

const SPEC_EN = [
  'Power over Ethernet is not supported. Telnet is not supported.',
  '| 22 | SSH | Vendor diagnostics | Disabled |',
  'Port 8443 serves the admin interface, and port 8883 carries telemetry to the FleetView console.',
  '| 8443 | HTTPS | Local admin interface | Enabled |',
  'There is no remote access to the EG-400 admin interface from outside the plant network.',
  'A gateway is not returned to Corvane Systems unless the wipe certificate exists.',
  'Priya Raman, the OT lead, owns this specification; Marcus Hale maintains the network configuration of all three gateways.',
  'GW-17 and GW-22 run firmware 4.2.1, whereas GW-31 still runs firmware 4.1.8.',
  'It is split into 310,000 EUR for development, 95,000 EUR for infrastructure and 75,000 EUR for training and rollout.',
  'Engineers may read and change gateway configurations, but they are not allowed to delete audit logs.',
].join('\n');
const SPEC_DE = [
  'Power over Ethernet wird nicht unterstützt.',
  'USB-Datenträger sind im Werk Süd verboten.',
  'Die Zahl der Sicherheitsvorfälle ist von 5 auf 2 gesunken.',
  'Altgeräte entsorgt die Recyclon GmbH. Ein Gateway geht nicht ohne Löschprotokoll an den Hersteller zurück.',
  'Für Wartungsfenster ist die Nordwall Service GmbH zuständig.',
  'Den Abnahmetest hat die Firmware 3.9.4 am 21. April 2027 im Werk Süd bestanden.',
  'Personalakten fallen nicht unter diese Richtlinie.',
].join('\n');

/** @param {string} text @param {string} label */
const source = (text, label) => ({ label, doc: label.slice(6, label.indexOf(',')), heading: '', text, delivered: /** @type {const} */ ('full') });
const EN = [source(SPEC_EN, '[Doc: spec.md, Chunk: 1]')];
const DE = [source(SPEC_DE, '[Doc: spez.md, Chunk: 1]')];

/**
 * Verdict and reason codes of each checked statement.
 * @param {string} answer
 * @param {ReturnType<typeof source>[]} sources
 * @param {{ version?: number, given?: string[] }} [options]
 */
function check(answer, sources, options = {}) {
  return groundAnswer(blocksFromMarkdown(answer, sources), sources, options)
    .sentences.filter((s) => s.verdict !== 'neutral')
    .map((s) => `${s.verdict}${s.reasons.length ? `:${s.reasons.map((r) => r.code).join('+')}` : ''}`);
}
const en = (/** @type {string} */ statement, /** @type {{ version?: number, given?: string[] }} */ options) => check(`${statement} [Doc: spec.md, Chunk: 1]`, EN, options)[0];
const de = (/** @type {string} */ statement, /** @type {{ version?: number }} */ options) => check(`${statement} [Doc: spez.md, Chunk: 1]`, DE, options)[0];

describe('version 2 of the source check', () => {
  it('is the current version, with version 1 still available', () => {
    assert.deepEqual(GROUNDING, { id: 'starpi-grounding', version: 2 });
    assert.deepEqual([...GROUNDING_VERSIONS], [1, 2]);
    assert.deepEqual([...REASON_CODES], [...REASON_CODES_V1, 'negation_inversion', 'name_context']);
    const answer = 'Power over Ethernet is supported [Doc: spec.md, Chunk: 1].';
    assert.equal(groundAnswer(blocksFromMarkdown(answer, EN), EN).algorithm.version, 2);
    assert.equal(groundAnswer(blocksFromMarkdown(answer, EN), EN, { version: 1 }).algorithm.version, 1);
    assert.throws(() => groundAnswer(blocksFromMarkdown(answer, EN), EN, { version: 3 }), /unknown rules version 3/);
  });
});

describe('negations', () => {
  it('marks a statement that drops, adds or reverses the excerpt\'s negation', () => {
    assert.equal(en('Power over Ethernet is supported.'), 'unsupported:negation_inversion');
    assert.equal(en('Power over Ethernet is supported.', { version: 1 }), 'supported');
    assert.equal(en('Port 22 for SSH vendor diagnostics is enabled.'), 'unsupported:negation_inversion');
    assert.equal(en('Engineers may read but not change gateway configurations.'), 'unsupported:negation_inversion');
    assert.equal(en('It is not true that the EG-400 admin interface cannot be reached from outside the plant network.'), 'weak:negation_inversion');
    assert.equal(de('Power over Ethernet wird unterstützt.'), 'unsupported:negation_inversion');
    assert.equal(de('USB-Datenträger sind im Werk Süd erlaubt.'), 'unsupported:negation_inversion');
    assert.equal(de('Die Zahl der Sicherheitsvorfälle ist von 5 auf 2 gestiegen.'), 'unsupported:negation_inversion');
    assert.equal(de('Personalakten fallen ebenfalls unter diese Richtlinie.'), 'unsupported:negation_inversion');
  });

  it('accepts negations written differently from the excerpt', () => {
    assert.equal(en('Power over Ethernet is unsupported.'), 'supported');
    assert.equal(en('No remote access to the EG-400 admin interface is possible from outside the plant network.'), 'supported');
    assert.equal(en('No gateway goes back to Corvane Systems without a wipe certificate.'), 'supported');
    assert.equal(en('Engineers are not barred from reading and changing gateway configurations.'), 'supported');
    assert.equal(en('Engineers may not delete audit logs.'), 'supported');
    assert.equal(de('Power over Ethernet unterstützt das Gerät nicht.'), 'supported');
    assert.equal(de('USB-Datenträger sind im Werk Süd nicht erlaubt.'), 'supported');
    assert.equal(de('Ohne Löschprotokoll geht kein Gateway an den Hersteller zurück.'), 'supported');
  });

  it('reads negations by their meaning', () => {
    const differs = (/** @type {string} */ a, /** @type {string} */ b) => polarityDiffers(profileClause(clausesOf(canonicalText(a))[0]), profileClause(clausesOf(canonicalText(b))[0]));
    assert.equal(canonicalText('Port 22 is disabled.'), 'port 22 is notx enabled.');
    assert.equal(canonicalText("It isn't allowed."), 'it is notx allowed.');
    assert.equal(differs('replication to other regions is enabled', 'replication to other regions is disabled'), true);
    assert.equal(differs('the job is not paused until a legal hold is active', 'the job is paused only after a legal hold is active'), false, 'not … until');
    assert.equal(differs('reports are due no later than Friday at noon', 'reports are due at the latest on Friday at noon'), false, 'no later than');
    assert.equal(differs('nichts spricht gegen eine Entsorgung ohne Protokoll', 'eine Entsorgung ohne Protokoll ist erlaubt'), false);
    // A condition before the comma does not negate the clause after it.
    assert.deepEqual(clausesOf(canonicalText('Reicht das nicht, ist ein zweiter Server verfügbar.'), true), ['reicht das nicht', 'ist ein zweiter server verfuegbar']);
  });
});

describe('names', () => {
  it('marks a name the excerpt has in another place, also swapped pairs and names from nowhere', () => {
    assert.equal(en('Marcus Hale owns the specification.'), 'weak:name_context');
    assert.equal(en('Marcus Hale owns the specification, while Priya Raman maintains the network configuration of all three gateways.'), 'weak:name_context');
    assert.equal(en('Priya Raman owns the specification.'), 'supported');
    assert.equal(en('Priya Raman, the OT lead, owns this specification.'), 'supported');
    assert.equal(de('Altgeräte entsorgt die Nordwall Service GmbH.'), 'weak:name_context');
    assert.equal(de('Für Wartungsfenster ist die Recyclon GmbH zuständig.'), 'weak:name_context');
    assert.equal(de('Altgeräte entsorgt die Recyclon GmbH.'), 'supported');
    assert.equal(de('Für Wartungsfenster ist die Nordwall Service GmbH zuständig.'), 'supported');
    assert.equal(en('Marcus Hale owns the specification.', { version: 1 }), 'supported');
  });

  it('does not check names the question gave, or a statement that joins two passages', () => {
    assert.equal(en('Marcus Hale owns the specification.', { given: ['Does Marcus Hale own the specification?'] }), 'supported');
    assert.equal(en('Priya Raman owns the specification and Marcus Hale maintains the network configuration.'), 'supported');
  });
});

describe('values next to something else', () => {
  it('marks a value the excerpt has next to other words, also when only one word tells', () => {
    assert.equal(en('Port 8883 serves the local admin interface.'), 'weak:fact_context');
    assert.equal(en('Of that, 75,000 EUR is reserved for infrastructure.'), 'weak:fact_context');
    assert.equal(en('Port 8443 serves the local admin interface.'), 'supported');
    assert.equal(en('Of that, 95,000 EUR is reserved for infrastructure.'), 'supported');
    assert.equal(en('GW-31 still runs firmware 4.1.8.'), 'supported');
  });

  it('reads version numbers as codes, without dates or thousands', () => {
    const facts = (/** @type {string} */ t, /** @type {number} */ version) => extractFacts(t, { version }).map((f) => `${f.kind}:${f.surface}`);
    assert.deepEqual(facts('Die Firmware 3.9.4 am 21. April 2027 bestanden.', 2), ['code:3.9.4', 'date:21. April 2027']);
    assert.deepEqual(facts('Die Firmware 3.9.4 am 21. April 2027 bestanden.', 1), ['number:3.9', 'time:4 am', 'date:21. April 2027']);
    assert.deepEqual(facts('Stand 1.2.2026, Version 10.4.12, 4.480.000 Nutzer', 2), ['date:1.2.2026', 'code:10.4.12', 'number:4.480.000']);
    assert.equal(lookupFact(extractFacts('firmware 4.2.1')[0], indexSource('Firmware 4.2.1 is current.')).found, 'exact');
    assert.equal(lookupFact(extractFacts('firmware 4.2.2')[0], indexSource('Firmware 4.2.1 is current.')).found, null);
    assert.equal(de('Den Abnahmetest hat die Firmware 3.9.4 am 21. April 2027 bestanden.'), 'supported');
    // Version 1 reads "3.9.4 am" as a number and a time in the statement and in the excerpt alike: a
    // changed version is reported, but as a time that is not in the excerpt.
    assert.equal(de('Den Abnahmetest hat die Firmware 3.9.4 am 21. April 2027 bestanden.', { version: 1 }), 'supported');
    const missing = (/** @type {number} */ version) => groundAnswer(blocksFromMarkdown('Den Abnahmetest hat die Firmware 3.9.5 am 21. April 2027 bestanden [Doc: spez.md, Chunk: 1].', DE), DE, { version }).sentences[0].reasons.map((r) => `${r.code}:${r.fact}`);
    assert.deepEqual(missing(2), ['missing_fact:3.9.5']);
    assert.deepEqual(missing(1), ['missing_fact:5 am']);
  });
});

describe('receipts with version 2 verdicts', () => {
  it('recompute each statement alone with the rules version the receipt records', async () => {
    const bytes = new TextEncoder().encode(`# Spec\n\n${SPEC_EN}\n`);
    const { text, pdfjs } = await extractText(new File([bytes], 'spec.md'));
    const answer = 'Power over Ethernet is supported [Doc: spec.md, Chunk: 1]. Marcus Hale owns the specification [Doc: spec.md, Chunk: 1]. Port 8883 serves the local admin interface [Doc: spec.md, Chunk: 1].';
    const sources = [source(text, '[Doc: spec.md, Chunk: 1]')];
    for (const version of [1, 2]) {
      const grounding = groundAnswer(blocksFromMarkdown(answer, sources), sources, { version });
      const receipt = await buildReceipt({
        createdAt: '2026-10-13T12:00:00.000Z',
        version: '2.0.0',
        answer: { text: answer, engine: 'cloud', locale: 'en' },
        question: 'Spec?',
        grounding,
        citations: [{ label: sources[0].label, doc: 'spec.md', heading: '', source: 'knowledge', delivered: 'full', text, truncated: false, documentId: null }],
      });
      const parsed = validateReceipt(JSON.parse(JSON.stringify(receipt)));
      assert.equal(parsed.ok, true, JSON.stringify(parsed));
      if (!parsed.ok) return;
      assert.deepEqual(parsed.receipt.grounding?.sentences.map((s) => s.verdict), version === 2 ? ['unsupported', 'weak', 'weak'] : ['supported', 'supported', 'supported']);
      const report = await verifyReceipt(parsed.receipt, [], { extractor: EXTRACTOR, extract: async () => ({ text: '', pdfjs }) });
      assert.deepEqual(report.grounding, { recomputed: 3, differences: [], needsConversation: false });
      assert.deepEqual(report.warnings, []);
    }
  });

  it('refuses version 2 reason codes in a receipt of format v1', async () => {
    const answer = 'Power over Ethernet is supported [Doc: spec.md, Chunk: 1].';
    const grounding = groundAnswer(blocksFromMarkdown(answer, EN), EN);
    const draft = { createdAt: '2026-10-13T12:00:00.000Z', version: '2.0.0', answer: { text: answer, engine: 'cloud', locale: 'en' }, question: 'q', grounding, citations: [{ label: EN[0].label, doc: 'spec.md', heading: '', source: /** @type {const} */ ('knowledge'), delivered: /** @type {const} */ ('full'), text: SPEC_EN, truncated: false, documentId: null }] };
    const v1 = JSON.parse(JSON.stringify(await buildReceipt(draft, { schema: 'starpi.receipt/v1' })));
    assert.equal(validateReceipt(v1).ok, false);
    assert.equal(validateReceipt(JSON.parse(JSON.stringify(await buildReceipt(draft)))).ok, true);
  });
});
