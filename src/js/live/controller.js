// @ts-check
// A Live conversation from start to end, in one of two modes:
//   - free: an open conversation. With Gemini Live (the user's Gemini key, or the site's offer) the
//     microphone streams to a Live session (session.js) that answers with native audio; both sides
//     are transcribed and the transcript is labelled "Free · not checked". Without Gemini Live, and
//     when the service refuses the session, the conversation runs as push-to-talk turns: speech to
//     text, the chat's model, the free gate, speech output.
//   - sources: every turn retrieves excerpts for what was said, the model answers from them, its text
//     goes through the source gate (core/gate.js) and the speech queue speaks only the released
//     sentences, then how many were withheld. Native audio cannot be gated, so this mode always runs
//     as turns.
// A session ends after LIMITS.liveSessionMin minutes, after LIMITS.liveSilenceMin minutes without
// speech on either side, when the tab is hidden, or on stop(). Free sessions start with the spoken
// notice that answers are not checked. Nothing of the conversation is stored.
import { createSentenceGate } from '../core/gate.js';
import { LIMITS } from '../voice/catalog.js';
import { speechNotice } from '../voice/tts.js';
import { createLiveSession } from './session.js';
import { createTranscript } from './transcript.js';

/** @typedef {import('../voice/client.js').LiveToken} LiveToken */
/** @typedef {import('../voice/capture.js').Capture} Capture */
/** @typedef {import('../voice/playback.js').Playback} Playback */
/** @typedef {import('../voice/tts.js').SpeechQueue} SpeechQueue */
/** @typedef {import('../voice/stt.js').TranscribeResult} TranscribeResult */
/** @typedef {import('../voice/hooks.js').LiveAsk} LiveAsk */
/** @typedef {import('../voice/hooks.js').LiveRetrieve} LiveRetrieve */
/** @typedef {import('./session.js').LiveEvent} LiveEvent */
/** @typedef {import('./session.js').SocketCtor} SocketCtor */

/** @typedef {'free' | 'sources'} LiveMode */
/** @typedef {'live' | 'turns'} LiveEngine */
/**
 * idle: not started; connecting: asking for a token, opening the socket; ready: waiting for the user
 * (turns: press to talk); listening: the microphone is open; thinking: a turn is being answered;
 * speaking: the answer is being spoken; ended: over (see `reason`).
 * @typedef {'idle' | 'connecting' | 'ready' | 'listening' | 'thinking' | 'speaking' | 'ended'} LiveState
 */
/** @typedef {'stopped' | 'limit' | 'silence' | 'hidden' | 'error' | 'no_source' | 'no_model' | 'microphone'} EndReason */

/**
 * @typedef {object} LiveDeps
 * @property {(input: { voice: string, locale: string, camera: boolean }) => Promise<LiveToken>} liveToken
 * @property {() => boolean} canUseLive          Gemini Live can be tried (a key of the user, or the site's offer)
 * @property {SocketCtor | null} [WebSocket]
 * @property {() => Capture} capture
 * @property {Playback} playback
 * @property {SpeechQueue} queue
 * @property {(wav: Uint8Array, signal: AbortSignal) => Promise<TranscribeResult>} transcribe
 * @property {LiveAsk} ask
 * @property {LiveRetrieve} retrieve
 * @property {() => Promise<{ mime: 'image/jpeg', data: string }>} [camera]
 * @property {() => string} locale
 * @property {() => string} voice               the Live voice
 * @property {() => number} [now]
 * @property {Document | null} [doc]
 * @property {number} [tickMs]                   how often the limits are checked
 * @property {number} [silenceLevel]             RMS above which the microphone counts as speech
 */

/**
 * @typedef {object} LiveController
 * @property {(mode: LiveMode) => Promise<void>} start
 * @property {(reason?: EndReason) => void} stop
 * @property {() => Promise<void>} talk          turns: press to talk, press again to send
 * @property {(text: string) => Promise<void>} say  a typed turn
 * @property {() => Promise<boolean>} snapshot   sends one camera picture with the next turn (or now, in Live)
 * @property {() => LiveState} state
 * @property {() => LiveMode} mode
 * @property {() => LiveEngine | null} engine
 * @property {() => EndReason | null} reason
 * @property {import('./transcript.js').Transcript} transcript
 * @property {(fn: (state: LiveState) => void) => () => void} onState
 */

export const LIVE_LIMITS = Object.freeze({ sessionMs: LIMITS.liveSessionMin * 60_000, silenceMs: LIMITS.liveSilenceMin * 60_000 });

/**
 * @param {LiveDeps} deps
 * @returns {LiveController}
 */
