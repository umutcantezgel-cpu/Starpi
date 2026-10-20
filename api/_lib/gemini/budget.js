// @ts-check
// Daily budgets of the speech routes, per function instance (like every limit under api/: a brake,
// not a global quota). Besides the per-IP request counts of origins.js, the site's keys get a daily
// ceiling per kind of work: characters spoken, seconds transcribed, Live sessions started. Calls
// with the user's own key (a Live token minted from a key in the header) do not count against them.
// Every count starts again at midnight UTC.
import { positiveInt } from '../env.js';

/** @typedef {'tts' | 'stt' | 'live'} BudgetKind */

export const VOICE_LIMIT_DEFAULTS = Object.freeze({
  /** Requests per client IP and minute over all speech routes (STARPI_VOICE_RPM_PER_IP). */
  rpmPerIp: 20,
  /** Requests per client IP and UTC day that use the site's keys (STARPI_VOICE_DAILY_PER_IP; 0 turns it off). */
  dailyPerIp: 150,
  /** Characters the site's keys speak per day (STARPI_VOICE_DAILY_TTS_CHARS). */
  ttsChars: 300_000,
  /** Seconds of audio the site's keys transcribe per day (STARPI_VOICE_DAILY_STT_SECONDS). */
  sttSeconds: 7_200,
  /** Live sessions the site's keys start per day (STARPI_VOICE_DAILY_LIVE). */
  liveSessions: 200,
});

/**
 * The limits a site sets, each falling back to its default.
 * @param {Record<string, string | undefined>} env
 */
export function readVoiceLimits(env) {
  const daily = (env.STARPI_VOICE_DAILY_PER_IP ?? '').trim() === '0' ? 0 : positiveInt(env.STARPI_VOICE_DAILY_PER_IP, VOICE_LIMIT_DEFAULTS.dailyPerIp);
  return {
    rpmPerIp: positiveInt(env.STARPI_VOICE_RPM_PER_IP, VOICE_LIMIT_DEFAULTS.rpmPerIp),
    dailyPerIp: daily,
    ttsChars: positiveInt(env.STARPI_VOICE_DAILY_TTS_CHARS, VOICE_LIMIT_DEFAULTS.ttsChars),
    sttSeconds: positiveInt(env.STARPI_VOICE_DAILY_STT_SECONDS, VOICE_LIMIT_DEFAULTS.sttSeconds),
    liveSessions: positiveInt(env.STARPI_VOICE_DAILY_LIVE, VOICE_LIMIT_DEFAULTS.liveSessions),
  };
}

const DAY_MS = 86_400_000;

/**
 * @typedef {object} VoiceBudget
 * @property {(kind: BudgetKind, amount: number) => { ok: boolean, retryAfterS: number }} take  counts `amount` when it still fits
 * @property {(kind: BudgetKind) => number} left
 */

/**
 * @param {{ ttsChars: number, sttSeconds: number, liveSessions: number, now: () => number }} options
 * @returns {VoiceBudget}
 */
export function createVoiceBudget({ ttsChars, sttSeconds, liveSessions, now }) {
  const limits = /** @type {Record<BudgetKind, number>} */ ({ tts: ttsChars, stt: sttSeconds, live: liveSessions });
  let day = -1;
  /** @type {Record<BudgetKind, number>} */
  let used = { tts: 0, stt: 0, live: 0 };
  const roll = () => {
    const today = Math.floor(now() / DAY_MS);
    if (today !== day) {
      day = today;
      used = { tts: 0, stt: 0, live: 0 };
    }
  };
  return {
    take(kind, amount) {
      roll();
      const retryAfterS = Math.max(1, Math.ceil(((day + 1) * DAY_MS - now()) / 1000));
      const cost = Math.max(0, Math.ceil(amount));
      if (used[kind] + cost > limits[kind]) return { ok: false, retryAfterS };
      used[kind] += cost;
      return { ok: true, retryAfterS };
    },
    left(kind) {
      roll();
      return Math.max(0, limits[kind] - used[kind]);
    },
  };
}
