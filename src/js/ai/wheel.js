// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
// Model health per (provider, model), the same in the browser, in workers and on a server:
// - a 429 cools the model down for its Retry-After (DEFAULT_COOLDOWN_MS without one); the breaker is
//   not touched, a rate limit says nothing about whether the model works;
// - a circuit breaker opens after FAILURE_THRESHOLD failures in a row, stays open for OPEN_MS, then
//   lets one probe call through (half-open): its success closes the circuit, its failure opens it again;
// - a 404 marks the model unavailable for NOT_FOUND_MS (the next model list may name it again);
// - a model called for the fast role that answers slower than SLOW_FAST_MS, times out or returns an
//   answer that fails validation moves behind the other fast models for SLOW_FOR_MS.
// Failures the request caused itself never count: a rejected request shape (bad_request, also a too
// long context) and a timeout of a call the caller's own deadline cut short (deadline). Key, quota
// and browser-access problems belong to the provider, not to one model, and are left to the router.
// The clock is injectable, so tests move time instead of waiting. The server's per-key router is a
// separate module; this one never sees a key.

/** @typedef {import('./contract.js').ProviderId} ProviderId */
/** @typedef {import('./errors.js').AiErrorCode} AiErrorCode */
/** @typedef {import('./roles.js').ModelRole} ModelRole */

/**
 * Why a model cannot be called right now. probing: the half-open probe call is still running.
 * @typedef {'cooldown' | 'circuit_open' | 'probing' | 'not_found'} BlockReason
 */
/** @typedef {'closed' | 'open' | 'half-open'} Circuit */
/**
 * What a failed call reports: an AiError code, `invalid_output` (the answer failed validation) or
 * `deadline` (the caller's own deadline cut the call short).
 * @typedef {AiErrorCode | 'invalid_output' | 'deadline'} FailureCode
 */

/**
 * @typedef {object} WheelOptions
 * @property {() => number} [now]           epoch ms
 * @property {number} [failureThreshold]
 * @property {number} [openMs]
 * @property {number} [cooldownMs]          cooldown after a 429 without Retry-After
 * @property {number} [notFoundMs]
 * @property {number} [slowMs]
 * @property {number} [slowForMs]
 */

/**
 * @typedef {object} OutcomeOptions
 * @property {number | null} [latencyMs]
 * @property {ModelRole | null} [role]      the role the call served; only `fast` calls mark speed
 * @property {number | null} [retryAfterMs] for rate_limited
 */

/**
 * @typedef {object} ModelHealth
 * @property {ProviderId} provider
 * @property {string} model
 * @property {boolean} available           pickable right now
 * @property {BlockReason | null} blocked
 * @property {Circuit} circuit
 * @property {number} failures             consecutive failures that count for the breaker
 * @property {number} openUntil
 * @property {number} cooldownUntil
 * @property {number} notFoundUntil
 * @property {number} slowUntil            until then the model comes last among the fast models
 * @property {number} ok
 * @property {number} errors
 * @property {number | null} lastLatencyMs
 * @property {number | null} last429
 */

/** @typedef {Omit<ModelHealth, 'provider' | 'model' | 'available' | 'blocked'> & { probeAt: number | null }} State  probeAt: start of the half-open probe in flight */

export const DEFAULT_COOLDOWN_MS = 20_000;
export const NOT_FOUND_MS = 10 * 60_000;
export const FAILURE_THRESHOLD = 3;
export const OPEN_MS = 60_000;
export const SLOW_FAST_MS = 6_000;
export const SLOW_FOR_MS = 15 * 60_000;

/** Codes that say nothing about the model: neither counted nor closing the circuit. */
const NEUTRAL = new Set(['bad_request', 'context_length', 'deadline', 'aborted', 'auth', 'quota', 'cors', 'refusal']);

/**
 * @param {ProviderId} provider
 * @param {string} model
 */
const keyOf = (provider, model) => `${provider}\u0000${model}`;

export class ModelWheel {
  /** @type {() => number} */ #now;
  /** @type {Required<Omit<WheelOptions, 'now'>>} */ #limits;
  /** @type {Map<string, State>} */ #states = new Map();
  /** @type {Set<(health: ModelHealth) => void>} */ #listeners = new Set();

