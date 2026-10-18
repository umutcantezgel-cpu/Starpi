// Speech sources against the local fakes, and the fallback between them: the order of the speech
// input chain (the user's pick first, only sources that can run, on-device rules), the hand-over
// from a failing source to the next, Gemini with the user's key and through the site's route,
// OpenAI and Groq transcription, a local voice server and the companion relay (Piper allowlist
// enforced), and the speech output engines of each source.
import './setup.mjs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { buildVoiceDeps } from '../../api/_lib/voice-routes.js';
import { handleSpeak } from '../../api/voice/speak.js';
import { handleTranscribe } from '../../api/voice/transcribe.js';
import { handleVoices } from '../../api/voice/voices.js';
import { createElevenLabsFake } from '../../scripts/fakes/elevenlabs.mjs';
import { createGeminiFake, FAKE_TRANSCRIPTS } from '../../scripts/fakes/gemini.mjs';
import { createOpenAiFake } from '../../scripts/fakes/openai.mjs';
import { createVoiceFake } from '../../scripts/fakes/voice.mjs';
import { DEFAULT_VOICE_SETTINGS, normalizeVoiceSettings, voiceFor } from '../../src/js/voice/settings.js';
import { browserStt } from '../../src/js/voice/sources/browser.js';
import { companionStt, setCompanionVoiceLink } from '../../src/js/voice/sources/companion.js';
import { elevenlabsTts, premadeVoices } from '../../src/js/voice/sources/elevenlabs.js';
import { geminiStt, geminiTts } from '../../src/js/voice/sources/gemini.js';
import { groqStt } from '../../src/js/voice/sources/groq.js';
import { STT, TTS, ttsEngines } from '../../src/js/voice/sources/index.js';
import { installedVoices, localStt, localTts, serverRoot } from '../../src/js/voice/sources/local.js';
import { openaiStt, openaiTts } from '../../src/js/voice/sources/openai.js';
import { SttError } from '../../src/js/voice/sources/shared.js';
import { sttChain, transcribeWithFallback } from '../../src/js/voice/stt.js';
import { encodeWav } from '../../src/js/voice/wav.js';
import { testKey } from './relay-helpers.mjs';

const fakes = {
  gemini: createGeminiFake({ gapMs: 0 }),
  openai: createOpenAiFake({ gapMs: 0 }),
  eleven: createElevenLabsFake({ gapMs: 0 }),
  voice: createVoiceFake({ gapMs: 0 }),
  companion: createVoiceFake({ gapMs: 0, token: 'pairing-token-for-tests' }),
};
/** @type {Record<keyof typeof fakes, string>} */
const urls = /** @type {any} */ ({});

before(async () => {
  for (const [name, fake] of Object.entries(fakes)) urls[/** @type {keyof typeof fakes} */ (name)] = (await fake.listen()).url;
});
after(async () => {
  for (const fake of Object.values(fakes)) await fake.close();
  setCompanionVoiceLink(null);
});

const SITE = 'https://starpi.test';
const WAV = encodeWav(Int16Array.from({ length: 8000 }, (_, i) => Math.round(1500 * Math.sin(i / 6))), 16_000);

/**
 * A fetch that sends the providers' hosts to the fakes and this site's speech routes to their
 * handlers; `fail` answers a host with a status instead.
 * @param {{ fail?: Record<string, number>, siteEnv?: Record<string, string> }} [options]
 * @returns {typeof fetch}
 */
