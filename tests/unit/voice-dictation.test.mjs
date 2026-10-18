// Dictation and the chat seam: the microphone button starts the browser's recognition and falls
// back to recording for the next sources when the browser's service is out of reach; a refused
// microphone ends it with a message; without any source it says how to set one up. The seam lets
// the chat register its composer, answers and Live helpers, and builds the speaker button.
import './setup.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDictation } from '../../src/js/voice/dictation.js';
import { composerInput, readAloudStream, registerVoiceUi, speakerButton, voiceUi } from '../../src/js/voice/hooks.js';
import { DEFAULT_VOICE_SETTINGS } from '../../src/js/voice/settings.js';
import { encodeWav } from '../../src/js/voice/wav.js';

/**
 * @param {{ recognize?: any, sources?: Record<string, any>, onDevice?: boolean, duration?: number }} [over]
 */
function setup(over = {}) {
  const input = { value: 'Draft', dispatchEvent: () => true };
  /** @type {Array<[string, string | null]>} */
  const shown = [];
  /** @type {any[]} */
  const notices = [];
  const capture = {
    started: 0,
    async start() {
      capture.started += 1;
    },
    async stopWav() {
      return encodeWav(new Int16Array(8000), 16_000);
    },
    cancel() {},
    onEvent: () => () => {},
    durationMs: () => over.duration ?? 600,
  };
  const transcribed = /** @type {string[]} */ ([]);
  const dictation = createDictation({
    ctx: /** @type {any} */ ({ settings: () => DEFAULT_VOICE_SETTINGS, onDevice: () => over.onDevice === true, getKey: () => '', site: () => null, companion: () => null, playback: () => null }),
    sources: over.sources ?? {
      browser: { id: 'browser', local: false, available: () => true },
      gemini: { id: 'gemini', local: false, available: () => true, transcribe: async () => (transcribed.push('gemini'), 'from the recording') },
    },
    capture: () => /** @type {any} */ (capture),
    recognize: over.recognize ?? (() => ({ result: Promise.resolve({ ok: true, text: 'spoken words' }), stop() {}, abort() {} })),
    input: () => /** @type {any} */ (input),
    locale: () => 'en-US',
    show: (state, source) => shown.push([state, source]),
    notify: (label) => notices.push(label),
  });
  return { dictation, input, shown, notices, capture, transcribed };
}

describe('dictation', () => {
  it('writes what the browser recognized after the text already in the box', async () => {
    const { dictation, input, shown } = setup();
    await dictation.toggle();
    assert.equal(input.value, 'Draft spoken words');
    assert.deepEqual(shown, [['listening', 'browser'], ['idle', null]]);
  });

  it('records for the next source when the browser service is out of reach', async () => {
    const { dictation, input, notices, capture, shown, transcribed } = setup({ recognize: () => ({ result: Promise.resolve({ ok: false, error: { code: 'network' } }), stop() {}, abort() {} }) });
    await dictation.toggle();
    assert.deepEqual(notices, [{ key: 'voice.dictation.fallback', params: { code: 'network' } }]);
    assert.equal(capture.started, 1);
    assert.equal(dictation.state(), 'recording');
    await dictation.toggle();
    assert.equal(input.value, 'Draft from the recording');
    assert.deepEqual(transcribed, ['gemini']);
    assert.deepEqual(shown.map((s) => s[0]), ['listening', 'recording', 'transcribing', 'idle']);
    assert.equal(shown[1][1], 'gemini');
  });

  it('ends with the recognition message when the microphone is refused', async () => {
    const { dictation, notices, capture } = setup({ recognize: () => ({ result: Promise.resolve({ ok: false, error: { code: 'not-allowed' } }), stop() {}, abort() {} }) });
    await dictation.toggle();
    assert.deepEqual(notices, ['chat.voice_error_denied']);
    assert.equal(capture.started, 0);
    assert.equal(dictation.state(), 'idle');
  });

  it('records from the start when the first source takes recordings, and skips taps', async () => {
    const { dictation, notices, capture } = setup({ sources: { gemini: { id: 'gemini', local: false, available: () => true, transcribe: async () => 'x' } }, duration: 100 });
    await dictation.toggle();
    assert.equal(capture.started, 1);
    await dictation.toggle();
    assert.deepEqual(notices, ['voice.dictation.too_short']);
  });

  it('says how to set up speech input when no source can run', async () => {
    const none = setup({ sources: { browser: { id: 'browser', local: false, available: () => false } } });
    await none.dictation.toggle();
    assert.deepEqual(none.notices, ['voice.dictation.no_source']);
    const local = setup({ onDevice: true, sources: { gemini: { id: 'gemini', local: false, available: () => true, transcribe: async () => 'x' } } });
    await local.dictation.toggle();
    assert.deepEqual(local.notices, ['chat.voice_off_local']);
  });
});

describe('voice seam for the chat', () => {
  it('registers and removes hooks, and builds an escaped speaker button', () => {
    const remove = registerVoiceUi({ getAnswer: () => null });
    assert.equal(typeof voiceUi().getAnswer, 'function');
    remove();
    assert.equal(voiceUi().getAnswer, undefined);
    const html = speakerButton('a"1').value;
    assert.match(html, /data-action="voice-read-aloud"/);
    assert.match(html, /data-arg="a&quot;1"/);
    assert.match(html, /aria-label="Read aloud"/);
    assert.equal(composerInput(), null, 'no document in Node');
  });

  it('reads streaming answers aloud only when the user switched it on', () => {
    assert.equal(readAloudStream({ label: 'free' }), null);
  });
});
