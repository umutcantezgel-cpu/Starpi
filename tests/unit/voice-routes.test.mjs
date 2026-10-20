// The speech routes (api/voice/*) against the local fakes: speech output with the site's Gemini
// and ElevenLabs keys as WAV, speech input from a checked recording, the offer, and ephemeral Live
// tokens from the site's key or the user's key in a header (never a key in a URL). Plus the guards
// every route shares (origin, rate limit, access code), the daily counts and budgets, key failover,
// `available(env)` for GET /api/health, and that nothing of a request reaches the logs.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { healthReport } from '../../api/health.js';
import { createVoiceBudget, readVoiceLimits, VOICE_LIMIT_DEFAULTS } from '../../api/_lib/gemini/budget.js';
import { createKeyRing } from '../../api/_lib/gemini/client.js';
import { buildLiveSetup, LIVE_INSTRUCTIONS } from '../../api/_lib/gemini/live-setup.js';
import { checkRecording } from '../../api/_lib/gemini/stt.js';
import { buildVoiceDeps, geminiVoiceKeys, requestLocale, VOICE_LOCALES } from '../../api/_lib/voice-routes.js';
import * as liveToken from '../../api/voice/live-token.js';
import * as speak from '../../api/voice/speak.js';
import * as transcribe from '../../api/voice/transcribe.js';
import * as voices from '../../api/voice/voices.js';
import { createElevenLabsFake } from '../../scripts/fakes/elevenlabs.mjs';
import { createGeminiFake, FAKE_TRANSCRIPTS } from '../../scripts/fakes/gemini.mjs';
import { SHIPPED_LOCALES } from '../../src/locales/index.js';
import { isLiveSocketUrl } from '../../src/js/voice/catalog.js';
import { transcriptionInstruction } from '../../src/js/voice/gemini-wire.js';
import { bytesToBase64, decodeWav, encodeWav } from '../../src/js/voice/wav.js';
import { errorOf, jsonRequest, siteRequest, testKey } from './relay-helpers.mjs';

/** @type {{ gemini: ReturnType<typeof createGeminiFake>, eleven: ReturnType<typeof createElevenLabsFake> }} */
const fakes = { gemini: createGeminiFake({ gapMs: 0 }), eleven: createElevenLabsFake({ gapMs: 0 }) };
const urls = { gemini: '', eleven: '' };
const KEYS = [testKey('plain', 1), testKey('plain', 2)];
/** The ElevenLabs keys of the site (built at run time, so no key-shaped literal exists). */
const ELEVEN_KEYS = `sk_${'e'.repeat(40)}`;

before(async () => {
  urls.gemini = (await fakes.gemini.listen()).url;
  urls.eleven = (await fakes.eleven.listen()).url;
});
after(async () => {
  await fakes.gemini.close();
  await fakes.eleven.close();
});

/**
 * Dependencies for a site with these variables (fakes as API roots by default).
 * @param {Record<string, string | undefined>} [extra]
 * @param {{ now?: () => number, fetch?: typeof fetch }} [io]
 */
function deps(extra = {}, io = {}) {
  const env = { GEMINI_API_KEYS: KEYS.join(','), ELEVENLABS_API_KEYS: ELEVEN_KEYS, STARPI_GEMINI_BASE_URL: urls.gemini, STARPI_ELEVENLABS_BASE_URL: urls.eleven, ...extra };
  return buildVoiceDeps(env, { fetch: io.fetch ?? ((input, init) => fetch(input, init)), now: io.now ?? (() => Date.now()) });
}

/** A short spoken recording: 0.5 s of a quiet tone at 16 kHz, as base64 WAV. */
function recording(seconds = 0.5) {
  const pcm = Int16Array.from({ length: Math.round(16_000 * seconds) }, (_, i) => Math.round(2000 * Math.sin(i / 8)));
  return bytesToBase64(encodeWav(pcm, 16_000));
}

