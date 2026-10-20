#!/usr/bin/env node
// Fake of a local speech server on 127.0.0.1 (the kind a user runs next to the app for offline
// dictation and read-aloud): GET /voices, POST /speak (JSON { text, voice, speed? } -> WAV),
// POST /transcribe (raw audio or multipart form; ?language= or a language field) and GET /health.
// The same server also answers the OpenAI-shaped routes local voice servers commonly offer, which
// the app's local voice source uses: GET /v1/audio/voices, POST /v1/audio/transcriptions
// (multipart: file, language, optional glossary) and POST /v1/audio/speech (JSON { input, voice,
// response_format: 'wav', speed } -> WAV). Every path also answers below /v1/voice (the prefix the
// companion relays them under). Two of its voices are not on the app's Piper allowlist, so a
// client's filter can be seen working.
// No key by default; with --token every route but /health needs `Authorization: Bearer <token>`.
// Faults: see shared.mjs.
//
// Usage: node scripts/fakes/voice.mjs [--port 4615] [--token secret]
import { createFakeServer, isMain, runStandalone, wavSilence } from './shared.mjs';

export const DEFAULT_PORT = 4615;

export const FAKE_VOICES = Object.freeze([
  { id: 'en_US-lessac-medium', name: 'Lessac', language: 'en-US' },
  { id: 'de_DE-thorsten-medium', name: 'Thorsten', language: 'de-DE' },
  { id: 'en_US-ljspeech-medium', name: 'LJSpeech', language: 'en-US' },
  { id: 'de_DE-mls-medium', name: 'MLS', language: 'de-DE' },
]);

export const MAX_SPEAK_CHARS = 2000;
const TRANSCRIPTS = /** @type {Record<string, string>} */ ({ en: 'This is a simulated transcript.', de: 'Dies ist ein simuliertes Transkript.' });

/** @param {number} _status @param {string} code */
const errorBody = (_status, code) => ({ error: code, message: `Simulated ${code} error.` });

/**
 * Creates the fake (not yet listening).
 * @param {{ token?: string, gapMs?: number, latencyMs?: number, cors?: boolean, log?: (line: string) => void }} [options]
 */
export function createVoiceFake(options = {}) {
  const token = options.token ?? null;
  return createFakeServer(
    {
      name: 'voice',
      auth: ({ req, path }) => {
        if (!token || path === '/health' || path === '/v1/voice/health') return 'ok';
        return req.headers.authorization === `Bearer ${token}` ? 'ok' : 'missing';
      },
      errorBody,
      async handle(ctx) {
        const method = ctx.req.method;
        // The companion relays the routes below /v1/voice.
        if (ctx.path.startsWith('/v1/voice/')) ctx.path = ctx.path.slice('/v1/voice'.length);
        if (method === 'GET' && ctx.path === '/v1/audio/voices') return ctx.send(200, { voices: FAKE_VOICES.map((v) => ({ id: v.id, name: v.name, language: v.language })) });
        if (method === 'POST' && ctx.path === '/v1/audio/speech') {
          const text = typeof ctx.json?.input === 'string' ? ctx.json.input.trim() : '';
          if (!text || text.length > MAX_SPEAK_CHARS) return ctx.send(400, { error: 'invalid_text', message: `input must have 1-${MAX_SPEAK_CHARS} characters` });
          const voice = ctx.json.voice ?? FAKE_VOICES[0].id;
          if (!FAKE_VOICES.some((v) => v.id === voice)) return ctx.send(400, { error: 'unknown_voice', message: 'voice is not installed' });
          if ((ctx.json.response_format ?? 'wav') !== 'wav') return ctx.send(400, { error: 'unsupported_format', message: 'only wav is offered' });
          const speed = ctx.json.speed ?? 1;
          return ctx.sendBytes(200, wavSilence(Math.min(20_000, (200 + text.length * 40) / (typeof speed === 'number' && speed > 0 ? speed : 1)), 22_050), 'audio/wav');
        }
        if (method === 'POST' && ctx.path === '/v1/audio/transcriptions') {
          if (!/^multipart\/form-data/i.test(ctx.req.headers['content-type'] ?? '') || ctx.raw.length === 0) return ctx.send(415, { error: 'unsupported_media_type', message: 'send a multipart form with a file' });
          const form = ctx.raw.toString('latin1');
          const language = (/name="language"\r\n\r\n([a-z]{2})/.exec(form)?.[1] ?? 'en').toLowerCase();
          const glossary = /name="glossary"\r\n\r\n([^\r]*)/.exec(form)?.[1] ?? '';
          const text = TRANSCRIPTS[language] ?? TRANSCRIPTS.en;
          return ctx.send(200, { text: glossary ? `${text} ${glossary.split('\n')[0]}` : text, language: Object.hasOwn(TRANSCRIPTS, language) ? language : 'en' });
        }
        if (method === 'GET' && ctx.path === '/health') return ctx.send(200, { status: 'ok', stt: { ready: true }, tts: { ready: true }, simulated: true });
        if (method === 'GET' && ctx.path === '/voices') return ctx.send(200, { voices: FAKE_VOICES });
        if (method === 'POST' && ctx.path === '/speak') {
          const text = typeof ctx.json?.text === 'string' ? ctx.json.text.trim() : '';
          if (!text || text.length > MAX_SPEAK_CHARS) return ctx.send(400, { error: 'invalid_text', message: `text must have 1-${MAX_SPEAK_CHARS} characters` });
          const voice = ctx.json.voice ?? FAKE_VOICES[0].id;
          if (!FAKE_VOICES.some((v) => v.id === voice)) return ctx.send(400, { error: 'unknown_voice', message: 'voice is not installed' });
          const speed = ctx.json.speed ?? 1;
          if (typeof speed !== 'number' || speed < 0.5 || speed > 2) return ctx.send(400, { error: 'invalid_speed', message: 'speed must be 0.5-2' });
          return ctx.sendBytes(200, wavSilence(Math.min(20_000, (200 + text.length * 40) / speed)), 'audio/wav');
        }
        if (method === 'POST' && ctx.path === '/transcribe') {
          const type = ctx.req.headers['content-type'] ?? '';
          if (ctx.raw.length === 0 || !/^(?:audio\/|application\/octet-stream|multipart\/form-data)/i.test(type)) return ctx.send(415, { error: 'unsupported_media_type', message: 'send audio or a multipart form' });
          const field = /name="language"\r\n\r\n([a-z]{2})/.exec(ctx.raw.toString('latin1'))?.[1];
          const language = (ctx.url.searchParams.get('language') ?? field ?? 'en').slice(0, 2).toLowerCase();
          return ctx.send(200, { text: TRANSCRIPTS[language] ?? TRANSCRIPTS.en, language: Object.hasOwn(TRANSCRIPTS, language) ? language : 'en', durationMs: Math.round(ctx.raw.length / 32) });
        }
        return false;
      },
    },
    options,
  );
}

if (isMain(import.meta.url)) {
  await runStandalone('voice', ({ args, ...common }) => createVoiceFake({ ...common, token: args.token ?? process.env.FAKE_VOICE_TOKEN, log: (l) => console.log(l) }), { envPort: 'FAKE_VOICE_PORT', defaultPort: DEFAULT_PORT });
}
