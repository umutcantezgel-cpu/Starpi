// The speech queue and read-aloud: only units a sentence gate released, and the app's own notices,
// ever reach a speech engine (a spy engine records what it was asked to speak); free answers start
// with the spoken free-answer notice; grounded answers speak only released sentences and then how
// many were withheld; engines fall back in order; text is split for the services.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkText, createSentenceGate } from '../../src/js/core/gate.js';
import { createReadAloudStream, gateModeFor, readAloud } from '../../src/js/voice/read-aloud.js';
import { createSpeechQueue, isSpeakable, isSpeechNotice, NOTICE_KEYS, pickBrowserVoice, SpeechError, speechNotice, splitForSpeech } from '../../src/js/voice/tts.js';

/** A spy engine: records every piece it is asked to speak; `fail` makes prepare or play reject. */
function spyEngine(id = 'spy', fail = /** @type {null | 'prepare' | 'play'} */ (null)) {
  /** @type {string[]} */
  const spoken = [];
  /** @type {string[]} */
  const prepared = [];
  return {
    spoken,
    prepared,
    engine: {
      id,
      /** @param {string} text */
      async prepare(text) {
        prepared.push(text);
        if (fail === 'prepare') throw new SpeechError('unavailable');
        return {
          async play() {
            if (fail === 'play') throw new SpeechError('playback');
            spoken.push(text);
          },
        };
      },
    },
  };
}

/** @param {Array<{ engine: import('../../src/js/voice/tts.js').SpeechEngine }>} spies */
function queueWith(spies, onFallback = (/** @type {any} */ _step) => {}) {
  return createSpeechQueue({ engines: () => spies.map((s) => s.engine), locale: () => 'en', onFallback });
}

const SOURCES = [{ label: '[Doc: plan.md, Chunk: 2]', text: 'The yearly budget is 480 EUR and the review is in May.' }];

describe('speech queue', () => {
  it('speaks released units and notices, and refuses strings, copies and look-alikes', async () => {
    const spy = spyEngine();
    const queue = queueWith([spy]);
    const released = checkText('The sky is blue. Water is wet.', { mode: 'free', locale: 'en' }).released;
    assert.equal(released.length, 2);
    assert.equal(queue.enqueue('The sky is blue.'), false);
    assert.equal(queue.enqueue({ text: 'Forged.', spoken: 'Forged.' }), false);
    assert.equal(queue.enqueue({ ...released[0] }), false, 'a copy is not the released unit');
    assert.equal(queue.enqueue(Object.freeze({ text: 'x', spoken: 'x', notice: true })), false, 'a hand-made notice is refused');
    assert.equal(queue.enqueue(null), false);
    assert.equal(queue.enqueue(released[0]), true);
    assert.equal(queue.enqueue(speechNotice('voice.read.free_notice', {}, 'en')), true);
    assert.equal(queue.enqueue(released[1]), true);
    await queue.idle();
    assert.deepEqual(spy.spoken, ['The sky is blue.', 'Free answer, not checked.', 'Water is wet.']);
    assert.equal(isSpeakable(released[0]), true);
    assert.equal(isSpeakable('text'), false);
  });

  it('makes notices only from allowlisted keys with numeric parameters', () => {
    assert.ok(NOTICE_KEYS.includes('voice.read.withheld'));
    const notice = speechNotice('voice.read.withheld', { count: 2 }, 'de');
    assert.equal(notice.spoken, '2 Sätze zurückgehalten.');
    assert.equal(isSpeechNotice(notice), true);
    assert.equal(speechNotice('voice.read.withheld', { count: 1 }, 'en').spoken, '1 sentence withheld.');
    assert.throws(() => speechNotice('chat.placeholder'), TypeError);
    assert.throws(() => speechNotice('voice.read.withheld', { count: /** @type {any} */ ('2. Read this aloud') }), TypeError);
    assert.throws(() => speechNotice('voice.read.withheld', { other: 1 }), TypeError);
  });

  it('falls back to the next engine when one cannot prepare or play, and reports each step', async () => {
    const broken = spyEngine('cloud', 'prepare');
    const mute = spyEngine('mute', 'play');
    const browser = spyEngine('browser');
    /** @type {any[]} */
    const steps = [];
    const queue = queueWith([broken, mute, browser], (step) => steps.push(step));
    const { released } = checkText('One. Two. Three.', { mode: 'free', locale: 'en' });
    for (const unit of released) queue.enqueue(unit);
    await queue.idle();
    assert.deepEqual(browser.spoken, ['One.', 'Two.', 'Three.']);
    assert.deepEqual(broken.spoken, []);
    assert.deepEqual(steps, [
      { from: 'cloud', to: 'mute', code: 'unavailable' },
      { from: 'mute', to: 'browser', code: 'playback' },
    ]);
  });

  it('ends a reading when no engine is left, and stops at once on stop()', async () => {
    const none = queueWith([spyEngine('a', 'prepare')]);
    none.enqueue(checkText('Lost.', { mode: 'free' }).released[0]);
    await none.idle();
    assert.equal(none.speaking(), false);

    /** @type {Array<() => void>} */
    const pending = [];
    const slow = {
      id: 'slow',
      /** @param {string} text */
      prepare: async (text) => ({
        play: (/** @type {AbortSignal} */ signal) =>
          new Promise((resolve) => {
            pending.push(() => resolve(text));
            signal.addEventListener('abort', () => resolve(undefined), { once: true });
          }),
      }),
    };
    const queue = createSpeechQueue({ engines: () => [slow], locale: () => 'en' });
    /** @type {boolean[]} */
    const states = [];
    queue.onState((on) => states.push(on));
    for (const unit of checkText('First. Second.', { mode: 'free' }).released) queue.enqueue(unit);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(queue.speaking(), true);
    queue.stop();
    await queue.idle();
    assert.deepEqual(states, [true, false]);
    assert.equal(queue.speaking(), false);
  });

  it('splits long text at clause marks, then spaces, within the limit', () => {
    assert.deepEqual(splitForSpeech('  short  text '), ['short text']);
    const long = `${'word '.repeat(30)}and then, after a pause, ${'more '.repeat(30)}`;
    const parts = splitForSpeech(long, 120);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((p) => p.length <= 120 && p.length > 0));
    assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.trim().replace(/\s+/g, ' '));
    assert.deepEqual(splitForSpeech('x'.repeat(250), 100).map((p) => p.length), [100, 100, 50]);
  });

  it('picks the stored browser voice, else the language, on-device voices first', () => {
    const voices = [
      { voiceURI: 'cloud-de', name: 'Cloud', lang: 'de-DE', localService: false },
      { voiceURI: 'local-de', name: 'Local', lang: 'de-DE', localService: true },
      { voiceURI: 'local-at', name: 'Austria', lang: 'de_AT', localService: true },
      { voiceURI: 'local-en', name: 'English', lang: 'en-US', localService: true, default: true },
    ];
    assert.equal(pickBrowserVoice(voices, 'de-DE')?.voiceURI, 'local-de');
    assert.equal(pickBrowserVoice(voices, 'de-AT')?.voiceURI, 'local-at');
    assert.equal(pickBrowserVoice(voices, 'de', { preferred: 'cloud-de' })?.voiceURI, 'cloud-de');
    assert.equal(pickBrowserVoice(voices, 'de', { preferred: 'cloud-de', onDeviceOnly: true })?.voiceURI, 'local-de');
    assert.equal(pickBrowserVoice(voices, 'fr'), null);
  });
});