describe('POST /api/voice/speak', () => {
  it('speaks a piece with a Gemini voice and the site key, as a WAV', async () => {
    const res = await speak.handleSpeak(jsonRequest('/api/voice/speak', { text: 'The review is in May.', source: 'gemini', voice: 'Kore', locale: 'en' }), deps());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'audio/wav');
    const wav = decodeWav(new Uint8Array(await res.arrayBuffer()));
    assert.equal(wav?.rate, 24_000);
    assert.ok((wav?.samples.length ?? 0) > 1000);
    const sent = fakes.gemini.requests.at(-1);
    assert.match(sent?.path ?? '', /:generateContent$/);
    assert.equal(sent?.query.key, undefined, 'no key in the URL');
    assert.deepEqual(sent?.body.generationConfig.responseModalities, ['AUDIO']);
  });

  it('speaks with ElevenLabs premade voices only', async () => {
    const ok = await speak.handleSpeak(jsonRequest('/api/voice/speak', { text: 'Hello there.', source: 'elevenlabs', voice: '21m00Tcm4TlvDq8ikWAM' }), deps());
    assert.equal(ok.status, 200);
    assert.equal(decodeWav(new Uint8Array(await ok.arrayBuffer()))?.rate, 24_000);
    const tts = fakes.eleven.requests.filter((r) => r.path.startsWith('/v1/text-to-speech/')).at(-1);
    assert.equal(tts?.query.output_format, 'pcm_24000');
    // On the app's list, but this account does not call it premade (the fake lists four voices).
    const notPremade = await speak.handleSpeak(jsonRequest('/api/voice/speak', { text: 'Hello.', source: 'elevenlabs', voice: 'JBFqnCBsd6RMkjVDRZzb' }), deps());
    assert.equal((await errorOf(notPremade)).error, 'unknown_voice');
    const unlisted = await speak.handleSpeak(jsonRequest('/api/voice/speak', { text: 'Hello.', source: 'elevenlabs', voice: 'abcdefghij0123456789' }), deps());
    assert.equal((await errorOf(unlisted)).error, 'unknown_voice');
  });

  it('refuses bad bodies before any call and needs a configured source', async () => {
    const d = deps();
    const before = fakes.gemini.requests.length;
    const cases = [
      [{ text: '', source: 'gemini', voice: 'Kore' }, 'invalid_text'],
      [{ text: 'x'.repeat(601), source: 'gemini', voice: 'Kore' }, 'invalid_text'],
      [{ text: 'Hi.', source: 'cloud', voice: 'Kore' }, 'invalid_source'],
      [{ text: 'Hi.', source: 'gemini', voice: 'Nobody' }, 'unknown_voice'],
      [{ text: 'Hi.', source: 'gemini', voice: 'Kore', clone: true }, 'unknown_field'],
    ];
    for (const [body, error] of cases) assert.equal((await errorOf(await speak.handleSpeak(jsonRequest('/x', body), d))).error, error);
    assert.equal(fakes.gemini.requests.length, before);
    const none = deps({ GEMINI_API_KEYS: '', ELEVENLABS_API_KEYS: '' });
    assert.deepEqual(await errorOf(await speak.handleSpeak(jsonRequest('/x', { text: 'Hi.', source: 'gemini', voice: 'Kore' }), none)), { status: 503, error: 'voice_not_configured' });
  });

  it('keeps the daily character budget and the per-IP daily count', async () => {
    const tight = deps({ STARPI_VOICE_DAILY_TTS_CHARS: '10' });
    assert.equal((await speak.handleSpeak(jsonRequest('/x', { text: 'Short one.', source: 'gemini', voice: 'Kore' }), tight)).status, 200);
    const over = await speak.handleSpeak(jsonRequest('/x', { text: 'More text.', source: 'gemini', voice: 'Kore' }), tight);
    assert.equal(over.status, 429);
    assert.equal((await errorOf(over)).error, 'budget_exhausted');
    assert.ok(Number(over.headers.get('retry-after')) > 0);
    const perIp = deps({ STARPI_VOICE_DAILY_PER_IP: '1' });
    assert.equal((await speak.handleSpeak(jsonRequest('/x', { text: 'One.', source: 'gemini', voice: 'Kore' }), perIp)).status, 200);
    assert.equal((await errorOf(await speak.handleSpeak(jsonRequest('/x', { text: 'Two.', source: 'gemini', voice: 'Kore' }), perIp))).error, 'daily_limit_reached');
    assert.equal((await speak.handleSpeak(jsonRequest('/x', { text: 'Two.', source: 'gemini', voice: 'Kore' }, { ip: '198.51.100.9' }), perIp)).status, 200);
  });

  it('fails over to the next site key when one is rate limited', async () => {
    const d = deps();
    let calls = 0;
    const limited = deps({}, { fetch: async (input, init) => (++calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '30' } }) : fetch(input, init)) });
    assert.equal((await speak.handleSpeak(jsonRequest('/x', { text: 'Hello.', source: 'gemini', voice: 'Puck' }), limited)).status, 200);
    assert.equal(calls, 2);
    assert.equal(d.gemini?.ring.size, 2);
  });
});

