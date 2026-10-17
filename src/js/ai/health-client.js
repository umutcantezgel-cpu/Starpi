// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
// What this site's server offers, from GET /api/health: which site pools have keys, which providers
// the relay sends to a local fake (simulated), the voice and research functions, and whether an
// access code is needed. The answer holds booleans only, never a key, a key count or an address.
// The client asks once and keeps the answer for HEALTH_TTL_MS; callers during a request share it, a
// forced load during a request runs once more after it. A failed request keeps the last good answer
// and marks the state as an error. healthDots() turns the booleans into the status dots of the model
// picker: on, off, or unknown while the server has not answered.

/**
 * @typedef {object} HealthReport
 * @property {string} version
 * @property {Record<string, boolean>} pools       pool id -> the site has keys for it
 * @property {Record<string, boolean>} simulated   provider id -> its API root is a local fake
 * @property {{ tts: boolean, stt: boolean, live: boolean }} voice
 * @property {boolean} research
 * @property {boolean} access                      the site asks for an access code
 */

/**
 * @typedef {object} HealthState
 * @property {'idle' | 'pending' | 'ok' | 'error'} status
 * @property {HealthReport | null} data    the last good answer
 * @property {string | null} error         'network', 'http_<status>' or 'bad_response'
 * @property {number | null} at            epoch ms of the last answer or failure
 */

/** @typedef {'on' | 'off' | 'unknown'} DotState */
/** @typedef {{ state: DotState, tone: 'ok' | 'neutral' | 'warn', icon: string, labelKey: string }} StatusDot */

/**
 * @typedef {object} HealthDots
 * @property {Record<string, StatusDot>} pools
 * @property {{ tts: StatusDot, stt: StatusDot, live: StatusDot }} voice
 * @property {StatusDot} research
 * @property {StatusDot} access
 * @property {StatusDot} server   whether the server answered at all
 */

/**
 * @typedef {object} HealthClientOptions
 * @property {(input: string, init?: RequestInit) => Promise<Response>} [fetch]  default: globalThis.fetch at call time
 * @property {string} [url]
 * @property {number} [ttlMs]
 * @property {number} [timeoutMs]
 * @property {() => number} [now]
 */

export const HEALTH_URL = '/api/health';
/** How long a good answer is used without asking again. */
export const HEALTH_TTL_MS = 60_000;
/** A health request that takes longer counts as failed. */
export const HEALTH_TIMEOUT_MS = 8_000;
/** Largest health answer read. */
const MAX_HEALTH_CHARS = 16_384;

/** @type {Readonly<Record<DotState, Omit<StatusDot, 'state'>>>} */
const DOTS = Object.freeze({
  on: { tone: 'ok', icon: 'check-circle-2', labelKey: 'ai-orchestration.health.on' },
  off: { tone: 'neutral', icon: 'circle-dashed', labelKey: 'ai-orchestration.health.off' },
  unknown: { tone: 'warn', icon: 'triangle-alert', labelKey: 'ai-orchestration.health.unknown' },
});

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The boolean entries of a map with short identifier keys.
 * @param {unknown} value
 * @returns {Record<string, boolean>}
 */
function booleans(value) {
  /** @type {Record<string, boolean>} */
  const out = {};
  if (!isRecord(value)) return out;
  for (const [key, v] of Object.entries(value)) if (/^[a-z][a-z0-9_-]{0,31}$/.test(key) && typeof v === 'boolean') out[key] = v;
  return out;
}

/**
 * Reads a health answer; anything that is not a boolean in its place counts as false (or is
 * dropped from the maps), so nothing else of the body is kept.
 * @param {unknown} json
 * @returns {HealthReport | null} null when the body is not a health answer at all
 */
export function parseHealth(json) {
  if (!isRecord(json)) return null;
  const voice = isRecord(json.voice) ? json.voice : {};
  return {
    version: typeof json.version === 'string' && /^[\w.+-]{1,40}$/.test(json.version) ? json.version : '',
    pools: booleans(json.pools),
    simulated: booleans(json.simulated),
    voice: { tts: voice.tts === true, stt: voice.stt === true, live: voice.live === true },
    research: json.research === true,
    access: json.access === true,
  };
}

/**
 * A status dot for a boolean, or for a value not known yet.
 * @param {boolean | null | undefined} value
 * @returns {StatusDot}
 */
export function statusDot(value) {
  const state = value === true ? 'on' : value === false ? 'off' : 'unknown';
  return { state, ...DOTS[state] };
}

