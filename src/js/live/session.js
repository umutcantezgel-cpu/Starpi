// @ts-check
// One Gemini Live conversation over a WebSocket. The browser never holds a key here: the site's
// live-token route returns a single-use ephemeral token, the socket endpoint and the setup it
// locked into the token. This module
//   - opens a socket only to an endpoint isLiveSocketUrl() accepts (Google's Live endpoint, or a
//     loopback fake in tests), with the token as ?access_token= and nothing else in the query;
//   - sends { setup } exactly as the route returned it, then microphone audio (16 kHz PCM16 as
//     base64), camera pictures (JPEG), typed text and the end of an audio stream; input sent before
//     setupComplete waits in a bounded queue (the oldest audio goes first when it overflows);
//   - turns server messages (JSON in text or binary frames) into events: audio (24 kHz PCM16),
//     text, input and output transcripts, interrupted, turnComplete, goAway;
//   - reports a close with 1007 or 1008 (the service refused the setup or the token) as `fallback`,
//     so the conversation can go on as push-to-talk turns.
// Nothing is stored: audio, pictures and transcripts only pass through.
import { isLiveSocketUrl } from '../voice/catalog.js';
import { base64ToPcm16, pcm16ToBase64, pcmRate } from '../voice/wav.js';

/**
 * @typedef {import('../voice/client.js').LiveToken} LiveToken
 *
 * @typedef {{ type: 'ready' }
 *   | { type: 'audio', samples: Int16Array, rate: number }
 *   | { type: 'text', text: string }
 *   | { type: 'input_transcript', text: string }
 *   | { type: 'output_transcript', text: string }
 *   | { type: 'interrupted' }
 *   | { type: 'turn_complete' }
 *   | { type: 'go_away', timeLeft: string | null }
 *   | { type: 'refused', code: 'endpoint' | 'token' }
 *   | { type: 'fallback', code: number, reason: string }
 *   | { type: 'closed', code: number, reason: string, by: 'client' | 'server' }
 *   | { type: 'error', code: 'setup_timeout' | 'socket' }} LiveEvent
 *
 * @typedef {'idle' | 'connecting' | 'ready' | 'closed'} LiveSessionState
 *
 * @typedef {object} SocketLike
 * @property {string} binaryType
 * @property {number} readyState
 * @property {(data: string) => void} send
 * @property {(code?: number, reason?: string) => void} close
 * @property {(type: string, fn: (event: any) => void) => void} addEventListener
 *
 * @typedef {new (url: string) => SocketLike} SocketCtor
 *
 * @typedef {object} LiveSession
 * @property {() => boolean} connect           false: refused (a foreign endpoint or a malformed token)
 * @property {(pcm: Int16Array) => void} sendAudio
 * @property {(jpegBase64: string) => void} sendImage
 * @property {(text: string) => void} sendText
 * @property {() => void} endAudio             the microphone paused (end of the user's turn)
 * @property {() => void} close
 * @property {() => LiveSessionState} state
 * @property {(fn: (event: LiveEvent) => void) => () => void} onEvent
 */

/** Close codes with which the service refuses a setup or a token. */
export const FALLBACK_CLOSE_CODES = Object.freeze([1007, 1008]);
/** Messages waiting for setupComplete (about 8 s of 20 ms audio frames). */
export const QUEUE_LIMIT = 400;
const TOKEN = /^[A-Za-z0-9._~+/=-]{8,2048}$/;
const OPEN = 1;

/**
 * The events of one server message (a parsed JSON object).
 * @param {unknown} message
 * @returns {LiveEvent[]}
 */
export function liveEventsOf(message) {
  if (!message || typeof message !== 'object') return [];
  const m = /** @type {Record<string, any>} */ (message);
  /** @type {LiveEvent[]} */
  const out = [];
  if (m.setupComplete) out.push({ type: 'ready' });
  const content = m.serverContent;
  if (content && typeof content === 'object') {
    if (typeof content.inputTranscription?.text === 'string' && content.inputTranscription.text) out.push({ type: 'input_transcript', text: content.inputTranscription.text });
    for (const part of Array.isArray(content.modelTurn?.parts) ? content.modelTurn.parts : []) {
      const data = part?.inlineData;
      if (data && typeof data.data === 'string') {
        const rate = pcmRate(data.mimeType);
        if (rate) {
          const samples = base64ToPcm16(data.data);
          if (samples.length) out.push({ type: 'audio', samples, rate });
        }
      } else if (typeof part?.text === 'string' && part.text && !part.thought) out.push({ type: 'text', text: part.text });
    }
    if (typeof content.outputTranscription?.text === 'string' && content.outputTranscription.text) out.push({ type: 'output_transcript', text: content.outputTranscription.text });
    if (content.interrupted) out.push({ type: 'interrupted' });
    if (content.turnComplete) out.push({ type: 'turn_complete' });
  }
  if (m.goAway) out.push({ type: 'go_away', timeLeft: typeof m.goAway.timeLeft === 'string' ? m.goAway.timeLeft : null });
  return out;
}

