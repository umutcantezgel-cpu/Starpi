// @ts-check
// The brain router: picks the language model for a request by its data class, the configured
// order, the breaker and each brain's recent health, and never moves a request silently to a
// weaker place.
//  - secret content reaches no model (template answer);
//  - sensitive content reaches only local models; personal content reaches cloud models only when
//    the owner allows it (on by default); public content any configured model;
//  - the first allowed brain fixes the locality of the request, whether it is resting or held by the
//    breaker or not: a failing local model is never replaced by a cloud model, nor the other way
//    round; while no brain of that locality may run, the answer is the template with its notice;
//  - after the first piece of text has gone out, a failing brain is not replaced either: the answer
//    becomes the template and the caller is told to withdraw what it showed (`reset`);
//  - a model's refusal is passed on as the refusal template with its notice, not retried elsewhere.
// Local brains take a memory lease from the admission control before they run.
import { systemClock } from '../lib/clock.js';
import { codeOf } from '../lib/errors.js';
import { mayReach } from '../contracts/data-classes.js';
import { checkBrainRequest } from './contract.js';

/** Failures in a row after which a brain rests. */
export const REST_AFTER_FAILURES = 3;
/** How long a failing brain rests. */
export const REST_MS = 60_000;

/**
 * @typedef {object} BrainResult
 * @property {string} text
 * @property {string} reasoning
 * @property {import('./stop-reasons.js').StopReason} stopReason
 * @property {string} brain
 * @property {string | null} model
 * @property {import('../contracts/data-classes.js').Locality} locality
 * @property {'model' | 'template'} source
 * @property {import('./none.js').Notice | null} notice
 * @property {{ input: number, output: number } | null} usage
 * @property {boolean} reset            true when text went out and was withdrawn
 * @property {Array<{ brain: string, error: string }>} attempts
 */

/**
 * @param {object} options
 * @param {import('./contract.js').Brain[]} options.brains   in the configured order
 * @param {ReturnType<typeof import('./none.js').createNoneBrain>} options.none
 * @param {{ personalToCloud?: boolean }} [options.policy]
 * @param {import('../breaker/breaker.js').Breaker} [options.breaker]
 * @param {import('../admission/admission.js').Admission} [options.admission]
 * @param {import('../lib/clock.js').Clock} [options.clock]
 */
