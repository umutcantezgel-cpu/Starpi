// @ts-check
// The site's ElevenLabs keys (ELEVENLABS_API_KEYS) for POST /api/voice/speak, source "elevenlabs".
// Keys rotate and park like the Gemini keys (gemini/client.js); the key travels in xi-api-key only.
// The account's voice list is read at most once an hour, so a voice is spoken only when ElevenLabs
// itself still calls it premade (besides being on the app's own list).
import { createKeyRing, sendWithRing } from '../gemini/client.js';

/**
 * @typedef {import('../gemini/client.js').KeyRing} KeyRing
 * @typedef {import('../gemini/client.js').FetchLike} FetchLike
 */

/** ElevenLabs keys: one token of URL-safe characters ("sk_…" today). */
export const ELEVENLABS_KEY_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
export const ELEVENLABS_ROOT = 'https://api.elevenlabs.io';
const VOICE_LIST_TTL_MS = 3_600_000;

/**
 * Keys from ELEVENLABS_API_KEYS: split on commas and white space, deduplicated, malformed entries
 * dropped and only counted.
 * @param {string | undefined} raw
 */
export function parseElevenLabsKeys(raw) {
  const entries = [...new Set((raw ?? '').split(/[\s,]+/).filter(Boolean))];
  const keys = entries.filter((k) => ELEVENLABS_KEY_PATTERN.test(k));
  return { keys, invalid: entries.length - keys.length };
}

/**
 * @typedef {object} ElevenLabsAccount
 * @property {KeyRing} ring
 * @property {string} root
 * @property {(fetch: FetchLike, signal?: AbortSignal) => Promise<Set<string> | null>} premade  ids the account calls premade; null while unknown
 */

/**
 * @param {{ keys: readonly string[], root: string, now: () => number }} options
 * @returns {ElevenLabsAccount}
 */
export function createElevenLabsAccount({ keys, root, now }) {
  const ring = createKeyRing(keys, now);
  /** @type {{ at: number, ids: Set<string> } | null} */
  let list = null;
  return {
    ring,
    root,
    async premade(send, signal) {
      if (list && now() - list.at < VOICE_LIST_TTL_MS) return list.ids;
      const result = await sendWithRing({ ring, authHeader: 'xi-api-key', fetch: send, request: { url: `${root}/v1/voices`, method: 'GET', headers: { accept: 'application/json' } }, signal, timeoutMs: 10_000, maxBytes: 4 * 1024 * 1024 });
      if (!result.ok) return list?.ids ?? null;
      try {
        const voices = JSON.parse(new TextDecoder().decode(result.bytes))?.voices;
        const ids = new Set((Array.isArray(voices) ? voices : []).filter((v) => v?.category === 'premade' && typeof v.voice_id === 'string').map((v) => /** @type {string} */ (v.voice_id)));
        list = { at: now(), ids };
        return ids;
      } catch {
        return list?.ids ?? null;
      }
    },
  };
}
