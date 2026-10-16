#!/usr/bin/env node
// Fake of the ElevenLabs API on 127.0.0.1: GET /v1/voices (and /v2/voices) with premade voices,
// GET /v1/models, POST /v1/text-to-speech/<voice_id> (and /stream) returning silent audio in the
// requested output_format, and POST /v1/speech-to-text returning a fixed transcript. The key must
// come in the xi-api-key header. Faults: see shared.mjs.
//
// Usage: node scripts/fakes/elevenlabs.mjs [--port 4614]
// Base URL for clients: http://127.0.0.1:<port>
import { createFakeServer, isMain, mp3Silence, pcmSilence, runStandalone } from './shared.mjs';

export const DEFAULT_PORT = 4614;

/** A few voices of the public premade list. */
export const PREMADE_VOICES = Object.freeze([
  { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', labels: { accent: 'american', gender: 'female', age: 'young', description: 'calm', use_case: 'narration' } },
  { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam', labels: { accent: 'american', gender: 'male', age: 'middle aged', description: 'deep', use_case: 'narration' } },
  { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella', labels: { accent: 'american', gender: 'female', age: 'young', description: 'soft', use_case: 'narration' } },
  { voice_id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', labels: { accent: 'american', gender: 'male', age: 'young', description: 'well-rounded', use_case: 'narration' } },
]);

export const FAKE_TTS_MODELS = Object.freeze(['eleven_multilingual_v2', 'eleven_flash_v2_5']);

/** @param {number} status @param {string} code */
const errorBody = (status, code) => ({ detail: { status: status === 429 ? 'too_many_concurrent_requests' : status === 401 ? 'invalid_api_key' : code, message: `Simulated ${code} error.` } });

/**
 * Creates the fake (not yet listening).
 * @param {{ gapMs?: number, latencyMs?: number, cors?: boolean, log?: (line: string) => void }} [options]
 */
export function createElevenLabsFake(options = {}) {
  let counter = 0;
  return createFakeServer(
    {
      name: 'elevenlabs',
      auth: ({ req, url }) => {
        if (url.searchParams.has('xi-api-key') || url.searchParams.has('key')) return 'in_query';
        const key = req.headers['xi-api-key'];
        return typeof key === 'string' && key.length > 0 ? 'ok' : 'missing';
      },
      errorBody: (status, kind) => errorBody(status, kind),
      async handle(ctx) {
        const method = ctx.req.method;
        if (method === 'GET' && (ctx.path === '/v1/voices' || ctx.path === '/v2/voices')) {
          const voices = PREMADE_VOICES.map((v) => ({ ...v, category: 'premade', description: null, preview_url: null, available_for_tiers: [], high_quality_base_model_ids: [...FAKE_TTS_MODELS] }));
          return ctx.send(200, ctx.path === '/v2/voices' ? { voices, has_more: false, total_count: voices.length, next_page_token: null } : { voices });
        }
        if (method === 'GET' && ctx.path === '/v1/models') {
          return ctx.send(200, FAKE_TTS_MODELS.map((model_id) => ({ model_id, name: model_id, can_do_text_to_speech: true, can_do_voice_conversion: false, languages: [{ language_id: 'en', name: 'English' }, { language_id: 'de', name: 'German' }] })));
        }
        const tts = /^\/v1\/text-to-speech\/([A-Za-z0-9]+)(\/stream)?$/.exec(ctx.path);
        if (method === 'POST' && tts) {
          if (!PREMADE_VOICES.some((v) => v.voice_id === tts[1])) return ctx.send(404, { detail: { status: 'voice_not_found', message: 'A voice with this id was not found.' } });
          const text = typeof ctx.json?.text === 'string' ? ctx.json.text.trim() : '';
          if (!text) return ctx.send(400, { detail: { status: 'invalid_text', message: 'Text is required.' } });
          counter += 1;
          const ms = Math.min(10_000, 200 + text.length * 40);
          const format = ctx.url.searchParams.get('output_format') ?? 'mp3_44100_128';
          const headers = { 'request-id': `req_${counter}fake` };
          const pcm = /^pcm_(\d+)$/.exec(format);
          if (pcm) return ctx.sendBytes(200, pcmSilence(ms, Number(pcm[1])), 'audio/pcm', headers);
          if (format.startsWith('ulaw_')) return ctx.sendBytes(200, Buffer.alloc(Math.round(8 * ms), 0xff), 'audio/basic', headers);
          if (!format.startsWith('mp3_')) return ctx.send(400, { detail: { status: 'invalid_output_format', message: 'Unsupported output format.' } });
          return ctx.sendBytes(200, mp3Silence(ms), 'audio/mpeg', headers);
        }
        if (method === 'POST' && ctx.path === '/v1/speech-to-text') {
          if (!/^multipart\/form-data/i.test(ctx.req.headers['content-type'] ?? '') || ctx.raw.length === 0) return ctx.send(422, { detail: { status: 'invalid_request', message: 'A file is required.' } });
          const german = /name="language_code"\r\n\r\nde/.test(ctx.raw.toString('latin1'));
          const text = german ? 'Dies ist ein simuliertes Transkript.' : 'This is a simulated transcript.';
          return ctx.send(200, { language_code: german ? 'de' : 'en', language_probability: 0.99, text, words: [] });
        }
        return false;
      },
    },
    options,
  );
}

if (isMain(import.meta.url)) {
  await runStandalone('elevenlabs', (common) => createElevenLabsFake({ ...common, log: (l) => console.log(l) }), { envPort: 'FAKE_ELEVENLABS_PORT', defaultPort: DEFAULT_PORT });
}