export function createBrainRouter({ brains, none, policy = {}, breaker, admission, clock = systemClock }) {
  /** @type {Map<string, { failures: number, restUntil: number }>} */
  const health = new Map(brains.map((b) => [b.id, { failures: 0, restUntil: 0 }]));

  /** @param {import('./contract.js').Brain} brain */
  const resting = (brain) => (health.get(brain.id)?.restUntil ?? 0) > clock.now();

  /** @param {import('./contract.js').Brain} brain @param {boolean} ok */
  function note(brain, ok) {
    const h = health.get(brain.id);
    if (!h) return;
    if (ok) {
      h.failures = 0;
      h.restUntil = 0;
    } else {
      h.failures += 1;
      if (h.failures >= REST_AFTER_FAILURES) h.restUntil = clock.now() + REST_MS;
    }
    breaker?.record(ok);
  }

  /**
   * @param {import('./none.js').Notice} notice
   * @param {Partial<BrainResult>} [extra]
   * @returns {BrainResult}
   */
  function template(notice, extra = {}) {
    return { text: none.template(notice), reasoning: '', stopReason: 'end_turn', brain: none.id, model: null, locality: 'none', source: 'template', notice, usage: null, reset: false, attempts: [], ...extra };
  }

  /**
   * The brains a request may use, in order, all of the locality of the first brain its data class
   * allows; or the notice to answer with when none of them may run now.
   * @param {import('./contract.js').BrainRequest} request
   * @param {'interactive' | 'events' | 'background'} lane
   * @returns {{ list: import('./contract.js').Brain[], notice: import('./none.js').Notice | null }}
   */
  function candidates(request, lane) {
    let allowed = brains.filter((b) => mayReach(request.dataClass, b.locality, policy) && b.locality !== 'none');
    if (request.brain !== undefined) allowed = allowed.filter((b) => b.id === request.brain);
    if (allowed.length === 0) return { list: [], notice: brains.length === 0 ? 'no_model' : 'no_brain_for_class' };
    // The locality is fixed before anything is left out for its state.
    const locality = allowed[0].locality;
    const same = allowed.filter((b) => b.locality === locality);
    const open = same.filter((b) => !breaker || breaker.allows(lane, { cloud: b.locality === 'cloud' }));
    if (open.length === 0) return { list: [], notice: 'breaker' };
    const awake = open.filter((b) => !resting(b));
    if (awake.length === 0) return { list: [], notice: 'brain_unavailable' };
    return { list: awake, notice: null };
  }

  return {
    /** The brains with their state, for the status page. */
    describe() {
      return brains.map((b) => ({ id: b.id, kind: b.kind, locality: b.locality, model: b.model, hosts: [...b.hosts], resting: resting(b), failures: health.get(b.id)?.failures ?? 0 }));
    },
    /**
     * Answers a request with the best allowed brain.
     * @param {import('./contract.js').BrainRequest} request
     * @param {{ signal?: AbortSignal, onEvent?: (event: import('./contract.js').BrainEvent | { type: 'reset' }) => void, lane?: 'interactive' | 'events' | 'background' }} [options]
     * @returns {Promise<BrainResult>}
     */
    async complete(request, { signal = new AbortController().signal, onEvent = () => {}, lane = 'interactive' } = {}) {
      const req = checkBrainRequest(request);
      if (req.dataClass === 'secret') return template('class_secret');
      if (breaker && !breaker.allows(lane)) return template('breaker');
      const { list, notice } = candidates(req, lane);
      if (notice !== null) return template(notice);
      /** @type {Array<{ brain: string, error: string }>} */
      const attempts = [];
      for (const brain of list) {
        let text = '';
        let reasoning = '';
        let started = false;
        const lease = brain.locality === 'local' && admission && brain.memoryMb ? await admission.acquire({ model: `${brain.id}:${brain.model}`, sizeMb: brain.memoryMb, lane, signal }) : null;
        try {
          /** @type {import('./contract.js').BrainEvent | null} */
          let end = null;
          for await (const event of brain.stream(req, { signal })) {
            if (event.type === 'text') {
              started = true;
              text += event.text;
              onEvent(event);
            } else if (event.type === 'reasoning') {
              reasoning += event.text;
              onEvent(event);
            } else if (event.type === 'end') {
              end = event;
            }
          }
          if (!end) throw Object.assign(new Error(`${brain.id} ended without a stop reason`), { code: 'brain_bad_response' });
          note(brain, end.stopReason !== 'error');
          if (end.stopReason === 'refusal') {
            if (started) onEvent({ type: 'reset' });
            return template('refusal', { brain: brain.id, model: end.model, locality: brain.locality, reset: started, attempts });
          }
          if (end.stopReason === 'error' && !started) {
            attempts.push({ brain: brain.id, error: 'brain_bad_response' });
            continue;
          }
          return { text, reasoning, stopReason: end.stopReason, brain: brain.id, model: end.model, locality: brain.locality, source: 'model', notice: null, usage: end.usage, reset: false, attempts };
        } catch (err) {
          if (signal.aborted) throw err;
          note(brain, false);
          attempts.push({ brain: brain.id, error: codeOf(err) });
          if (started) {
            onEvent({ type: 'reset' });
            return template('brain_failed_midway', { reset: true, attempts });
          }
        } finally {
          lease?.release();
        }
      }
      return template('brain_unavailable', { attempts });
    },
  };
}

/** @typedef {ReturnType<typeof createBrainRouter>} BrainRouter */