/**
 * The URL of a token's socket.
 * @param {LiveToken} token
 * @returns {string | null} null when the endpoint or the token is not acceptable
 */
export function socketUrl(token) {
  if (!isLiveSocketUrl(token?.wsUrl) || typeof token.token !== 'string' || !TOKEN.test(token.token)) return null;
  const url = new URL(token.wsUrl);
  url.search = '';
  url.searchParams.set('access_token', token.token);
  return isLiveSocketUrl(url.href) ? url.href : null;
}

/**
 * @param {{ token: LiveToken, WebSocket?: SocketCtor | null, setupTimeoutMs?: number }} deps
 * @returns {LiveSession}
 */
export function createLiveSession(deps) {
  const Ctor = deps.WebSocket === undefined ? /** @type {SocketCtor | undefined} */ (/** @type {any} */ (globalThis).WebSocket) : deps.WebSocket;
  /** @type {LiveSessionState} */
  let state = 'idle';
  /** @type {SocketLike | null} */
  let socket = null;
  /** @type {string[]} */
  let queue = [];
  let closedByClient = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let setupTimer = null;
  /** @type {Set<(event: LiveEvent) => void>} */
  const listeners = new Set();

  /** @param {LiveEvent} event */
  const emit = (event) => {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error('[starpi] live listener failed', err);
      }
    }
  };

  /**
   * Sends a client message now, or queues it until setupComplete (audio may be dropped from a full
   * queue, other messages are kept).
   * @param {Record<string, unknown>} message
   */
  const send = (message) => {
    if (state === 'closed' || state === 'idle') return;
    const text = JSON.stringify(message);
    if (state === 'ready' && socket?.readyState === OPEN) {
      socket.send(text);
      return;
    }
    queue.push(text);
    if (queue.length > QUEUE_LIMIT) {
      const oldestAudio = queue.findIndex((q) => q.startsWith('{"realtimeInput":{"audio"'));
      queue.splice(oldestAudio >= 0 ? oldestAudio : 0, 1);
    }
  };

  /** @param {unknown} data */
  const onMessage = (data) => {
    let text;
    if (typeof data === 'string') text = data;
    else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
    else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(/** @type {ArrayBufferView} */ (data));
    else return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    for (const event of liveEventsOf(message)) {
      if (event.type === 'ready') {
        if (setupTimer) clearTimeout(setupTimer);
        setupTimer = null;
        state = 'ready';
        for (const queued of queue.splice(0)) socket?.send(queued);
      }
      emit(event);
    }
  };

  const finish = (/** @type {number} */ code, /** @type {string} */ reason) => {
    if (state === 'closed') return;
    const wasClient = closedByClient;
    state = 'closed';
    queue = [];
    if (setupTimer) clearTimeout(setupTimer);
    setupTimer = null;
    if (!wasClient && FALLBACK_CLOSE_CODES.includes(code)) emit({ type: 'fallback', code, reason });
    emit({ type: 'closed', code, reason, by: wasClient ? 'client' : 'server' });
  };

  return {
    connect() {
      if (state !== 'idle') return state !== 'closed';
      const url = socketUrl(deps.token);
      if (!url || !Ctor) {
        emit({ type: 'refused', code: url ? 'endpoint' : 'token' });
        state = 'closed';
        return false;
      }
      state = 'connecting';
      socket = new Ctor(url);
      socket.binaryType = 'arraybuffer';
      socket.addEventListener('open', () => socket?.send(JSON.stringify({ setup: deps.token.setup })));
      socket.addEventListener('message', (event) => onMessage(event.data));
      socket.addEventListener('error', () => {
        if (state !== 'closed') emit({ type: 'error', code: 'socket' });
      });
      socket.addEventListener('close', (event) => finish(Number(event.code) || 1006, String(event.reason ?? '')));
      setupTimer = setTimeout(() => {
        if (state === 'connecting') {
          emit({ type: 'error', code: 'setup_timeout' });
          closedByClient = true;
          socket?.close(4000, 'setup timeout');
          finish(4000, 'setup timeout');
        }
      }, deps.setupTimeoutMs ?? 15_000);
      return true;
    },
    sendAudio(pcm) {
      if (pcm.length) send({ realtimeInput: { audio: { data: pcm16ToBase64(pcm), mimeType: 'audio/pcm;rate=16000' } } });
    },
    sendImage(jpegBase64) {
      if (jpegBase64) send({ realtimeInput: { video: { data: jpegBase64, mimeType: 'image/jpeg' } } });
    },
    sendText(text) {
      const clean = String(text ?? '').trim();
      if (clean) send({ realtimeInput: { text: clean } });
    },
    endAudio() {
      send({ realtimeInput: { audioStreamEnd: true } });
    },
    close() {
      if (state === 'closed') return;
      closedByClient = true;
      try {
        socket?.close(1000, 'done');
      } catch {
        // already closing
      }
      finish(1000, 'done');
    },
    state: () => state,
    onEvent(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
