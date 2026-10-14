// Version 2 of the source check: negations, names and values bound to the wrong thing, and version
// numbers; version 1 stays available and unchanged.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractFacts, indexSource, lookupFact } from '../../src/js/core/facts.js';
import { blocksFromMarkdown, GROUNDING, GROUNDING_VERSIONS, groundAnswer, REASON_CODES, REASON_CODES_V1 } from '../../src/js/core/grounding.js';
import { canonicalText, clausesOf, polarityDiffers, profileClause } from '../../src/js/core/polarity.js';
import { unitsOf } from '../../src/js/core/binding.js';
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

/**
 * Verdict of one statement against one excerpt.
 * @param {string} statement
 * @param {string} excerpt
 * @param {number} [version]
 */
const pair = (statement, excerpt, version = 2) => {
  const sources = [source(excerpt, '[Doc: a.md, Chunk: 1]')];
  return check(`${statement} [Doc: a.md, Chunk: 1]`, sources, { version })[0];
};

describe('negations', () => {
  it('marks a statement that drops, adds or reverses the excerpt\'s negation, as weak', () => {
    assert.equal(en('Power over Ethernet is supported.'), 'weak:negation_inversion');
    assert.equal(en('Power over Ethernet is supported.', { version: 1 }), 'supported');
    assert.equal(en('Port 22 for SSH vendor diagnostics is enabled.'), 'weak:negation_inversion');
    assert.equal(en('Engineers may read but not change gateway configurations.'), 'weak:negation_inversion');
    assert.equal(en('It is not true that the EG-400 admin interface cannot be reached from outside the plant network.'), 'weak:negation_inversion');
    assert.equal(de('Power over Ethernet wird unterstützt.'), 'weak:negation_inversion');
    assert.equal(de('USB-Datenträger sind im Werk Süd erlaubt.'), 'weak:negation_inversion');
    assert.equal(de('Die Zahl der Sicherheitsvorfälle ist von 5 auf 2 gestiegen.'), 'weak:negation_inversion');
    assert.equal(de('Personalakten fallen ebenfalls unter diese Richtlinie.'), 'weak:negation_inversion');
    assert.equal(pair('Firmware 4.1.8 is still supported by Corvane Systems.', 'Firmware 4.1.8 is no longer supported by Corvane Systems.'), 'weak:negation_inversion');
  });

  it('reads negative words, "no longer", "neither … nor" and hyphenated negators as negations', () => {
    for (const [statement, excerpt] of [
      ['The staging server is unreachable from the internet.', 'The staging server is not reachable from the internet.'],
      ['The backup tape library is not active.', 'The backup tape library is inactive.'],
      ['Restoring a backup is not possible without the recovery key.', 'Restoring a backup is impossible without the recovery key.'],
      ['Der Staging-Server ist aus dem Internet unerreichbar.', 'Der Staging-Server ist aus dem Internet nicht erreichbar.'],
      ['Auf unverwalteten Laptops ist der VPN-Client deaktiviert.', 'Der VPN-Client ist auf nicht verwalteten Laptops deaktiviert.'],
      ['GW-31 is no longer supported by Corvane Systems.', 'GW-31 is not supported by Corvane Systems anymore.'],
      ['Das Gateway GW-31 wird von Corvane nicht mehr unterstützt.', 'Das Gateway GW-31 wird von Corvane nicht unterstützt.'],
      ['Telnet and FTP are not supported.', 'Neither Telnet nor FTP is supported.'],
      ['The "Do not disturb" button mutes alarms on the gateway.', 'The do-not-disturb button mutes gateway alarms.'],
    ]) assert.equal(pair(statement, excerpt), 'supported', statement);
  });

  it('does not read a time condition, a range, a restriction or a question as a reversal', () => {
    for (const [statement, excerpt] of [
      ['Vendor access to GW-31 is not allowed until its firmware has been updated.', 'Vendor access to GW-31 is prohibited until its firmware has been updated.'],
      ['Vendor access to GW-31 is only allowed after its firmware has been updated.', 'Vendor access to GW-31 is prohibited until its firmware has been updated.'],
      ['No spare unit is connected to the plant network until Marcus Hale has installed firmware 4.2.1 on it.', 'A spare unit is not connected to the plant network until Marcus Hale has installed firmware 4.2.1 on it.'],
      ['Bevor der Wareneingang bestätigt ist, werden Rechnungen der Halvorsen Spedition nicht bezahlt.', 'Rechnungen der Halvorsen Spedition werden nicht bezahlt, bevor der Wareneingang bestätigt ist.'],
      ['The gateways are not reachable from Monday until Friday.', 'The gateways are not reachable from Monday to Friday.'],
      ['Updates dürfen nicht nach 18 Uhr eingespielt werden.', 'Nach 18 Uhr dürfen keine Updates eingespielt werden.'],
      ['Ein Gateway geht nur an den Hersteller zurück, wenn ein Löschprotokoll vorliegt.', 'Ein Gateway geht nicht an den Hersteller zurück, sofern kein Löschprotokoll vorliegt.'],
      ['The gateway rejects connections with invalid certificates.', 'The gateway accepts only connections with valid certificates.'],
      ['Is Telnet supported on the gateway?', 'Telnet is not supported on the gateway.'],
      ['The audit log holds nothing but error entries.', 'The audit log holds only error entries.'],
    ]) assert.equal(pair(statement, excerpt), 'supported', statement);
  });

  it('compares only clauses with the same numbers', () => {
    assert.equal(pair('Rafael Ortiz reported that 128 of 140 regression tests passed and 12 failed.', 'Rafael Ortiz reported that 12 of 140 regression tests failed and 128 passed.'), 'supported');
    assert.equal(pair('In the March test run, 3 of 50 test cases failed.', 'In the March test run, 47 of 50 test cases passed and 3 failed.'), 'supported');
  });

  it('never marks a statement unsupported for its negation', () => {
    const reasons = groundAnswer(blocksFromMarkdown('Power over Ethernet is supported [Doc: spec.md, Chunk: 1].', EN), EN).sentences[0].reasons;
    assert.deepEqual(reasons.map((r) => [r.code, r.level]), [['negation_inversion', 'weak']]);
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

  it('accepts titles, the German genitive and hyphenated names', () => {
    for (const [statement, excerpt] of [
      ['Frau Albers verantwortet die Richtlinie.', 'Katrin Albers verantwortet die Richtlinie.'],
      ['Mr Hale installs updates manually on Sundays.', 'Marcus Hale installs updates manually on Sundays.'],
      ['Die Richtlinie legt fest, wie lange Daten des Werks Süd aufbewahrt werden.', 'Die Richtlinie legt fest, wie lange Daten aus dem Werk Süd aufbewahrt werden.'],
      ['Guest Wi-Fi is not monitored.', 'Guest Wi-Fi is not monitored.'],
      ['Single Sign-On via SAML is only available in the Enterprise plan.', 'Single Sign-On via SAML is only available in the Enterprise plan.'],
    ]) assert.equal(pair(statement, excerpt), 'supported', statement);
  });

  it('gives the same result whatever else the answer says and whatever other excerpts it was given', () => {
    const cited = source('Die Wartung der Gateways übernimmt Nordwall. Die Entsorgung übernimmt Recyclon.', '[Doc: a.md, Chunk: 1]');
    const other = source('Vertragspartner sind die Recyclon GmbH und die Nordwall Service GmbH.', '[Doc: b.md, Chunk: 1]');
    const statement = 'Die Wartung der Gateways übernimmt Recyclon [Doc: a.md, Chunk: 1].';
    const alone = check(statement, [cited]);
    assert.deepEqual(check(statement, [cited, other]), alone);
    assert.deepEqual(check(`The partner Recyclon handles gateway disposal [Doc: a.md, Chunk: 1]. ${statement}`, [cited, other]).slice(1), alone);
    // Units are read in their excerpt's language, not in the statement's.
    assert.deepEqual([...unitsOf('Port 22 is enabled at Ridgeway.', null)[0].names], []);
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
    assert.equal(pair('Port 4840 dient der lokalen Weboberfläche.', 'Port 9443 dient der Weboberfläche, Port 4840 der Maschinenanbindung.'), 'weak:fact_context');
  });

  it('reads a list part without its own subject with the subject of the first part', () => {
    const list = 'A suspected breach must be reported internally within 24 hours and to the supervisory authority within 72 hours.';
    assert.equal(pair('A suspected breach must be reported to the supervisory authority within 72 hours.', list), 'supported');
    assert.equal(pair('The Pro plan costs 29 EUR per user and month.', 'The Basic plan costs 9 EUR, the Pro plan 29 EUR and the Enterprise plan 99 EUR per user and month.'), 'supported');
    assert.equal(pair('Firmware 4.1.8 does not fix the memory leak.', 'Firmware 4.2.1 fixes the memory leak, while firmware 4.1.8 does not.'), 'supported');
    // A value the statement names itself is not a rival of its other value.
    assert.equal(pair('The freezer in Room 114 must not stay open longer than 30 seconds.', 'The freezer in Room 114 is kept at -80 °C. It must not stay open longer than 30 seconds.'), 'supported');
    // A part after a semicolon has a subject of its own.
    assert.equal(pair('Birgit Sommer hat die Richtlinie am 1. Juli 2027 freigegeben.', 'Birgit Sommer hat die Richtlinie am 9. Juni 2027 freigegeben; sie tritt am 1. Juli 2027 in Kraft.'), 'weak:fact_context');
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

  it('reads a version that looks like a date the same way on both sides', () => {
    for (const [statement, excerpt] of [
      ['The current firmware on GW-31 is 4.2.10.', 'Firmware 4.2.10 is current on GW-31.'],
      ['GW-31 was updated to 4.2.10 in June.', 'In June, GW-31 was updated to firmware 4.2.10.'],
      ['Release 12.3.45 fixes the flash partition bug.', 'The flash partition bug is fixed in 12.3.45.'],
    ]) assert.equal(pair(statement, excerpt), 'supported', statement);
    assert.equal(pair('The current firmware on GW-31 is 4.2.11.', 'Firmware 4.2.10 is current on GW-31.'), 'unsupported:missing_fact');
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
      assert.deepEqual(parsed.receipt.grounding?.sentences.map((s) => s.verdict), version === 2 ? ['weak', 'weak', 'weak'] : ['supported', 'supported', 'supported']);
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
