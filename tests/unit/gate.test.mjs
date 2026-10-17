// The sentence gate (src/js/core/gate.js): its streaming API, the brand of released units, labels
// and citations, web grounding that arrives after the text, stop, options and the spoken form.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkText, createSentenceGate, isReleased, WITHHELD_REASONS } from '../../src/js/core/gate.js';

const PLAN = { label: '[Doc: plan.md, Chunk: 1]', text: 'The approved budget is 480,000 EUR. The team has twelve members. The office is open from 9 to 17.' };
const NOTES = { label: '[S2]', text: 'The archive keeps MP3 files for 30 days.' };

describe('createSentenceGate', () => {
  it('releases a sentence only once its end is certain, in order', () => {
    const gate = createSentenceGate({ sources: [PLAN], locale: 'en' });
    assert.deepEqual(gate.push('The budget is 480,000 EUR [Doc: plan.md, Chunk: 1]'), []);
    assert.deepEqual(gate.push('.'), []); // a label may still follow
    const [first] = gate.push(' The team');
    assert.equal(first.text, 'The budget is 480,000 EUR.');
    assert.deepEqual(gate.push(' has twelve members [Doc: plan.md, Chunk: 1].'), []);
    const end = gate.end();
    assert.deepEqual(end.released.map((r) => r.text), ['The team has twelve members.']);
    assert.deepEqual(end.counts, { released: 2, withheld: 0, reasons: {}, spokenFallback: 0 });
    assert.deepEqual(gate.push('More text.'), [], 'nothing after end()');
    assert.deepEqual(gate.end().released, []);
  });

  it('describes a released unit: text, spoken form, cites, numbers and position', () => {
    const { released } = checkText('Intro line\nThe budget is 480,000 EUR and the team has twelve members [Doc: plan.md, Chunk: 1].', { sources: [NOTES, PLAN], locale: 'en' });
    const unit = released[1];
    assert.equal(unit.text, 'The budget is 480,000 EUR and the team has twelve members.');
    assert.equal(unit.spoken, unit.text);
    assert.deepEqual(unit.cites, [1]);
    assert.deepEqual(unit.numbers, [{ raw: '480,000', value: null }, { raw: 'twelve', value: 12 }]);
    assert.equal(unit.kind, 'sentence');
    assert.equal(unit.line, 2);
    assert.equal(unit.start, 11);
    assert.ok(Object.isFrozen(unit) && Object.isFrozen(unit.cites) && Object.isFrozen(unit.numbers));
  });

  it('reports the index a source was given, sorted and without repeats', () => {
    const sources = [{ ...PLAN, index: 7 }, { ...NOTES, index: 3 }];
    const [unit] = checkText('MP3 files stay 30 days [S2] and the budget is 480,000 EUR [Doc: plan.md, Chunk: 1] [S2].', { sources, locale: 'en' }).released;
    assert.deepEqual(unit.cites, [3, 7]);
  });

  it('keeps withheld units with their reason, token and position', () => {
    const { withheld, counts } = checkText('Fine.\nThe budget is 520,000 EUR [Doc: plan.md, Chunk: 1].', { sources: [PLAN], locale: 'en' });
    assert.deepEqual(withheld, [
      { text: 'The budget is 520,000 EUR [Doc: plan.md, Chunk: 1].', reason: 'unsupported_number', token: '520,000', kind: 'sentence', start: 6, end: 57, line: 2 },
    ]);
    assert.deepEqual(counts.reasons, { unsupported_number: 1 });
    assert.ok(Object.isFrozen(withheld[0]));
  });

  it('lists every reason once', () => {
    assert.equal(new Set(WITHHELD_REASONS).size, 9);
    assert.ok(Object.isFrozen(WITHHELD_REASONS));
  });
});

describe('isReleased', () => {
  it('is true only for units the gate released', () => {
    const { released, withheld } = checkText('Hello there. Visit https://example.com today.', { mode: 'free' });
    assert.equal(released.length, 1);
    assert.equal(isReleased(released[0]), true);
    assert.equal(isReleased({ ...released[0] }), false, 'a copy');
    assert.equal(isReleased(JSON.parse(JSON.stringify(released[0]))), false, 'a round trip');
    assert.equal(isReleased(withheld[0]), false);
    for (const value of [null, undefined, 'Hello there.', 42, [], {}]) assert.equal(isReleased(value), false);
  });
});

