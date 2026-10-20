// @ts-check
// The quirks of every OpenAI-compatible provider, by the id the provider catalog names.
import { deepseekQuirks } from './deepseek.js';
import { GENERIC_QUIRKS } from './generic.js';
import { groqQuirks } from './groq.js';
import { createLocalQuirks, localQuirks } from './local.js';
import { minimaxQuirks } from './minimax.js';
import { mistralQuirks } from './mistral.js';
import { nvidiaQuirks } from './nvidia.js';
import { createOpenRouterQuirks, openrouterQuirks } from './openrouter.js';
import { xaiQuirks } from './xai.js';

/** @typedef {import('./generic.js').ChatQuirks} ChatQuirks */

export { createLocalQuirks, createOpenRouterQuirks, GENERIC_QUIRKS };

/** @type {Readonly<Record<string, Readonly<ChatQuirks>>>} */
export const QUIRKS = Object.freeze({
  generic: GENERIC_QUIRKS,
  xai: xaiQuirks,
  groq: groqQuirks,
  mistral: mistralQuirks,
  deepseek: deepseekQuirks,
  minimax: minimaxQuirks,
  openrouter: openrouterQuirks,
  nvidia: nvidiaQuirks,
  local: localQuirks,
});

/**
 * The quirks of an id, or the generic ones.
 * @param {string | null | undefined} id
 * @returns {Readonly<ChatQuirks>}
 */
export function getQuirks(id) {
  return id && Object.hasOwn(QUIRKS, id) ? QUIRKS[id] : GENERIC_QUIRKS;
}
