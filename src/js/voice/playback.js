// @ts-check
// Sound output of the voice features through WebAudio, so the page needs no media element and the
// CSP keeps media-src 'none'. PCM chunks (cloud voices, Live audio, a decoded WAV) are scheduled one
// after another without gaps on one shared AudioContext. Browsers start an AudioContext only after a
// user gesture: unlock() is called from the click that starts a reading or a Live session; a chunk
// that cannot play (the context stays suspended) resolves false, so the speech queue can step down
// to the browser's own voices. flush() stops everything at once (stop, interruption, a hidden tab).
// Nothing is stored.
import { pcm16ToFloat } from './wav.js';

/**
 * @typedef {object} Playback
 * @property {() => Promise<boolean>} unlock          creates or resumes the context; true when it runs
 * @property {(pcm: Int16Array, rate: number) => Promise<boolean>} play  resolves when the chunk ended (false: flushed or not playable)
 * @property {() => void} flush
 * @property {() => boolean} isPlaying
 * @property {(fn: (playing: boolean) => void) => () => void} onStateChange
 * @property {() => BaseAudioContext | null} context
 */

/**
 * @typedef {object} PlaybackDeps
 * @property {() => AudioContext | null} [createContext]  default: a new AudioContext (null where there is none)
 * @property {number} [leadSec]    how far ahead of now the first chunk starts; default 0.03
 */

/**
 * @param {PlaybackDeps} [deps]
 * @returns {Playback}
 */
export function createPlayback(deps = {}) {
  const lead = deps.leadSec ?? 0.03;
  const createContext =
    deps.createContext ??
    (() => {
      const Ctor = /** @type {typeof AudioContext | undefined} */ (globalThis.AudioContext ?? /** @type {any} */ (globalThis).webkitAudioContext);
      return Ctor ? new Ctor() : null;
    });
  /** @type {AudioContext | null} */
  let ctx = null;
  let nextAt = 0;
  /** @type {Map<AudioBufferSourceNode, (played: boolean) => void>} */
  const active = new Map();
  /** @type {Set<(playing: boolean) => void>} */
  const listeners = new Set();
  let playing = false;

  /** @param {boolean} on */
  const setPlaying = (on) => {
    if (on === playing) return;
    playing = on;
    for (const fn of listeners) {
      try {
        fn(on);
      } catch (err) {
        console.error('[starpi] playback listener failed', err);
      }
    }
  };

  const ensure = () => {
    if (!ctx) {
      try {
        ctx = createContext();
      } catch {
        ctx = null;
      }
    }
    return ctx;
  };

  return {
    async unlock() {
      const c = ensure();
      if (!c) return false;
      if (c.state === 'suspended') {
        try {
          await c.resume();
        } catch {
          // stays suspended: chunks resolve false
        }
      }
      return c.state === 'running';
    },
    async play(pcm, rate) {
      const c = ensure();
      if (!c || pcm.length === 0) return false;
      const running = () => /** @type {string} */ (c.state) === 'running';
      if (!running()) {
        try {
          await c.resume();
        } catch {
          // reported below
        }
        if (!running()) return false;
      }
      const buffer = c.createBuffer(1, pcm.length, rate);
      buffer.getChannelData(0).set(pcm16ToFloat(pcm));
      const node = c.createBufferSource();
      node.buffer = buffer;
      node.connect(c.destination);
      const at = Math.max(c.currentTime + lead, nextAt);
      nextAt = at + buffer.duration;
      return new Promise((resolve) => {
        active.set(node, resolve);
        node.onended = () => {
          const done = active.get(node);
          active.delete(node);
          if (active.size === 0) setPlaying(false);
          done?.(true);
        };
        setPlaying(true);
        node.start(at);
      });
    },
    flush() {
      for (const [node, resolve] of active) {
        node.onended = null;
        try {
          node.stop();
        } catch {
          // not started yet or already ended
        }
        resolve(false);
      }
      active.clear();
      nextAt = 0;
      setPlaying(false);
    },
    isPlaying: () => playing,
    onStateChange(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    context: () => ctx,
  };
}

/** @type {Playback | null} */
let shared = null;

/** The app's playback (one AudioContext for every voice feature). */
export function getPlayback() {
  shared ??= createPlayback();
  return shared;
}