describe('sentence gate modes', () => {
  it('free mode releases numbers but keeps the link and character rules', () => {
    const r = checkText('It costs 999 EUR. Mehr auf www.example.de. Слово.', { mode: 'free', locale: 'en' });
    assert.deepEqual(r.released.map((x) => x.text), ['It costs 999 EUR.']);
    assert.deepEqual(r.withheld.map((w) => w.reason), ['link', 'chars']);
  });

  it('web mode takes the grounding at end() when it arrives after the text', () => {
    const text = 'The tower is 330 m tall. It is a landmark. It opened in 1889.';
    const gate = createSentenceGate({ mode: 'web', locale: 'en' });
    assert.deepEqual(gate.push(text), [], 'nothing before the grounding is known');
    const start = text.indexOf('The tower');
    const result = gate.end({ grounding: { segments: [{ start, end: start + 24, sources: [0] }], sources: [{ uri: 'https://example.org/tower' }] } });
    assert.deepEqual(result.released.map((r) => r.text), ['The tower is 330 m tall.', 'It is a landmark.']);
    assert.deepEqual(result.withheld.map((w) => [w.reason, w.token]), [['web_ungrounded', '1889']]);
  });

  it('web mode without any grounding withholds every number', () => {
    const r = createSentenceGate({ mode: 'web', locale: 'en' });
    r.push('It has 3 floors. It is tall.');
    const result = r.end();
    assert.deepEqual(result.released.map((x) => x.text), ['It is tall.']);
    assert.deepEqual(result.withheld.map((w) => w.reason), ['web_ungrounded']);
  });

  it('web mode ignores malformed grounding entries', () => {
    const text = 'It has 3 floors.';
    const grounding = /** @type {any} */ ({ segments: [{ start: 0, end: 'x', sources: [0] }, { start: 5, end: 2, sources: [0] }, null], sources: [{ uri: 'https://a.example' }] });
    assert.deepEqual(checkText(text, { mode: 'web', grounding, locale: 'en' }).withheld.map((w) => w.reason), ['web_ungrounded']);
  });

  it('web segments are offsets into the whole stream, also across lines', () => {
    const text = 'Intro.\n- The tower is 330 m tall.';
    const start = text.indexOf('330');
    const grounding = { segments: [{ start, end: start + 3, sources: [0] }], sources: [{ uri: 'http://example.org' }] };
    assert.deepEqual(checkText(text, { mode: 'web', grounding, locale: 'en' }).released.map((x) => x.text), ['Intro.', 'The tower is 330 m tall.']);
  });
});

describe('sentence gate labels', () => {
  it('takes citation labels out of the released text', () => {
    const [unit] = checkText('The team has twelve members [Doc: plan.md, Chunk: 1], see [S2].', { sources: [PLAN, NOTES], locale: 'en' }).released;
    assert.equal(unit.text, 'The team has twelve members, see.');
    assert.deepEqual(unit.cites, [0, 1]);
  });

  it('leaves brackets that are no labels in the text', () => {
    const [unit] = checkText('The plan [draft] is ready.', { sources: [PLAN], locale: 'en' }).released;
    assert.equal(unit.text, 'The plan [draft] is ready.');
    assert.deepEqual(unit.cites, []);
  });

  it('accepts labels of any shape that a source names', () => {
    const source = { label: '[web:3]', kind: /** @type {const} */ ('web'), text: 'The archive keeps files for 30 days.' };
    const r = checkText('Files stay 30 days. [web:3] Next sentence.', { sources: [source], locale: 'en' });
    assert.deepEqual(r.released.map((x) => [x.text, x.cites]), [['Files stay 30 days.', [0]], ['Next sentence.', []]]);
  });

  it('checks labels only in sources mode, but takes them out everywhere', () => {
    const r = checkText('It is fine [Doc: nowhere.md, Chunk: 2].', { mode: 'free' });
    assert.deepEqual(r.released.map((x) => x.text), ['It is fine.']);
  });
});

