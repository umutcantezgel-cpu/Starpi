// @ts-check
// Module `voice`: relays the app's speech requests to the voice server on this machine, so a
// browser on the hosted app can use local speech recognition and voices through its pairing,
// without opening the voice server to web pages. The routes mirror the voice server's own, below
// /v1/voice, which is where the app's companion speech source looks:
//   GET  /v1/voice/v1/audio/voices            member  the installed voices
//   POST /v1/voice/v1/audio/speech            member  { input, voice?, model?, speed? } -> audio/wav
//   POST /v1/voice/v1/audio/transcriptions    member  multipart/form-data (file, model, language, ...) -> { text }
// At most two requests run at a time; more get 429. Nothing is stored or logged but sizes and
// statuses. Configuration (`modules.voice`): { "url": "http://127.0.0.1:8000", "maxTextChars": 4000 };
// without `url` the routes answer 503 voice_not_configured.
import { isRecord } from '../contracts/check.js';
import { fail } from '../lib/errors.js';
import { bodyOf, intIn, moduleConfig } from '../setup/kit.js';
import { isLoopbackUrl } from '../setup/loopback.js';
import { createVoiceClient } from './voice.js';

export const VOICE_MODULE = 'voice';
export const MAX_PARALLEL = 2;
const AUDIO_LIMIT = 25 * 1024 * 1024;

/**
 * What the setup checks use.
 * @typedef {object} VoiceService
 * @property {() => { configured: boolean, url: string | null }} describe
 * @property {(signal?: AbortSignal) => Promise<{ ok: boolean, voices: number, code: string | null }>} probe
 */

/**
 * @param {{ hub: import('../setup/hub.js').Hub, fetchImpl?: typeof fetch }} deps
 * @returns {import('../contracts/module.js').CompanionModule}
 */
export function createVoiceModule({ hub, fetchImpl }) {
  /** @type {import('./voice.js').VoiceClient | null} */
  let voice = null;
  let settings = { url: /** @type {string | null} */ (null), maxTextChars: 4000 };
  let running = 0;
  /** @type {(() => void) | null} */
  let withdraw = null;

  /**
   * Runs a relay within the parallel limit.
   * @template T
   * @param {(client: import('./voice.js').VoiceClient) => Promise<T>} work
   * @returns {Promise<T>}
   */
  async function relay(work) {
    if (!voice) throw fail('voice_not_configured', 'no voice server is configured (modules.voice.url)', { status: 503 });
    if (running >= MAX_PARALLEL) throw fail('voice_busy', 'the voice server is busy; try again in a moment', { status: 429 });
    running += 1;
    try {
      return await work(voice);
    } finally {
      running -= 1;
    }
  }

  /** @type {VoiceService} */
  const service = {
    describe: () => ({ configured: voice !== null, url: voice?.url ?? null }),
    async probe(signal) {
      if (!voice) return { ok: false, voices: 0, code: 'voice_not_configured' };
      try {
        const list = await voice.voices(signal);
        const voices = Array.isArray(list?.voices) ? list.voices.length : Array.isArray(list?.data) ? list.data.length : Array.isArray(list) ? list.length : 0;
        return { ok: true, voices, code: null };
      } catch (err) {
        return { ok: false, voices: 0, code: /** @type {any} */ (err)?.code ?? 'voice_failed' };
      }
    },
  };

  return {
    id: VOICE_MODULE,
    version: '1.0.0',
    title: 'Voice relay',
    routes: [
      {
        method: 'GET',
        path: '/v1/audio/voices',
        access: 'member',
        async handler(req) {
          const list = await relay((client) => client.voices(req.signal));
          return { body: isRecord(list) ? list : { voices: Array.isArray(list) ? list : [] } };
        },
      },
      {
        method: 'POST',
        path: '/v1/audio/speech',
        access: 'member',
        maxBody: 64 * 1024,
        async handler(req) {
          const body = bodyOf(req);
          const input = body.input;
          if (typeof input !== 'string' || input.trim() === '' || input.length > settings.maxTextChars) throw fail('voice_input', `input is 1 to ${settings.maxTextChars} characters`, { status: 400 });
          if (body.voice !== undefined && (typeof body.voice !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(body.voice))) throw fail('voice_name', 'voice is a voice id', { status: 400 });
          if (body.model !== undefined && (typeof body.model !== 'string' || !/^[A-Za-z0-9_.:/-]{1,100}$/.test(body.model))) throw fail('voice_model', 'model is a model name', { status: 400 });
          if (body.speed !== undefined && !(typeof body.speed === 'number' && body.speed >= 0.5 && body.speed <= 2)) throw fail('voice_speed', 'speed is 0.5 to 2', { status: 400 });
          if (body.response_format !== undefined && body.response_format !== 'wav') throw fail('voice_format', 'the relay answers with WAV audio only', { status: 400 });
          const audio = await relay((client) => client.speech({ input, voice: /** @type {string | undefined} */ (body.voice), model: /** @type {string | undefined} */ (body.model), speed: /** @type {number | undefined} */ (body.speed) }, req.signal));
          return { raw: { type: 'audio/wav', data: audio } };
        },
      },
      {
        method: 'POST',
        path: '/v1/audio/transcriptions',
        access: 'member',
        raw: ['multipart/form-data'],
        maxBody: AUDIO_LIMIT,
        async handler(req) {
          const type = String(req.headers['content-type'] ?? '');
          if (!/;\s*boundary=("?)[0-9A-Za-z'()+_,./:=?-]{1,70}\1\s*$/i.test(type)) throw fail('voice_form', 'a multipart form with a boundary', { status: 400 });
          const bytes = /** @type {Buffer} */ (req.body ?? Buffer.alloc(0));
          if (bytes.length === 0) throw fail('voice_form', 'the form is empty', { status: 400 });
          const result = await relay((client) => client.transcribe(bytes, type, req.signal));
          return { body: { text: typeof result?.text === 'string' ? result.text : '' } };
        },
      },
    ],
    start(ctx) {
      settings = moduleConfig(VOICE_MODULE, ctx.config, { url: (v) => (v === null || isLoopbackUrl(v) ? null : 'http://127.0.0.1:<port> (a voice server on this machine) or null'), maxTextChars: intIn(1, 20_000) }, settings);
      voice = settings.url ? createVoiceClient(settings.url, { fetchImpl }) : null;
      withdraw = hub.provide('voice', service);
    },
    stop() {
      withdraw?.();
      withdraw = null;
      voice = null;
    },
  };
}