describe('POST /api/voice/transcribe', () => {
  it('transcribes a checked recording with the user glossary and returns only the text', async () => {
    const res = await transcribe.handleTranscribe(jsonRequest('/x', { audio: recording(), locale: 'de', glossary: ['Nordlicht', 'Projekt Alpha'] }), deps());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: FAKE_TRANSCRIPTS.de });
    const sent = fakes.gemini.requests.at(-1)?.body;
    assert.equal(sent.contents[0].parts[0].inlineData.mimeType, 'audio/wav');
    const instruction = sent.systemInstruction.parts[0].text;
    assert.match(instruction, /German/);
    assert.match(instruction, /Nordlicht, Projekt Alpha/);
  });

  it('refuses unreadable, too short and too long recordings and bad glossaries', async () => {
    const d = deps();
    assert.equal((await errorOf(await transcribe.handleTranscribe(jsonRequest('/x', { audio: 'not audio', locale: 'en' }), d))).error, 'invalid_audio');
    assert.equal((await errorOf(await transcribe.handleTranscribe(jsonRequest('/x', { audio: recording(0.1), locale: 'en' }), d))).error, 'audio_too_short');
    assert.equal((await errorOf(await transcribe.handleTranscribe(jsonRequest('/x', { audio: recording(), glossary: 'one,two' }), d))).error, 'invalid_glossary');
    assert.deepEqual(checkRecording(recording(61)), { ok: false, error: 'audio_too_long' });
    assert.equal(checkRecording(recording(2)).ok, true);
  });

  it('counts transcribed seconds against the daily budget', async () => {
    const tight = deps({ STARPI_VOICE_DAILY_STT_SECONDS: '1' });
    assert.equal((await transcribe.handleTranscribe(jsonRequest('/x', { audio: recording(0.6), locale: 'en' }), tight)).status, 200);
    assert.equal((await errorOf(await transcribe.handleTranscribe(jsonRequest('/x', { audio: recording(0.6), locale: 'en' }), tight))).error, 'budget_exhausted');
  });
});

describe('GET /api/voice/voices', () => {
  it('reports the offer as booleans and the app voice lists, nothing about keys', async () => {
    const res = await voices.handleVoices(siteRequest('/api/voice/voices', { method: 'GET', headers: { origin: undefined } }), deps());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.gemini.tts, true);
    assert.ok(body.gemini.voices.includes('Kore'));
    assert.equal(body.elevenlabs.tts, true);
    assert.ok(body.elevenlabs.voices.every((/** @type {any} */ v) => typeof v.id === 'string' && typeof v.label === 'string'));
    assert.doesNotMatch(JSON.stringify(body), new RegExp(KEYS[0].slice(0, 12)));
    const none = await (await voices.handleVoices(siteRequest('/x', { method: 'GET' }), deps({ GEMINI_API_KEYS: '', ELEVENLABS_API_KEYS: '' }))).json();
    assert.deepEqual(none, { gemini: { tts: false, stt: false, live: false, voices: [] }, elevenlabs: { tts: false, voices: [] } });
  });
});