export function createLiveController(deps) {
  const now = deps.now ?? (() => Date.now());
  const doc = deps.doc === undefined ? (typeof document === 'undefined' ? null : document) : deps.doc;
  const silenceLevel = deps.silenceLevel ?? 0.02;
  const transcript = createTranscript();
  /** @type {LiveState} */
  let state = 'idle';
  /** @type {LiveMode} */
  let mode = 'free';
  /** @type {LiveEngine | null} */
  let engine = null;
  /** @type {EndReason | null} */
  let reason = null;
  /** @type {ReturnType<typeof createLiveSession> | null} */
  let session = null;
  /** @type {Capture | null} */
  let capture = null;
  /** @type {AbortController | null} */
  let turn = null;
  /** @type {{ mime: 'image/jpeg', data: string } | null} */
  let pendingImage = null;
  /** The last typed Live turn, until the service echoes its transcript. */
  let typed = '';
  let startedAt = 0;
  let lastActivity = 0;
  /** @type {ReturnType<typeof setInterval> | null} */
  let ticker = null;
  /** @type {Array<() => void>} */
  let cleanups = [];
  /** @type {Set<(state: LiveState) => void>} */
  const listeners = new Set();

  /** @param {LiveState} next */
  const set = (next) => {
    if (state === next) return;
    state = next;
    for (const fn of listeners) fn(state);
  };
  const active = () => state !== 'idle' && state !== 'ended';
  const touch = () => {
    lastActivity = now();
  };

  const onHidden = () => {
    if (doc?.visibilityState === 'hidden' && active()) stop('hidden');
  };

  const tick = () => {
    if (!active()) return;
    const at = now();
    if (at - startedAt >= LIVE_LIMITS.sessionMs) stop('limit');
    else if (at - lastActivity >= LIVE_LIMITS.silenceMs && state !== 'thinking' && !deps.queue.speaking() && !deps.playback.isPlaying()) stop('silence');
  };

  /** Speaks the notice of a free conversation once, at its start. */
  const announceFree = () => {
    deps.queue.enqueue(speechNotice('live.spoken.free', {}, deps.locale()));
  };

  // ---------------------------------------------------------------------------------------------
  // Gemini Live (free mode)

  /** @returns {Promise<boolean>} false: the conversation goes on as turns */
  async function startLive() {
    let token;
    try {
      token = await deps.liveToken({ voice: deps.voice(), locale: deps.locale(), camera: Boolean(deps.camera) });
    } catch {
      return false;
    }
    if (!active()) return true;
    const s = createLiveSession({ token, WebSocket: deps.WebSocket });
    session = s;
    /** @type {(ok: boolean) => void} */
    let settled = () => {};
    const ready = new Promise((resolve) => (settled = resolve));
    s.onEvent((event) => onLiveEvent(event, settled));
    if (!s.connect()) return false;
    if (!(await ready)) return false;
    engine = 'live';
    capture = deps.capture();
    capture.onFrame((pcm, level) => {
      if (level > silenceLevel) touch();
      s.sendAudio(pcm);
    });
    capture.onEvent((event) => {
      if (event === 'hidden') stop('hidden');
    });
    try {
      await capture.start();
    } catch {
      stop('microphone');
      return true;
    }
    set('listening');
    return true;
  }

  /**
   * @param {LiveEvent} event
   * @param {(ok: boolean) => void} settled
   */
  function onLiveEvent(event, settled) {
    switch (event.type) {
      case 'ready':
        settled(true);
        break;
      case 'audio':
        touch();
        set('speaking');
        void deps.playback.play(event.samples, event.rate).then(() => {
          if (state === 'speaking' && !deps.playback.isPlaying()) set('listening');
        });
        break;
      case 'input_transcript':
        touch();
        // A typed turn is already in the transcript; an echo of it is not added twice.
        if (typed && event.text.trim() === typed) typed = '';
        else transcript.append('user', event.text);
        break;
      case 'output_transcript':
      case 'text':
        touch();
        transcript.close('user');
        transcript.append('assistant', event.text, 'free');
        break;
      case 'interrupted':
        deps.playback.flush();
        transcript.close('assistant');
        set('listening');
        break;
      case 'turn_complete':
        transcript.close('user');
        transcript.close('assistant');
        break;
      case 'refused':
      case 'fallback':
        settled(false);
        if (engine === 'live' && active()) void switchToTurns();
        break;
      case 'error':
        settled(false);
        break;
      case 'closed':
        settled(false);
        if (engine === 'live' && active() && event.by === 'server') {
          if (FALLBACK.has(event.code)) return;
          stop('error');
        }
        break;
      default:
        break;
    }
  }

  /** The service refused the session mid-way: go on as turns. */
  async function switchToTurns() {
    capture?.cancel();
    capture = null;
    session = null;
    engine = 'turns';
    set('ready');
  }

  // ---------------------------------------------------------------------------------------------
  // Turns (sources mode, and free mode without Gemini Live)

  /**
   * Answers one turn: retrieval (sources), the model, the gate, speech.
   * @param {string} said
   */
  async function answer(said) {
    const text = said.trim();
    if (!text || !active()) return;
    transcript.append('user', text);
    transcript.close('user');
    touch();
    set('thinking');
    turn = new AbortController();
    const { signal } = turn;
    const locale = deps.locale();
    const grounded = mode === 'sources';
    try {
      const sources = grounded ? await deps.retrieve(text, { signal, locale }) : [];
      const gate = createSentenceGate({ mode: grounded ? 'sources' : 'free', locale, sources, question: text });
      const image = pendingImage;
      pendingImage = null;
      let spoke = false;
      // A checked answer shows what the gate released (the count of held-back sentences next to
      // it); a free answer shows its text as it streams, labelled as not checked.
      /** @param {import('../core/gate.js').Released[]} units */
      const take = (units) => {
        for (const unit of units) {
          if (grounded) transcript.append('assistant', `${unit.text} `, 'checked');
          spoke = deps.queue.enqueue(unit) || spoke;
        }
      };
      transcript.ensure('assistant', grounded ? 'checked' : 'free');
      for await (const delta of deps.ask({ text, mode: grounded ? 'grounded' : 'free', sources, history: transcript.history(), image, locale, signal })) {
        if (signal.aborted) break;
        if (!grounded) transcript.append('assistant', delta, 'free');
        take(gate.push(delta));
        if (spoke && state === 'thinking') set('speaking');
      }
      if (signal.aborted) {
        gate.abort();
        return;
      }
      const result = gate.end();
      take(result.released);
      const withheld = result.counts.withheld;
      if (withheld > 0) deps.queue.enqueue(speechNotice('live.spoken.withheld', { count: withheld }, locale));
      transcript.close('assistant', { withheld });
      if (spoke || withheld) set('speaking');
      await deps.queue.idle();
      touch();
    } catch (err) {
      if (!signal.aborted) {
        transcript.close('assistant');
        if (/** @type {{ code?: string }} */ (err)?.code === 'no_model') stop('no_model');
      }
    } finally {
      turn = null;
      if (active()) set('ready');
    }
  }

  /** Press to talk: opens the microphone; the next press sends the recording. */
  async function talk() {
    if (!active() || engine !== 'turns') return;
    if (state === 'thinking' || state === 'speaking') {
      // A press while the answer plays interrupts it.
      turn?.abort();
      deps.queue.stop();
      deps.playback.flush();
      set('ready');
      return;
    }
    if (state === 'listening' && capture) {
      const current = capture;
      capture = null;
      const length = current.durationMs();
      const wav = await current.stopWav();
      if (length < LIMITS.minUtteranceMs) {
        set('ready');
        return;
      }
      set('thinking');
      const controller = new AbortController();
      turn = controller;
      const heard = await deps.transcribe(wav, controller.signal).then(
        (r) => r.text,
        () => '',
      );
      turn = null;
      if (!active()) return;
      if (!heard) {
        set('ready');
        return;
      }
      await answer(heard);
      return;
    }
    capture = deps.capture();
    capture.onLevel((level) => {
      if (level > silenceLevel) touch();
    });
    capture.onEvent((event) => {
      if (event === 'limit') void talk();
      if (event === 'hidden') stop('hidden');
    });
    try {
      await capture.start();
      set('listening');
      touch();
    } catch {
      capture = null;
      set('ready');
    }
  }

  // ---------------------------------------------------------------------------------------------

  /** @param {EndReason} [why] */
  function stop(why = 'stopped') {
    if (!active()) return;
    reason = why;
    turn?.abort();
    turn = null;
    session?.close();
    session = null;
    capture?.cancel();
    capture = null;
    deps.queue.stop();
    deps.playback.flush();
    // A conversation the limits ended says so (the user may not be looking at the screen).
    if (why === 'limit' || why === 'silence') deps.queue.enqueue(speechNotice('live.spoken.ended', {}, deps.locale()));
    transcript.close('user');
    transcript.close('assistant');
    if (ticker) clearInterval(ticker);
    ticker = null;
    for (const fn of cleanups) fn();
    cleanups = [];
    set('ended');
  }

  return {
    async start(nextMode) {
      if (active()) return;
      mode = nextMode;
      reason = null;
      engine = null;
      pendingImage = null;
      transcript.clear();
      startedAt = now();
      touch();
      set('connecting');
      ticker = setInterval(tick, deps.tickMs ?? 5000);
      doc?.addEventListener('visibilitychange', onHidden);
      cleanups.push(() => doc?.removeEventListener('visibilitychange', onHidden));
      if (mode === 'free') announceFree();
      if (mode === 'free' && deps.canUseLive() && (await startLive())) return;
      if (!active()) return;
      engine = 'turns';
      set('ready');
    },
    stop,
    talk,
    async say(text) {
      if (!active()) return;
      if (engine === 'live' && session) {
        typed = text.trim();
        transcript.append('user', typed);
        transcript.close('user');
        touch();
        session.sendText(typed);
        return;
      }
      if (state === 'ready') await answer(text);
    },
    async snapshot() {
      if (!active() || !deps.camera) return false;
      try {
        const picture = await deps.camera();
        if (engine === 'live' && session) session.sendImage(picture.data);
        else pendingImage = picture;
        touch();
        return true;
      } catch {
        return false;
      }
    },
    state: () => state,
    mode: () => mode,
    engine: () => engine,
    reason: () => reason,
    transcript,
    onState(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/** Close codes after which the conversation goes on as turns (session.js reports them as fallback). */
const FALLBACK = new Set([1007, 1008]);