  /** @param {WheelOptions} [options] */
  constructor(options = {}) {
    this.#now = options.now ?? Date.now;
    this.#limits = {
      failureThreshold: options.failureThreshold ?? FAILURE_THRESHOLD,
      openMs: options.openMs ?? OPEN_MS,
      cooldownMs: options.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      notFoundMs: options.notFoundMs ?? NOT_FOUND_MS,
      slowMs: options.slowMs ?? SLOW_FAST_MS,
      slowForMs: options.slowForMs ?? SLOW_FOR_MS,
    };
  }

  /**
   * Why the model cannot be called now, or null.
   * @param {ProviderId} provider
   * @param {string} model
   * @returns {BlockReason | null}
   */
  blocked(provider, model) {
    const state = this.#states.get(keyOf(provider, model));
    return state ? this.#blockedAt(state, this.#now()) : null;
  }

  /**
   * Takes the model for one call: null when it may be called (a half-open circuit now runs its
   * probe), else why not.
   * @param {ProviderId} provider
   * @param {string} model
   * @returns {BlockReason | null}
   */
  acquire(provider, model) {
    const t = this.#now();
    const state = this.#state(provider, model);
    const reason = this.#blockedAt(state, t);
    if (!reason && state.circuit === 'half-open') state.probeAt = t;
    return reason;
  }

  /**
   * Gives back a model taken with acquire() without an outcome (the caller stopped).
   * @param {ProviderId} provider
   * @param {string} model
   */
  release(provider, model) {
    const state = this.#states.get(keyOf(provider, model));
    if (state) state.probeAt = null;
  }

  /**
   * The models in calling order: for the fast role, the slow ones move behind the others (stable).
   * @param {ProviderId} provider
   * @param {readonly string[]} models
   * @param {ModelRole | null} [role]
   * @returns {string[]}
   */
  order(provider, models, role = null) {
    if (role !== 'fast') return [...models];
    const t = this.#now();
    const slow = (/** @type {string} */ m) => t < (this.#states.get(keyOf(provider, m))?.slowUntil ?? 0);
    return [...models.filter((m) => !slow(m)), ...models.filter(slow)];
  }

  /**
   * @param {ProviderId} provider
   * @param {string} model
   * @param {OutcomeOptions} [options]
   */
  succeeded(provider, model, options = {}) {
    const state = this.#state(provider, model);
    state.ok += 1;
    if (typeof options.latencyMs === 'number') state.lastLatencyMs = Math.round(options.latencyMs);
    if (options.role === 'fast') this.#markSpeed(state, typeof options.latencyMs === 'number' && options.latencyMs > this.#limits.slowMs);
    this.#close(state);
    this.#emit(provider, model, state);
  }

  /**
   * @param {ProviderId} provider
   * @param {string} model
   * @param {FailureCode} code
   * @param {OutcomeOptions} [options]
   */
  failed(provider, model, code, options = {}) {
    const t = this.#now();
    const state = this.#state(provider, model);
    state.errors += 1;
    if (typeof options.latencyMs === 'number') state.lastLatencyMs = Math.round(options.latencyMs);
    state.probeAt = null;
    if (code === 'rate_limited') {
      state.last429 = t;
      state.cooldownUntil = Math.max(state.cooldownUntil, t + Math.max(0, options.retryAfterMs ?? this.#limits.cooldownMs));
    } else if (code === 'not_found') {
      state.notFoundUntil = t + this.#limits.notFoundMs;
    } else if (code === 'invalid_output') {
      // An answer arrived, so the model works; only its speed for short calls is in doubt.
      if (options.role === 'fast') this.#markSpeed(state, true);
      this.#close(state);
    } else if (!NEUTRAL.has(code)) {
      if (code === 'timeout' && options.role === 'fast') this.#markSpeed(state, true);
      this.#circuitAt(state, t);
      state.failures += 1;
      if (state.circuit === 'half-open' || state.failures >= this.#limits.failureThreshold) {
        state.circuit = 'open';
        state.openUntil = t + this.#limits.openMs;
      }
    }
    this.#emit(provider, model, state);
  }

  /**
   * Milliseconds until the model may be called again: 0 when it may now.
   * @param {ProviderId} provider
   * @param {string} model
   */
  waitMs(provider, model) {
    const state = this.#states.get(keyOf(provider, model));
    if (!state) return 0;
    const t = this.#now();
    this.#circuitAt(state, t);
    let breaker = 0;
    if (state.circuit === 'open') breaker = state.openUntil - t;
    else if (state.circuit === 'half-open' && state.probeAt !== null) breaker = state.probeAt + this.#limits.openMs - t;
    return Math.max(0, Math.ceil(Math.max(breaker, state.cooldownUntil - t, state.notFoundUntil - t)));
  }

  /**
   * @param {ProviderId} provider
   * @param {string} model
   * @returns {ModelHealth}
   */
  status(provider, model) {
    return this.#health(provider, model, this.#states.get(keyOf(provider, model)) ?? this.#fresh(), this.#now());
  }

  /** Every model the wheel has seen. @returns {ModelHealth[]} */
  snapshot() {
    const t = this.#now();
    return [...this.#states.entries()].map(([key, state]) => {
      const [provider, model] = key.split('\u0000');
      return this.#health(/** @type {ProviderId} */ (provider), model, state, t);
    });
  }

  /** Forgets every model's history. */
  reset() {
    this.#states.clear();
  }

  /**
   * Called after every outcome with the model's new health.
   * @param {(health: ModelHealth) => void} fn
   * @returns {() => void} unsubscribe
   */
  onChange(fn) {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  // --- internals ---

  /** @returns {State} */
  #fresh() {
    return { circuit: 'closed', failures: 0, openUntil: 0, probeAt: null, cooldownUntil: 0, notFoundUntil: 0, slowUntil: 0, ok: 0, errors: 0, lastLatencyMs: null, last429: null };
  }

  /**
   * @param {ProviderId} provider
   * @param {string} model
   * @returns {State}
   */
  #state(provider, model) {
    const key = keyOf(provider, model);
    let state = this.#states.get(key);
    if (!state) {
      state = this.#fresh();
      this.#states.set(key, state);
    }
    return state;
  }

  /**
   * Open turns half-open once its time is over.
   * @param {State} state
   * @param {number} t
   */
  #circuitAt(state, t) {
    if (state.circuit === 'open' && t >= state.openUntil) {
      state.circuit = 'half-open';
      state.probeAt = null;
    }
    return state.circuit;
  }

  /**
   * @param {State} state
   * @param {number} t
   * @returns {BlockReason | null}
   */
  #blockedAt(state, t) {
    if (t < state.notFoundUntil) return 'not_found';
    const circuit = this.#circuitAt(state, t);
    if (circuit === 'open') return 'circuit_open';
    // A probe that never reported back is given up after the open time.
    if (circuit === 'half-open' && state.probeAt !== null && t - state.probeAt < this.#limits.openMs) return 'probing';
    if (t < state.cooldownUntil) return 'cooldown';
    return null;
  }

  /** @param {State} state */
  #close(state) {
    state.failures = 0;
    state.circuit = 'closed';
    state.probeAt = null;
  }

  /**
   * @param {State} state
   * @param {boolean} slow
   */
  #markSpeed(state, slow) {
    state.slowUntil = slow ? this.#now() + this.#limits.slowForMs : 0;
  }

  /**
   * @param {ProviderId} provider
   * @param {string} model
   * @param {State} state
   * @param {number} t
   * @returns {ModelHealth}
   */
  #health(provider, model, state, t) {
    const blocked = this.#blockedAt(state, t);
    return {
      provider,
      model,
      available: blocked === null,
      blocked,
      circuit: state.circuit,
      failures: state.failures,
      openUntil: state.openUntil,
      cooldownUntil: state.cooldownUntil,
      notFoundUntil: state.notFoundUntil,
      slowUntil: state.slowUntil,
      ok: state.ok,
      errors: state.errors,
      lastLatencyMs: state.lastLatencyMs,
      last429: state.last429,
    };
  }

  /**
   * @param {ProviderId} provider
   * @param {string} model
   * @param {State} state
   */
  #emit(provider, model, state) {
    if (!this.#listeners.size) return;
    const health = this.#health(provider, model, state, this.#now());
    for (const fn of this.#listeners) {
      try {
        fn(health);
      } catch {
        // a listener's failure must not break the call that reported the outcome
      }
    }
  }
}

/** The wheel this page shares between the router, the council and the model picker. */
export const modelWheel = new ModelWheel();