function routedFetch(options = {}) {
  const siteDeps = buildVoiceDeps({ GEMINI_API_KEYS: testKey('plain', 3), ELEVENLABS_API_KEYS: `sk_${'f'.repeat(40)}`, STARPI_GEMINI_BASE_URL: urls.gemini, STARPI_ELEVENLABS_BASE_URL: urls.eleven, ...options.siteEnv }, { fetch: (i, n) => fetch(i, n), now: () => Date.now() });
  const map = /** @type {Array<[string, string]>} */ ([
    ['https://generativelanguage.googleapis.com', urls.gemini],
    ['https://api.groq.com/openai', `${urls.openai}/flavor/groq`],
    ['https://api.openai.com', urls.openai],
    ['https://api.elevenlabs.io', urls.eleven],
  ]);
  return /** @type {typeof fetch} */ (
    async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      for (const [host, status] of Object.entries(options.fail ?? {})) if (url.startsWith(host)) return new Response('{"error":{"message":"simulated"}}', { status, headers: { 'content-type': 'application/json' } });
      if (url.startsWith(`${SITE}/api/voice/`)) {
        const headers = new Headers(init.headers);
        headers.set('origin', SITE);
        headers.set('sec-fetch-site', 'same-origin');
        headers.set('host', 'starpi.test');
        const request = new Request(url, { method: init.method, headers, body: init.body, signal: init.signal ?? undefined, ...(init.body ? { duplex: 'half' } : {}) });
        if (url.endsWith('/transcribe')) return handleTranscribe(request, siteDeps);
        if (url.endsWith('/speak')) return handleSpeak(request, siteDeps);
        if (url.endsWith('/voices')) return handleVoices(request, siteDeps);
        return new Response('', { status: 404 });
      }
      for (const [from, to] of map) if (url.startsWith(from)) return fetch(to + url.slice(from.length), init);
      return fetch(input, init);
    }
  );
}

/** A playback that records what it was asked to play. */
function recordingPlayback() {
  /** @type {Array<{ samples: number, rate: number }>} */
  const played = [];
  return {
    played,
    playback: {
      unlock: async () => true,
      play: async (/** @type {Int16Array} */ pcm, /** @type {number} */ rate) => (played.push({ samples: pcm.length, rate }), true),
      flush() {},
      isPlaying: () => false,
      onStateChange: () => () => {},
      context: () => null,
    },
  };
}

/**
 * @param {{ keys?: Record<string, string>, settings?: Partial<import('../../src/js/voice/settings.js').VoiceSettings>, onDevice?: boolean, site?: any, companion?: any, fetch?: typeof fetch, playback?: any }} [over]
 * @returns {import('../../src/js/voice/sources/shared.js').SourceContext}
 */
function context(over = {}) {
  const settings = normalizeVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, ...over.settings });
  return {
    getKey: (slot) => over.keys?.[slot] ?? '',
    settings: () => settings,
    onDevice: () => over.onDevice === true,
    site: () => over.site ?? null,
    companion: () => over.companion ?? null,
    playback: () => over.playback ?? recordingPlayback().playback,
    fetch: over.fetch ?? routedFetch(),
    origin: SITE,
    access: () => '',
  };
}

const run = { locale: 'en', glossary: /** @type {string[]} */ ([]), signal: new AbortController().signal };

