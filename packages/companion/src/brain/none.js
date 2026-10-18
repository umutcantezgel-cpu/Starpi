// @ts-check
// The `none` brain: no model at all. It answers with a short template and is the last resort of
// the router and the only brain secret content may reach. The text is a plain English fallback; the
// browser shows its own translation of the notice code the router attaches.

/** Template texts by notice code. */
export const TEMPLATE_TEXTS = Object.freeze({
  no_model: 'No language model is configured for this companion, so there is no generated answer.',
  class_secret: 'This request holds secret content, which never leaves the companion, so no language model was asked.',
  no_brain_for_class: 'No configured language model may receive content of this data class, so no model was asked.',
  brain_unavailable: 'The configured language models did not answer, so there is no generated answer this time.',
  brain_failed_midway: 'The language model stopped in the middle of its answer; the partial answer was withdrawn.',
  refusal: 'The language model declined to answer this request.',
  breaker: 'The companion is protecting itself after repeated failures and answers with this template until its owner resets it.',
});

/** @typedef {keyof typeof TEMPLATE_TEXTS} Notice */

/**
 * @param {{ id?: string }} [options]
 * @returns {import('./contract.js').Brain & { template: (notice: Notice) => string }}
 */
export function createNoneBrain({ id = 'none' } = {}) {
  return {
    id,
    kind: 'none',
    locality: 'none',
    model: null,
    hosts: [],
    template: (notice) => TEMPLATE_TEXTS[notice] ?? TEMPLATE_TEXTS.no_model,
    async *stream() {
      yield { type: 'text', text: TEMPLATE_TEXTS.no_model };
      yield { type: 'end', stopReason: 'end_turn', model: null, usage: null };
    },
  };
}