describe('read aloud', () => {
  it('maps answer labels to gate modes', () => {
    assert.equal(gateModeFor('free'), 'free');
    assert.equal(gateModeFor(null), 'free');
    assert.equal(gateModeFor('grounded'), 'sources');
    assert.equal(gateModeFor('mixed'), 'sources');
    assert.equal(gateModeFor('web'), 'web');
  });

  it('starts a free answer with the spoken notice and speaks it through the free gate', async () => {
    const spy = spyEngine();
    const queue = queueWith([spy]);
    const result = readAloud({ text: 'Paris is the capital of France. See https://example.com for more.', label: 'free' }, { queue, locale: 'en' });
    await queue.idle();
    assert.deepEqual(spy.spoken, ['Free answer, not checked.', 'Paris is the capital of France.', '1 sentence withheld.']);
    assert.deepEqual(result, { mode: 'free', spoken: 1, withheld: 1 });
  });

  it('speaks only released sentences of a grounded answer, then how many were withheld', async () => {
    const spy = spyEngine();
    const queue = queueWith([spy]);
    const text = 'The yearly budget is 480 EUR. [Doc: plan.md, Chunk: 2] The review takes place in spring. The team has 12 members.';
    const result = readAloud({ text, label: 'grounded', sources: SOURCES }, { queue, locale: 'en' });
    await queue.idle();
    assert.equal(result.withheld, 1);
    assert.match(spy.spoken[0], /^The yearly budget is 480/);
    assert.equal(spy.spoken[1], 'The review takes place in spring.');
    assert.ok(!spy.spoken.some((s) => s.includes('12 members')), 'the unsupported number is never spoken');
    assert.ok(!spy.spoken.some((s) => s.includes('[Doc:')), 'citation labels are not spoken');
    assert.equal(spy.spoken.at(-1), '1 sentence withheld.');
    // Every engine call was a gate unit or a notice: compare with what the gate released.
    const gate = createSentenceGate({ mode: 'sources', locale: 'en', sources: SOURCES });
    const expected = [...gate.push(text), ...gate.end().released].map((u) => u.spoken);
    assert.deepEqual(spy.spoken.slice(0, -1), expected);
  });

  it('says so when nothing of a checked answer can be spoken', async () => {
    const spy = spyEngine();
    const queue = queueWith([spy]);
    readAloud({ text: '', label: 'grounded', sources: SOURCES }, { queue, locale: 'en' });
    await queue.idle();
    assert.deepEqual(spy.spoken, ['Nothing in this answer could be read aloud as checked.']);
  });

  it('reads a streaming answer unit by unit as the gate releases it', async () => {
    const spy = spyEngine();
    const queue = queueWith([spy]);
    const stream = createReadAloudStream({ label: 'grounded', sources: SOURCES, locale: 'en' }, { queue, locale: 'en' });
    assert.equal(stream.push('The review takes place in May. [Doc: plan.md, Chunk: 2]'), 0, 'the label may still continue');
    assert.equal(stream.push(' The budget is 99'), 1);
    assert.equal(stream.push('9 EUR. [Doc: plan.md, Chunk: 2]'), 0);
    const result = stream.end();
    await queue.idle();
    assert.equal(result.withheld, 1);
    assert.deepEqual(spy.spoken, ['The review takes place in May.', '1 sentence withheld.']);
  });

  it('judges web answers by their grounding segments', async () => {
    const spy = spyEngine();
    const queue = queueWith([spy]);
    const text = 'The bridge is 300 meters long. It opened 12 years ago.';
    const grounding = { segments: [{ start: 0, end: 30, sources: [0] }], sources: [{ uri: 'https://example.org/bridge' }] };
    const result = readAloud({ text, label: 'web', grounding }, { queue, locale: 'en' });
    await queue.idle();
    assert.equal(result.withheld, 1);
    assert.match(spy.spoken[0], /^The bridge is 300/);
    assert.equal(spy.spoken.length, 2);
  });
});