describe('speech input chain', () => {
  it('orders the available sources, the user pick first', () => {
    const ctx = context({ keys: { openai: testKey('openai'), groq: testKey('groq') }, settings: { localUrl: 'http://127.0.0.1:9' } });
    assert.deepEqual(sttChain(STT, ctx).map((s) => s.id), ['openai', 'groq', 'local']);
    const picked = context({ keys: { openai: testKey('openai'), groq: testKey('groq') }, settings: { stt: 'groq' } });
    assert.deepEqual(sttChain(STT, picked).map((s) => s.id), ['groq', 'openai']);
    const site = context({ site: { geminiStt: true, geminiTts: false, live: false, elevenlabsTts: false } });
    assert.deepEqual(sttChain(STT, site).map((s) => s.id), ['gemini']);
  });

  it('keeps audio on the user machines in the on-device mode', () => {
    const ctx = context({ onDevice: true, keys: { openai: testKey('openai'), gemini: testKey('gemini') }, settings: { localUrl: 'http://127.0.0.1:9' }, companion: { origin: 'http://127.0.0.1:7', token: 'x'.repeat(20) } });
    assert.deepEqual(sttChain(STT, ctx).map((s) => s.id), ['local', 'companion']);
    assert.equal(browserStt.available(ctx), false, 'no speech recognition in Node');
  });

  it('hands a recording to the next source when one fails, and reports every attempt', async () => {
    const ctx = context({ keys: { gemini: testKey('gemini'), openai: testKey('openai') }, fetch: routedFetch({ fail: { 'https://generativelanguage.googleapis.com': 401 } }) });
    const result = await transcribeWithFallback(WAV, { chain: sttChain(STT, ctx), ctx, locale: 'en' });
    assert.equal(result.text, 'This is a simulated transcript.');
    assert.equal(result.source, 'openai');
    assert.deepEqual(result.attempts, [
      { source: 'gemini', outcome: 'auth' },
      { source: 'openai', outcome: 'ok' },
    ]);
  });

  it('stops at silence instead of asking every source again, and when every source fails', async () => {
    /** @type {import('../../src/js/voice/sources/shared.js').SttSource[]} */
    const chain = [
      { id: 'gemini', local: false, available: () => true, transcribe: async () => '   ' },
      { id: 'openai', local: false, available: () => true, transcribe: async () => 'never asked' },
    ];
    const silent = await transcribeWithFallback(WAV, { chain, ctx: context(), locale: 'en' });
    assert.deepEqual(silent, { text: '', source: 'gemini', attempts: [{ source: 'gemini', outcome: 'empty' }] });
    const failing = await transcribeWithFallback(WAV, {
      chain: [
        { id: 'gemini', local: false, available: () => true, transcribe: async () => Promise.reject(new SttError('rate_limited')) },
        { id: 'groq', local: false, available: () => true, transcribe: async () => Promise.reject(new SttError('network')) },
      ],
      ctx: context(),
      locale: 'en',
    });
    assert.deepEqual(failing, { text: '', source: null, attempts: [{ source: 'gemini', outcome: 'rate_limited' }, { source: 'groq', outcome: 'network' }] });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(transcribeWithFallback(WAV, { chain, ctx: context(), locale: 'en', signal: controller.signal }), { name: 'AbortError' });
  });
});