describe('sentence gate identifiers', () => {
  it('needs an identifier in a cited excerpt or the question in verbatim mode', () => {
    const text = 'The archive keeps FLAC2 files [S2].';
    assert.deepEqual(checkText(text, { sources: [NOTES], locale: 'en' }).withheld.map((w) => [w.reason, w.token]), [['identifier', 'FLAC2']]);
    assert.equal(checkText(text, { sources: [NOTES], locale: 'en', question: 'Are FLAC2 files kept?' }).released.length, 1);
    assert.equal(checkText(text, { sources: [NOTES], locale: 'en', identifiers: 'any' }).released.length, 1);
  });

  it('reads identifiers of the caller as one token', () => {
    const opts = { sources: [{ label: '[S1]', text: 'Ticket REQ 1234 is open.' }], locale: 'en', identifierPatterns: [/\bREQ \d{4}\b/] };
    assert.deepEqual(checkText('Ticket REQ 1234 is open [S1].', opts).released.map((x) => x.numbers), [[]]);
    assert.deepEqual(checkText('Ticket REQ 1235 is open [S1].', opts).withheld.map((w) => [w.reason, w.token]), [['identifier', 'REQ 1235']]);
  });
});

describe('sentence gate spoken form', () => {
  it('speaks abbreviations and units written out', () => {
    const [en] = checkText('The office is open from 9 to 17 h, e.g. on Mondays [Doc: plan.md, Chunk: 1].', { sources: [PLAN], locale: 'en' }).released;
    assert.equal(en.spoken, 'The office is open from 9 to 17 hours, for example on Mondays.');
    const [de] = checkText('Die Schulung dauert ca. 2 Std. [S1]', { sources: [{ label: '[S1]', text: 'Die Schulung dauert 2 Stunden.' }], locale: 'de' }).released;
    assert.equal(de.spoken, 'Die Schulung dauert circa 2 Stunden.');
  });

  it('speaks the canonical text when asked to', () => {
    const [unit] = checkText('It takes 5 min.', { mode: 'free', locale: 'en', spoken: 'canonical' }).released;
    assert.equal(unit.spoken, 'It takes 5 min.');
  });
});

describe('sentence gate stop', () => {
  it('drops open units unjudged and accepts nothing after abort()', () => {
    const gate = createSentenceGate({ sources: [PLAN], locale: 'en' });
    const first = gate.push('The team has twelve members [Doc: plan.md, Chunk: 1]. The budget is 480');
    assert.deepEqual(first.map((r) => r.text), ['The team has twelve members.']);
    const stopped = gate.abort();
    assert.equal(stopped.dropped, 1);
    assert.deepEqual(stopped.released, []);
    assert.deepEqual(stopped.withheld, []);
    assert.equal(stopped.counts.released, 1);
    assert.deepEqual(gate.push(',000 EUR.'), []);
    assert.deepEqual(gate.end().released, []);
  });

  it('drops web units that waited for their grounding', () => {
    const gate = createSentenceGate({ mode: 'web', locale: 'en' });
    gate.push('One. Two. Three');
    assert.equal(gate.abort().dropped, 3);
  });
});

describe('sentence gate options', () => {
  it('rejects malformed options', () => {
    const bad = [
      { mode: 'strict' },
      { identifiers: 'some' },
      { spoken: 'loud' },
      { locale: 5 },
      { question: 5 },
      { sources: 'plan' },
      { sources: [{ label: '', text: 'x' }] },
      { sources: [{ label: '[S1]' }] },
      { sources: [{ label: '[S1]', text: 'x', kind: 'book' }] },
      { sources: [{ label: '[S1]', text: 'x', index: 1.5 }] },
      { identifierPatterns: ['ISO'] },
    ];
    for (const options of bad) assert.throws(() => createSentenceGate(/** @type {any} */ (options)), TypeError, JSON.stringify(options));
  });

  it('works without options as a sources gate without sources', () => {
    const r = checkText('Plain words. It has 3 parts.');
    assert.deepEqual(r.released.map((x) => x.text), ['Plain words.']);
    assert.deepEqual(r.withheld.map((w) => w.reason), ['unsupported_number']);
  });

  it('treats every line as text with blocks: none', () => {
    const r = checkText('# Title\n- item', { mode: 'free', blocks: 'none' });
    assert.deepEqual(r.released.map((x) => [x.kind, x.text]), [['sentence', 'Title'], ['sentence', 'item']]);
  });
});