/**
 * The status dots of a health state.
 * @param {HealthState} state
 * @param {readonly string[]} [poolIds] pools to show even when the answer does not name them
 * @returns {HealthDots}
 */
export function healthDots(state, poolIds = []) {
  const data = state.data;
  const known = (/** @type {boolean} */ v) => (data ? v : null);
  /** @type {Record<string, StatusDot>} */
  const pools = {};
  for (const id of new Set([...poolIds, ...Object.keys(data?.pools ?? {})])) pools[id] = statusDot(data ? data.pools[id] === true : null);
  return {
    pools,
    voice: { tts: statusDot(known(data?.voice.tts === true)), stt: statusDot(known(data?.voice.stt === true)), live: statusDot(known(data?.voice.live === true)) },
    research: statusDot(known(data?.research === true)),
    access: statusDot(known(data?.access === true)),
    server: statusDot(state.status === 'ok' ? true : state.status === 'error' ? false : null),
  };
}

/**
 * A health client with its own state; the app shares the default one below.
 * @param {HealthClientOptions} [options]
 */
export function createHealthClient(options = {}) {
  const url = options.url ?? HEALTH_URL;
  const ttl = options.ttlMs ?? HEALTH_TTL_MS;
  const timeout = options.timeoutMs ?? HEALTH_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  /** @type {HealthState} */
  let state = { status: 'idle', data: null, error: null, at: null };
  /** @type {Promise<HealthState> | null} */
  let inflight = null;
  /** @type {Promise<HealthState> | null} */
  let queued = null;
  /** @type {Set<(state: HealthState) => void>} */
  const listeners = new Set();

  const notify = () => {
    for (const fn of listeners) {
      try {
        fn(state);
      } catch {
        // one listener must not stop the others
      }
    }
  };

  /** @returns {Promise<HealthState>} */
  const request = () => {
    state = { ...state, status: 'pending' };
    notify();
    const doFetch = options.fetch ?? globalThis.fetch;
    inflight = (async () => {
      /** @type {HealthState} */
      let next;
      try {
        const res = await doFetch(url, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(timeout) });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          next = { ...state, status: 'error', error: `http_${res.status}`, at: now() };
        } else {
          const body = await res.text();
          let json = null;
          try {
            json = body.length <= MAX_HEALTH_CHARS ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          const data = parseHealth(json);
          next = data ? { status: 'ok', data, error: null, at: now() } : { ...state, status: 'error', error: 'bad_response', at: now() };
        }
      } catch {
        next = { ...state, status: 'error', error: 'network', at: now() };
      }
      state = next;
      inflight = null;
      notify();
      return state;
    })();
    return inflight;
  };

  return {
    /** @returns {HealthState} */
    get: () => state,
    /**
     * Asks the server unless a fresh good answer is there; never rejects.
     * @param {{ force?: boolean }} [opts]
     * @returns {Promise<HealthState>}
     */
    load(opts = {}) {
      if (queued) return queued;
      if (inflight) {
        if (!opts.force) return inflight;
        queued = inflight.then(() => {
          queued = null;
          return request();
        });
        return queued;
      }
      if (!opts.force && state.status === 'ok' && state.at !== null && now() - state.at < ttl) return Promise.resolve(state);
      return request();
    },
    /**
     * Whether the site sends a provider to a local fake: true or false from the last good answer,
     * null before there is one.
     * @param {string} provider
     * @returns {boolean | null}
     */
    simulated(provider) {
      return state.data ? state.data.simulated[provider] === true : null;
    },
    /**
     * Whether the site has keys for a pool; null before the first good answer.
     * @param {string} pool
     * @returns {boolean | null}
     */
    pool(pool) {
      return state.data ? state.data.pools[pool] === true : null;
    },
    /** @param {readonly string[]} [poolIds] */
    dots: (poolIds) => healthDots(state, poolIds),
    /**
     * @param {(state: HealthState) => void} fn
     * @returns {() => void} unsubscribe
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** @typedef {ReturnType<typeof createHealthClient>} HealthClient */

/** The client this page shares. */
export const healthClient = createHealthClient();

/** @param {{ force?: boolean }} [opts] */
export const loadHealth = (opts) => healthClient.load(opts);
export const getHealth = () => healthClient.get();
/** @param {(state: HealthState) => void} fn */
export const onHealthChange = (fn) => healthClient.subscribe(fn);
/** @param {string} provider */
export const providerSimulated = (provider) => healthClient.simulated(provider);
