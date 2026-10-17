// @ts-check
// On-device entailment ("does this excerpt support this statement?") for the advisory second
// opinion of the source check. Placeholder for the RPC to src/js/wasm/worker.js: the model, its
// pinned files and the worker side arrive with the second-opinion package. Until then the check
// reports itself unavailable, and callers fall back to the AI layer or skip the second opinion.
// A second opinion is advisory only: it never releases a statement and never upgrades a verdict.

/**
 * @typedef {'entailment' | 'neutral' | 'contradiction'} NliLabel
 * @typedef {{ label: NliLabel, scores: Record<NliLabel, number> }} NliResult
 */

/** Whether on-device entailment can run in this build. */
export function nliAvailable() {
  return false;
}

/**
 * Classifies whether `premise` entails `hypothesis`.
 * @param {string} _premise
 * @param {string} _hypothesis
 * @returns {Promise<NliResult>}
 */
export async function nli(_premise, _hypothesis) {
  throw new Error('On-device entailment is not available in this build');
}