describe('speech input sources', () => {
  it('Gemini with the user key calls the API directly, the key in its header', async () => {
    const text = await geminiStt.transcribe?.(WAV, { ...run, locale: 'de', glossary: ['Nordlicht'] }, context({ keys: { gemini: testKey('gemini') } }));
    assert.equal(text, FAKE_TRANSCRIPTS.de);
    const sent = fakes.gemini.requests.at(-1);
    assert.equal(sent?.query.key, undefined);
    assert.match(sent?.body.systemInstruction.parts[0].text, /Nordlicht/);
  });

  it('Gemini without a key goes through the site route when the site offers it', async () => {
    const ctx = context({ site: { geminiStt: true, geminiTts: true, live: true, elevenlabsTts: false } });
    assert.equal(geminiStt.available(ctx), true);
    assert.equal(await geminiStt.transcribe?.(WAV, run, ctx), FAKE_TRANSCRIPTS.en);
    const none = context({ fetch: routedFetch({ siteEnv: { GEMINI_API_KEYS: '' } }), site: { geminiStt: true, geminiTts: false, live: false, elevenlabsTts: false } });
    await assert.rejects(geminiStt.transcribe?.(WAV, run, none) ?? Promise.resolve(), (err) => err instanceof SttError && err.code === 'unavailable');
  });

  it('OpenAI and Groq transcribe the recording as a multipart form', async () => {
    assert.equal(await openaiStt.transcribe?.(WAV, { ...run, glossary: ['Kestrel'] }, context({ keys: { openai: testKey('openai') } })), 'This is a simulated transcript.');
    const sent = fakes.openai.requests.at(-1);
    assert.match(String(sent?.headers['content-type']), /^multipart\/form-data/);
    assert.equal(await groqStt.transcribe?.(WAV, { ...run, locale: 'de' }, context({ keys: { groq: testKey('groq') } })), 'Dies ist ein simuliertes Transkript.');
    assert.match(fakes.openai.requests.at(-1)?.path ?? '', /^\/flavor\/groq\//);
  });

  it('a local voice server gets the recording and the glossary field', async () => {
    const ctx = context({ settings: { localUrl: `${urls.voice}/v1` } });
    assert.equal(await localStt.transcribe?.(WAV, { ...run, glossary: ['Kestrel', 'Nordlicht'] }, ctx), 'This is a simulated transcript. Kestrel');
    assert.equal(fakes.voice.requests.at(-1)?.path, '/v1/audio/transcriptions');
    assert.equal(serverRoot('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000');
  });

  it('the companion relays the same routes with its pairing token, loopback only', async () => {
    assert.equal(setCompanionVoiceLink({ origin: 'https://example.com', token: 'x'.repeat(20) }), false);
    assert.equal(setCompanionVoiceLink({ origin: urls.companion, token: 'pairing-token-for-tests' }), true);
    const ctx = context({ companion: { origin: urls.companion, token: 'pairing-token-for-tests' } });
    assert.equal(await companionStt.transcribe?.(WAV, run, ctx), 'This is a simulated transcript.');
    assert.equal(fakes.companion.requests.at(-1)?.path, '/v1/voice/v1/audio/transcriptions');
    const wrong = context({ companion: { origin: urls.companion, token: 'wrong-token-for-tests' } });
    await assert.rejects(companionStt.transcribe?.(WAV, run, wrong) ?? Promise.resolve(), (err) => err instanceof SttError && err.code === 'auth');
  });
});

describe('speech output sources', () => {
  /**
   * Prepares and plays one piece with a source's engine.
   * @param {import('../../src/js/voice/sources/shared.js').TtsSource} source
   * @param {Parameters<typeof context>[0]} over
   * @param {string | null} voice
   */
  async function speakOnce(source, over, voice = null) {
    const rec = recordingPlayback();
    const ctx = context({ ...over, playback: rec.playback });
    const playable = await source.engine(ctx).prepare('Hello there.', { locale: 'en', voice, rate: 1, signal: new AbortController().signal });
    await playable.play(new AbortController().signal);
    return rec.played;
  }

  it('Gemini, OpenAI and ElevenLabs with the user key play 24 kHz PCM', async () => {
    assert.equal((await speakOnce(geminiTts, { keys: { gemini: testKey('gemini') } }, 'Puck'))[0]?.rate, 24_000);
    assert.equal(fakes.gemini.requests.at(-1)?.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Puck');
    assert.equal((await speakOnce(openaiTts, { keys: { openai: testKey('openai') } }, 'nova'))[0]?.rate, 24_000);
    assert.equal(fakes.openai.requests.at(-1)?.body.response_format, 'pcm');
    assert.equal((await speakOnce(elevenlabsTts, { keys: { elevenlabs: `sk_${'u'.repeat(40)}` } }, 'pNInz6obpgDQGcFmaJgB'))[0]?.rate, 24_000);
    assert.match(fakes.eleven.requests.at(-1)?.path ?? '', /\/v1\/text-to-speech\/pNInz6obpgDQGcFmaJgB$/);
  });

  it('the site route speaks Gemini and ElevenLabs voices without a key of the user', async () => {
    const site = { geminiTts: true, geminiStt: true, live: true, elevenlabsTts: true };
    assert.equal((await speakOnce(geminiTts, { site }, 'Kore'))[0]?.rate, 24_000);
    assert.equal((await speakOnce(elevenlabsTts, { site }, '21m00Tcm4TlvDq8ikWAM'))[0]?.rate, 24_000);
  });

  it('a local server speaks allowlisted Piper voices only', async () => {
    const over = { settings: { localUrl: urls.voice } };
    assert.equal((await speakOnce(localTts, over, 'en_US-ljspeech-medium'))[0]?.rate, 22_050);
    assert.equal(fakes.voice.requests.at(-1)?.body.voice, 'en_US-ljspeech-medium');
    // A voice outside the allowlist is never asked for: the language's allowlisted voice is used.
    await speakOnce(localTts, over, 'en_US-lessac-medium');
    assert.equal(fakes.voice.requests.at(-1)?.body.voice, 'en_US-ljspeech-medium');
    assert.deepEqual((await localTts.voices(context(over), 'de')).map((v) => v.id), ['de_DE-mls-medium']);
    assert.deepEqual(installedVoices({ voices: ['en_US-lessac-medium', { id: 'it_IT-serena-high' }] }), ['it_IT-serena-high']);
  });

  it('lists ElevenLabs voices the account calls premade and the app allows', async () => {
    const voices = await elevenlabsTts.voices(context({ keys: { elevenlabs: `sk_${'u'.repeat(40)}` } }), 'en');
    assert.deepEqual(voices.map((v) => v.id).sort(), ['21m00Tcm4TlvDq8ikWAM', 'EXAVITQu4vr4xnSDxMaL', 'ErXwobaYiN019PkySvjV', 'pNInz6obpgDQGcFmaJgB'].sort());
    assert.deepEqual(premadeVoices({ voices: [{ voice_id: '21m00Tcm4TlvDq8ikWAM', category: 'cloned' }] }), []);
  });

  it('a reading uses the chosen source, then the browser voices, never another cloud', () => {
    const ctx = context({ keys: { openai: testKey('openai'), gemini: testKey('gemini') }, settings: { tts: 'openai' } });
    // Node has no speechSynthesis, so only the chosen engine remains.
    assert.deepEqual(ttsEngines(ctx, TTS).map((e) => e.id), ['openai']);
    const fakeBrowser = { ...TTS.browser, available: () => true };
    assert.deepEqual(ttsEngines(ctx, { ...TTS, browser: fakeBrowser }).map((e) => e.id), ['openai', 'browser']);
    const onDevice = context({ onDevice: true, keys: { openai: testKey('openai') }, settings: { tts: 'openai' } });
    assert.deepEqual(ttsEngines(onDevice, { ...TTS, browser: fakeBrowser }).map((e) => e.id), ['browser']);
  });
});

describe('voice settings', () => {
  it('keep only known sources, listed voices and sane values', () => {
    const s = normalizeVoiceSettings({ stt: 'teleport', tts: 'elevenlabs', rate: 9, voices: { elevenlabs: { en: 'cloned-voice', de: 'pNInz6obpgDQGcFmaJgB' }, gemini: { en: 'Puck' }, robot: { en: 'x' } }, localUrl: 'ftp://x', glossary: 42, extra: true });
    assert.equal(s.stt, 'auto');
    assert.equal(s.tts, 'elevenlabs');
    assert.equal(s.rate, 2);
    assert.deepEqual(s.voices, { elevenlabs: { de: 'pNInz6obpgDQGcFmaJgB' }, gemini: { en: 'Puck' } });
    assert.equal(s.localUrl, '');
    assert.equal(s.glossary, '');
    assert.equal(/** @type {any} */ (s).extra, undefined);
    assert.equal(normalizeVoiceSettings({ localUrl: '127.0.0.1:8000/' }).localUrl, 'http://127.0.0.1:8000');
    assert.equal(voiceFor(s, 'elevenlabs', 'en-GB'), 'EXAVITQu4vr4xnSDxMaL', 'the default premade voice');
    assert.equal(voiceFor(s, 'gemini', 'en'), 'Puck');
    assert.equal(voiceFor(s, 'browser', 'en'), null);
  });
});
