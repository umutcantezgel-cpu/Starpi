// @ts-check
// The front guards every server route shares that reaches a provider (relay, pools, later voice and
// research): the origin allowlist, a per-IP request limit, an optional per-IP daily budget and the
// optional access code, always in this order. The rate limit comes before the access code, so the
// code cannot be guessed faster than the limit allows.
//
// Limits live in one function instance, as everywhere in api/: they brake abuse, they are not a
// global quota. A deployment with many warm instances lets a client through more often.
import { checkAccess } from './access.js';
import { parseOrigins } from './env.js';
import { checkSameOrigin, clientIp } from './guards.js';

/**
 * @typedef {import('./guards.js').Refusal} Refusal
 * @typedef {{ hit: (ip: string) => { ok: boolean, retryAfterS: number } }} Limiter
 * @typedef {object} FrontGuards
 * @property {readonly string[]} extraOrigins serialized origins allowed besides the site itself
 * @property {Limiter} limiter per-IP requests per minute
 * @property {string} accessCode '' when the site has none
 */

/**
 * Further browser origins that may call the server routes: STARPI_ALLOWED_ORIGINS, plus the older
 * names NVIDIA_ALLOWED_ORIGINS and RELAY_ALLOWED_ORIGINS, which mean the same.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function allowedOrigins(env) {
  return parseOrigins([env.STARPI_ALLOWED_ORIGINS, env.NVIDIA_ALLOWED_ORIGINS, env.RELAY_ALLOWED_ORIGINS].filter(Boolean).join(','));
}

const DAY_MS = 86_400_000;

/**
 * Requests per client IP and UTC day. At `maxEntries` addresses the counts of earlier days go first,
 * then the oldest entries. A limit of 0 turns the budget off.
 * @param {{ limit: number, now: () => number, maxEntries?: number }} options
 * @returns {Limiter}
 */
export function createDailyLimiter({ limit, now, maxEntries = 20_000 }) {
  /** @type {Map<string, { day: number, count: number }>} */
  const days = new Map();
  return {
    hit(ip) {
      const at = now();
      const day = Math.floor(at / DAY_MS);
      const retryAfterS = Math.max(1, Math.ceil(((day + 1) * DAY_MS - at) / 1000));
      if (limit <= 0) return { ok: true, retryAfterS };
      let entry = days.get(ip);
      if (!entry || entry.day !== day) {
        days.delete(ip);
        if (days.size >= maxEntries) {
          for (const [key, value] of days) if (value.day !== day) days.delete(key);
          for (const key of days.keys()) {
            if (days.size < maxEntries) break;
            days.delete(key);
          }
        }
        entry = { day, count: 0 };
        days.set(ip, entry);
      }
      entry.count++;
      return { ok: entry.count <= limit, retryAfterS };
    },
  };
}

/**
 * Origin, per-IP rate limit, access code. Null when the request may go on.
 * @param {Request} request
 * @param {FrontGuards} guards
 * @returns {Promise<Refusal | null>}
 */
export async function guardRequest(request, { extraOrigins, limiter, accessCode }) {
  const origin = checkSameOrigin(request, extraOrigins);
  if (origin) return origin;
  const rate = limiter.hit(clientIp(request));
  if (!rate.ok) return { status: 429, error: 'rate_limited', retryAfterS: rate.retryAfterS };
  return checkAccess(request, accessCode);
}
