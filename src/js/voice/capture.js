// @ts-check
// The microphone for dictation and Live. start() opens it (mono, with the browser's echo
// cancellation, noise suppression and gain control); the AudioWorklet of pcm-worklet.js turns it
// into 16 kHz PCM16 frames of 20 ms. stop() returns the utterance (dictation sends it as a WAV);
// Live streams the frames instead (onFrame). At most LIMITS.utteranceSec seconds are kept.
//
// Half duplex on a loudspeaker: while the app speaks (the playback, the speech queue) and for
// LIMITS.playbackMuteMs after it, frames are dropped, so the assistant never hears itself. The
// tracks are released on stop(), cancel(), and when the tab is hidden. Audio is never stored.
import { AUDIO, LIMITS } from './catalog.js';
import { concatPcm, encodeWav } from './wav.js';

/** Where the browser finds the worklet; scripts/build.mjs writes the hashed asset path in its place. */
export const PCM_WORKLET_URL = '__STARPI_PCM_WORKLET_URL__';
/** The processor name pcm-worklet.js registers. */
export const PCM_PROCESSOR = 'starpi-pcm';

/** getUserMedia constraints of the voice features. */
export const MIC_CONSTRAINTS = Object.freeze({
  audio: Object.freeze({ channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
  video: false,
});

/**
 * @typedef {'unsupported' | 'denied' | 'no_microphone' | 'busy' | 'worklet' | 'aborted'} CaptureErrorCode
 */

/** The microphone could not start; `code` names why (dictionary voice.capture.<code>). */
export class CaptureError extends Error {
  /** @param {CaptureErrorCode} code */
  constructor(code) {
    super(code);
    this.name = 'CaptureError';
    this.code = code;
  }
}

/**
 * Something that plays sound (the playback, the speech queue).
 * @typedef {{ isPlaying: () => boolean, onStateChange: (fn: (playing: boolean) => void) => () => void }} ActivitySource
 */

/**
 * @typedef {object} CaptureDeps
 * @property {Pick<MediaDevices, 'getUserMedia'> | null} [mediaDevices]  default navigator.mediaDevices
 * @property {() => BaseAudioContext | null} [context]   default: a context of its own
 * @property {typeof AudioWorkletNode} [WorkletNode]
 * @property {string} [workletUrl]
 * @property {ActivitySource[]} [activity]   half duplex: frames are dropped while one of them plays
 * @property {Document | null} [doc]         visibility; default document
 * @property {number} [maxSeconds]
 * @property {() => number} [now]
 */

/**
 * @typedef {object} Capture
 * @property {() => Promise<void>} start
 * @property {() => Promise<Int16Array>} stop       the utterance at 16 kHz
 * @property {() => Promise<Uint8Array>} stopWav    the utterance as a WAV
 * @property {() => void} cancel                    discards the utterance, releases the microphone
 * @property {() => 'idle' | 'starting' | 'recording'} state
 * @property {(muted: boolean) => void} setMuted
 * @property {(fn: (pcm: Int16Array, level: number) => void) => () => void} onFrame
 * @property {(fn: (level: number) => void) => () => void} onLevel
 * @property {(fn: (event: 'limit' | 'hidden' | 'ended') => void) => () => void} onEvent
 * @property {() => number} durationMs
 */

/** Contexts whose worklet module is loaded. */
const loaded = new WeakSet();

/**
 * @param {unknown} err
 * @returns {CaptureErrorCode}
 */
function codeOf(err) {
  const name = err instanceof Error || err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no_microphone';
  if (name === 'NotReadableError' || name === 'AbortError') return 'busy';
  return 'unsupported';
}

/**
 * @param {CaptureDeps} [deps]
 * @returns {Capture}
 */
export function createCapture(deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const maxSamples = (deps.maxSeconds ?? LIMITS.utteranceSec) * AUDIO.inputRate;
  /** @type {'idle' | 'starting' | 'recording'} */
  let state = 'idle';
  /** @type {MediaStream | null} */
  let stream = null;
  /** @type {AudioWorkletNode | null} */
  let node = null;
  /** @type {AudioNode | null} */
  let sourceNode = null;
  /** @type {AudioNode | null} */
  let sink = null;
  /** @type {BaseAudioContext | null} */
  let ctx = null;
  let ownContext = false;
  /** @type {Int16Array[]} */
  let chunks = [];
  let samples = 0;
  let muted = false;
  let mutedUntil = 0;
  let limitReported = false;
  let generation = 0;
  /** @type {Set<(pcm: Int16Array, level: number) => void>} */
  const frameListeners = new Set();
  /** @type {Set<(level: number) => void>} */
  const levelListeners = new Set();
  /** @type {Set<(event: 'limit' | 'hidden' | 'ended') => void>} */
  const eventListeners = new Set();
  /** @type {Array<() => void>} */
  let unsubscribe = [];

  const doc = deps.doc === undefined ? (typeof document === 'undefined' ? null : document) : deps.doc;

  /** @param {'limit' | 'hidden' | 'ended'} event */
  const emit = (event) => eventListeners.forEach((fn) => fn(event));

  const halfDuplex = () => (deps.activity ?? []).some((a) => a.isPlaying()) || now() < mutedUntil;

  const onHidden = () => {
    if (doc?.visibilityState === 'hidden' && state !== 'idle') {
      release();
      emit('hidden');
    }
  };

  /** @param {Int16Array} pcm @param {number} level */
  const onFrame = (pcm, level) => {
    if (muted || halfDuplex()) {
      levelListeners.forEach((fn) => fn(0));
      return;
    }
    levelListeners.forEach((fn) => fn(level));
    frameListeners.forEach((fn) => fn(pcm, level));
    if (samples + pcm.length > maxSamples) {
      if (!limitReported) {
        limitReported = true;
        emit('limit');
      }
      return;
    }
    chunks.push(pcm);
    samples += pcm.length;
  };

  function release() {
    generation += 1;
    try {
      sourceNode?.disconnect();
      node?.disconnect();
      sink?.disconnect();
    } catch {
      // already disconnected
    }
    if (node) node.port.onmessage = null;
    stream?.getTracks().forEach((track) => track.stop());
    if (ownContext && ctx && 'close' in ctx) void (/** @type {AudioContext} */ (ctx).close().catch(() => {}));
    stream = null;
    node = null;
    sourceNode = null;
    sink = null;
    ctx = null;
    ownContext = false;
    state = 'idle';
    unsubscribe.forEach((fn) => fn());
    unsubscribe = [];
    doc?.removeEventListener('visibilitychange', onHidden);
  }

  /** Asks the worklet for its partial frame and waits briefly for it. */
  const flush = () =>
    new Promise((resolve) => {
      if (!node) return resolve(undefined);
      const port = node.port;
      const timer = setTimeout(() => resolve(undefined), 250);
      const previous = port.onmessage;
      port.onmessage = (event) => {
        previous?.call(port, event);
        if (event.data?.type === 'flushed') {
          clearTimeout(timer);
          resolve(undefined);
        }
      };
      port.postMessage({ type: 'flush' });
    });

  return {
    async start() {
      if (state !== 'idle') return;
      state = 'starting';
      const mine = ++generation;
      chunks = [];
      samples = 0;
      limitReported = false;
      const media = deps.mediaDevices === undefined ? (globalThis.navigator?.mediaDevices ?? null) : deps.mediaDevices;
      const Node = deps.WorkletNode ?? globalThis.AudioWorkletNode;
      if (!media?.getUserMedia || typeof Node !== 'function') {
        state = 'idle';
        throw new CaptureError('unsupported');
      }
      try {
        stream = await media.getUserMedia(/** @type {MediaStreamConstraints} */ (MIC_CONSTRAINTS));
      } catch (err) {
        state = 'idle';
        throw new CaptureError(codeOf(err));
      }
      if (mine !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        throw new CaptureError('aborted');
      }
      try {
        ctx = deps.context?.() ?? null;
        if (!ctx) {
          const Ctor = globalThis.AudioContext;
          if (typeof Ctor !== 'function') throw new CaptureError('unsupported');
          ctx = new Ctor();
          ownContext = true;
        }
        if (ctx.state === 'suspended' && 'resume' in ctx) await /** @type {AudioContext} */ (ctx).resume().catch(() => {});
        if (!loaded.has(ctx)) {
          await ctx.audioWorklet.addModule(deps.workletUrl ?? PCM_WORKLET_URL);
          loaded.add(ctx);
        }
        if (mine !== generation) throw new CaptureError('aborted');
        const context = /** @type {AudioContext} */ (ctx);
        sourceNode = context.createMediaStreamSource(stream);
        node = new Node(context, PCM_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, processorOptions: { outputRate: AUDIO.inputRate, frameMs: 20 } });
        // A silent sink keeps the node in the rendering graph in every browser.
        const gain = context.createGain();
        gain.gain.value = 0;
        sink = gain;
        node.port.onmessage = (event) => {
          if (event.data?.type === 'frame' && event.data.pcm instanceof ArrayBuffer) onFrame(new Int16Array(event.data.pcm), Number(event.data.level) || 0);
        };
        sourceNode.connect(node);
        node.connect(gain);
        gain.connect(context.destination);
      } catch (err) {
        const code = err instanceof CaptureError ? err.code : 'worklet';
        release();
        throw new CaptureError(code);
      }
      for (const source of deps.activity ?? []) {
        unsubscribe.push(
          source.onStateChange((playing) => {
            if (!playing) mutedUntil = now() + LIMITS.playbackMuteMs;
          }),
        );
      }
      doc?.addEventListener('visibilitychange', onHidden);
      state = 'recording';
    },
    async stop() {
      if (state === 'idle') return concatPcm(chunks);
      await flush();
      const pcm = concatPcm(chunks);
      release();
      emit('ended');
      chunks = [];
      samples = 0;
      return pcm;
    },
    async stopWav() {
      return encodeWav(await this.stop(), AUDIO.inputRate);
    },
    cancel() {
      chunks = [];
      samples = 0;
      if (state !== 'idle') {
        release();
        emit('ended');
      }
    },
    state: () => state,
    setMuted(on) {
      muted = on;
    },
    onFrame(fn) {
      frameListeners.add(fn);
      return () => frameListeners.delete(fn);
    },
    onLevel(fn) {
      levelListeners.add(fn);
      return () => levelListeners.delete(fn);
    },
    onEvent(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    durationMs: () => Math.round((samples / AUDIO.inputRate) * 1000),
  };
}