describe('POST /api/voice/live-token', () => {
  it('mints a single-use token with the site key and a locked, neutral setup', async () => {
    const res = await liveToken.handleLiveToken(jsonRequest('/api/voice/live-token', { voice: 'Aoede', locale: 'de' }), deps());
    assert.equal(res.status, 200);
    const token = await res.json();
    assert.match(token.token, /^auth_tokens\//);
    assert.equal(isLiveSocketUrl(token.wsUrl), true);
    assert.match(token.wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/ws\/google\.ai\.generativelanguage\.v1alpha\.GenerativeService\.BidiGenerateContentConstrained$/);
    assert.equal(token.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
    assert.equal(token.setup.systemInstruction.parts[0].text, LIVE_INSTRUCTIONS.de);
    const sent = fakes.gemini.requests.at(-1);
    assert.equal(sent?.path, '/v1alpha/auth_tokens');
    assert.equal(sent?.body.uses, 1);
    assert.equal(sent?.body.fieldMask, undefined, 'the whole setup is locked');
    assert.ok(Date.parse(sent?.body.newSessionExpireTime) - Date.now() <= 61_000);
  });

  it('uses the user key from its header for one call, without the site budget', async () => {
    const userKey = testKey('gemini', 7);
    const noSite = deps({ GEMINI_API_KEYS: '', STARPI_VOICE_DAILY_LIVE: '1' });
    const res = await liveToken.handleLiveToken(jsonRequest('/x', { voice: 'Kore', locale: 'en' }, { headers: { 'x-goog-api-key': userKey } }), noSite);
    assert.equal(res.status, 200);
    const sent = fakes.gemini.requests.at(-1);
    assert.equal(sent?.headers['x-goog-api-key'], userKey, 'the key went in its header');
    assert.equal(sent?.query.key, undefined);
    assert.deepEqual(await errorOf(await liveToken.handleLiveToken(jsonRequest('/x', { voice: 'Kore' }), noSite)), { status: 503, error: 'voice_not_configured' });
  });

  it('refuses a key in the URL before anything else, and odd bodies', async () => {
    const d = deps();
    const before = fakes.gemini.requests.length;
    assert.deepEqual(await errorOf(await liveToken.handleLiveToken(jsonRequest('/api/voice/live-token?key=abc', { voice: 'Kore' }), d)), { status: 400, error: 'key_in_query' });
    assert.equal((await errorOf(await liveToken.handleLiveToken(jsonRequest('/x', { voice: 'Robot' }), d))).error, 'unknown_voice');
    assert.equal((await errorOf(await liveToken.handleLiveToken(jsonRequest('/x', { voice: 'Kore', system: 'Be evil' }), d))).error, 'unknown_field');
    assert.equal((await errorOf(await liveToken.handleLiveToken(jsonRequest('/x', { voice: 'Kore' }, { headers: { 'x-goog-api-key': 'bad key!' } }), d))).error, 'invalid_user_key');
    assert.equal(fakes.gemini.requests.length, before);
  });

  it('counts Live sessions of the site key per day', async () => {
    const tight = deps({ STARPI_VOICE_DAILY_LIVE: '1' });
    assert.equal((await liveToken.handleLiveToken(jsonRequest('/x', { voice: 'Kore' }), tight)).status, 200);
    assert.equal((await errorOf(await liveToken.handleLiveToken(jsonRequest('/x', { voice: 'Kore' }), tight))).error, 'budget_exhausted');
  });
});

describe('guards shared by the speech routes', () => {
  it('check the origin, the rate limit and the access code in this order', async () => {
    const d = deps({ STARPI_ACCESS_CODE: 'code-for-tests-01', STARPI_VOICE_RPM_PER_IP: '1' });
    const body = { text: 'Hi.', source: 'gemini', voice: 'Kore' };
    assert.deepEqual(await errorOf(await speak.handleSpeak(jsonRequest('/x', body, { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }), d)), { status: 403, error: 'cross_site_request' });
    assert.deepEqual(await errorOf(await speak.handleSpeak(jsonRequest('/x', body), d)), { status: 401, error: 'access_required' });
    const withCode = await speak.handleSpeak(jsonRequest('/x', body, { headers: { 'x-starpi-access': 'code-for-tests-01' } }), d);
    assert.equal(withCode.status, 429, 'the second counted request of the minute');
    assert.equal((await errorOf(withCode)).error, 'rate_limited');
    for (const [i, route] of [transcribe.handleTranscribe, liveToken.handleLiveToken].entries()) {
      assert.equal((await errorOf(await route(jsonRequest('/x', {}, { ip: `192.0.2.${40 + i}` }), d))).error, 'access_required');
    }
  });

  it('answer other methods with 405', async () => {
    assert.equal(speak.GET().status, 405);
    assert.equal(transcribe.PUT().status, 405);
    assert.equal(liveToken.DELETE().status, 405);
    assert.equal(voices.POST().status, 405);
  });

  it('report availability to /api/health once the site has keys', () => {
    const env = { GEMINI_API_KEYS: KEYS[0] };
    assert.equal(speak.available(env), true);
    assert.equal(transcribe.available(env), true);
    assert.equal(liveToken.available(env), true);
    assert.equal(speak.available({ ELEVENLABS_API_KEYS: ELEVEN_KEYS }), true);
    assert.equal(transcribe.available({ ELEVENLABS_API_KEYS: ELEVEN_KEYS }), false);
    for (const route of [speak, transcribe, liveToken]) assert.equal(route.available({}), false);
    assert.equal(geminiVoiceKeys({ ...env, STARPI_VOICE_POOL: 'off' }).length, 0);
    assert.equal(geminiVoiceKeys({ ...env, STARPI_POOL_PROVIDERS: 'groq' }).length, 0);
    const report = healthReport(env, {});
    assert.deepEqual(report.voice, { tts: true, stt: true, live: true });
  });

  it('never write a request body, a transcript or a key to the console', async () => {
    /** @type {string[]} */
    const lines = [];
    const saved = { log: console.log, warn: console.warn, error: console.error };
    const record = (/** @type {unknown[]} */ ...args) => void lines.push(args.map(String).join(' '));
    Object.assign(console, { log: record, warn: record, error: record });
    try {
      const d = deps({ ELEVENLABS_API_KEYS: `${ELEVEN_KEYS},bad key` });
      await speak.handleSpeak(jsonRequest('/x', { text: 'A private sentence.', source: 'gemini', voice: 'Kore' }), d);
      await transcribe.handleTranscribe(jsonRequest('/x', { audio: recording(), locale: 'en', glossary: ['Secret term'] }), d);
      await liveToken.handleLiveToken(jsonRequest('/x', { voice: 'Kore' }, { headers: { 'x-goog-api-key': testKey('gemini', 9) } }), d);
    } finally {
      Object.assign(console, saved);
    }
    const all = lines.join('\n');
    for (const secret of ['A private sentence', 'Secret term', FAKE_TRANSCRIPTS.en, KEYS[0], KEYS[1], ELEVEN_KEYS, testKey('gemini', 9)]) assert.ok(!all.includes(secret), `logged: ${secret.slice(0, 20)}`);
  });
});

describe('voice server helpers', () => {
  it('read limits from the environment with defaults', () => {
    assert.deepEqual(readVoiceLimits({}), { ...VOICE_LIMIT_DEFAULTS });
    assert.equal(readVoiceLimits({ STARPI_VOICE_DAILY_PER_IP: '0' }).dailyPerIp, 0);
    assert.equal(readVoiceLimits({ STARPI_VOICE_RPM_PER_IP: 'x' }).rpmPerIp, VOICE_LIMIT_DEFAULTS.rpmPerIp);
  });

  it('roll the daily budget over at midnight UTC', () => {
    const clock = { t: Date.UTC(2026, 4, 1, 23, 59, 0) };
    const budget = createVoiceBudget({ ttsChars: 10, sttSeconds: 5, liveSessions: 1, now: () => clock.t });
    assert.equal(budget.take('tts', 8).ok, true);
    assert.deepEqual(budget.take('tts', 3), { ok: false, retryAfterS: 60 });
    assert.equal(budget.left('tts'), 2);
    clock.t += 61_000;
    assert.equal(budget.take('tts', 10).ok, true);
  });

  it('rotate keys and skip parked ones', () => {
    const clock = { t: 0 };
    const ring = createKeyRing(['a', 'b', 'c'], () => clock.t);
    assert.deepEqual([ring.next()?.key, ring.next()?.key, ring.next()?.key, ring.next()?.key], ['a', 'b', 'c', 'a']);
    ring.park(1, 5000);
    ring.park(2, 9000);
    assert.deepEqual([ring.next()?.key, ring.next()?.key], ['a', 'a']);
    ring.park(0, 2000);
    assert.equal(ring.next(), null);
    assert.equal(ring.retryAfterS(), 2);
    clock.t = 5000;
    assert.equal(ring.next()?.key, 'b', 'both a and b rest no longer; the turn is at b');
  });

  it('build a free Live setup from fixed values only', () => {
    const setup = buildLiveSetup({ model: 'gemini-live-x', voice: 'Kore', locale: 'en' });
    assert.equal(setup.model, 'models/gemini-live-x');
    assert.deepEqual(setup.generationConfig.responseModalities, ['AUDIO']);
    assert.deepEqual(setup.inputAudioTranscription, {});
    assert.throws(() => buildLiveSetup({ model: 'x', voice: 'Clone-of-someone', locale: 'en' }), TypeError);
    assert.throws(() => buildLiveSetup({ model: '../x', voice: 'Kore', locale: 'en' }), TypeError);
  });

  it('keep each interface language for dictation, speech and Live, and English for any other', () => {
    assert.deepEqual([...VOICE_LOCALES], [...SHIPPED_LOCALES]);
    assert.deepEqual(['fr-FR', 'es', 'IT', 'tr-TR', 'de-AT', 'pt-BR', '', 7].map(requestLocale), ['fr', 'es', 'it', 'tr', 'de', 'en', 'en', 'en']);
    assert.match(transcriptionInstruction(requestLocale('fr-FR')), /most likely in French/);
    assert.match(transcriptionInstruction(requestLocale('tr')), /most likely in Turkish/);
    const codes = { en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', tr: 'tr-TR' };
    for (const locale of VOICE_LOCALES) {
      const setup = buildLiveSetup({ model: 'gemini-live-x', voice: 'Puck', locale });
      assert.equal(setup.generationConfig.speechConfig.languageCode, codes[locale], locale);
      assert.equal(setup.systemInstruction.parts[0].text, LIVE_INSTRUCTIONS[locale], locale);
    }
    assert.equal(new Set(Object.values(LIVE_INSTRUCTIONS)).size, VOICE_LOCALES.length, 'an instruction of its own per language');
  });
});
