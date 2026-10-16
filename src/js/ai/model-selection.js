// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
// How strong a model the user wants, and the model they pinned. Four strengths:
//   max    the provider's strongest model (catalog role "max", else its first judge candidate)
//   super  a model that reasons at length (its first reasoning candidate, else catalog "balanced")
//   auto   no model fixed: the router walks the role chain and the wheel steers around busy models
//   fast   the quickest model (catalog role "fast", else its first fast candidate)
// A pinned model ("provider:model") always wins over the strength. Both are kept in this browser's
// localStorage; without a choice the strength is auto, so a busy model never ends a request in the
// deterministic fallback while another one is free. The catalog is reached through a lookup the
// catalog module installs (setCatalogRoleLookup), so this module works before and without it.
import { readLocal, removeLocal, writeLocal } from '../storage.js';
import { modelRef, parseModelRef, resolveRoleModels } from './roles.js';

/** @typedef {import('./contract.js').ProviderId} ProviderId */
/** @typedef {import('./roles.js').ModelRef} ModelRef */
/** @typedef {import('./roles.js').ModelRole} ModelRole */
/** @typedef {import('./roles.js').RoleCandidates} RoleCandidates */
/** @typedef {'max' | 'super' | 'auto' | 'fast'} ModelStrength */
/** @typedef {'fast' | 'balanced' | 'max'} CatalogRole */
/** @typedef {(provider: ProviderId, role: CatalogRole) => string | null} CatalogRoleLookup */

/**
 * @typedef {object} StrengthOption
 * @property {ModelStrength} id
 * @property {string} labelKey
 * @property {string} descKey
 * @property {CatalogRole | null} catalogRole
 * @property {ModelRole | null} role   the candidate role used when the catalog has no answer
 */

export const MODEL_STRENGTH_KEY = 'starpi_model_strength_v1';
export const MODEL_PINNED_KEY = 'starpi_model_pinned_v1';
export const MODEL_STRENGTHS = /** @type {readonly ModelStrength[]} */ (Object.freeze(['max', 'super', 'auto', 'fast']));
export const DEFAULT_STRENGTH = /** @type {ModelStrength} */ ('auto');

/** @type {readonly StrengthOption[]} */
export const STRENGTH_OPTIONS = Object.freeze(
  /** @type {StrengthOption[]} */ ([
    { id: 'max', labelKey: 'ai-orchestration.strength.max', descKey: 'ai-orchestration.strength.max_desc', catalogRole: 'max', role: 'judge' },
    { id: 'super', labelKey: 'ai-orchestration.strength.super', descKey: 'ai-orchestration.strength.super_desc', catalogRole: 'balanced', role: 'reasoning' },
    { id: 'auto', labelKey: 'ai-orchestration.strength.auto', descKey: 'ai-orchestration.strength.auto_desc', catalogRole: null, role: null },
    { id: 'fast', labelKey: 'ai-orchestration.strength.fast', descKey: 'ai-orchestration.strength.fast_desc', catalogRole: 'fast', role: 'fast' },
  ]).map((o) => Object.freeze(o)),
);

/** @type {Set<(strength: ModelStrength, pinned: ModelRef | null) => void>} */
const listeners = new Set();
/** Values for this page when the browser would not store them; null: the stored value holds. */
let pageStrength = /** @type {ModelStrength | null} */ (null);
let pagePinned = /** @type {ModelRef | null | undefined} */ (undefined);
/** @type {CatalogRoleLookup | null} */
let catalogLookup = null;

/**
 * @param {unknown} value
 * @returns {value is ModelStrength}
 */
export function isModelStrength(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (MODEL_STRENGTHS).includes(value);
}

/**
 * Installs the catalog's role lookup (for example `roleModel` of the model catalog); null removes it.
 * @param {CatalogRoleLookup | null} lookup
 */
export function setCatalogRoleLookup(lookup) {
  catalogLookup = lookup;
}

/** @returns {ModelStrength} */
export function getModelStrength() {
  if (pageStrength) return pageStrength;
  const stored = readLocal(MODEL_STRENGTH_KEY);
  return isModelStrength(stored) ? stored : DEFAULT_STRENGTH;
}

/**
 * The model the user pinned, or null.
 * @returns {ModelRef | null}
 */
export function getPinnedModel() {
  if (pagePinned !== undefined) return pagePinned;
  return parseModelRef(readLocal(MODEL_PINNED_KEY));
}

/**
 * Chooses a strength; it replaces a pinned model.
 * @param {ModelStrength} strength
 * @returns {boolean} false when the browser did not keep it (it then holds for this page)
 */
export function setModelStrength(strength) {
  const next = isModelStrength(strength) ? strength : DEFAULT_STRENGTH;
  const stored = writeLocal(MODEL_STRENGTH_KEY, next);
  pageStrength = stored ? null : next;
  removeLocal(MODEL_PINNED_KEY);
  pagePinned = readLocal(MODEL_PINNED_KEY) === null ? undefined : null;
  notify();
  return stored;
}

/**
 * Pins a model, or removes the pin with null.
 * @param {ModelRef | null} ref
 * @returns {boolean} false when the browser did not keep it
 */
export function setPinnedModel(ref) {
  const next = ref ? parseModelRef(modelRef(ref)) : null;
  let stored;
  if (next) stored = writeLocal(MODEL_PINNED_KEY, modelRef(next));
  else {
    removeLocal(MODEL_PINNED_KEY);
    stored = readLocal(MODEL_PINNED_KEY) === null;
  }
  pagePinned = stored ? undefined : next;
  notify();
  return stored;
}

/** Back to the default: strength auto, nothing pinned. */
export function resetModelSelection() {
  removeLocal(MODEL_STRENGTH_KEY);
  removeLocal(MODEL_PINNED_KEY);
  pageStrength = null;
  pagePinned = undefined;
  notify();
}

/**
 * @param {(strength: ModelStrength, pinned: ModelRef | null) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onModelSelectionChange(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify() {
  const strength = getModelStrength();
  const pinned = getPinnedModel();
  for (const fn of listeners) {
    try {
      fn(strength, pinned);
    } catch {
      // one listener must not stop the others
    }
  }
}

/**
 * The model a strength stands for at one provider, or null for auto (and when nothing fits). A
 * model the provider's live list does not name is passed over.
 * @param {ProviderId} provider
 * @param {ModelStrength} strength
 * @param {{ live?: readonly string[] | null, catalogRole?: CatalogRoleLookup | null, candidates?: RoleCandidates }} [options]
 * @returns {string | null}
 */
export function strengthModel(provider, strength, options = {}) {
  const option = STRENGTH_OPTIONS.find((o) => o.id === strength);
  if (!option || !option.role || !option.catalogRole) return null;
  const live = Array.isArray(options.live) ? new Set(options.live) : null;
  const listed = (/** @type {string | null | undefined} */ id) => (id && (!live || live.has(id)) ? id : null);
  const lookup = options.catalogRole === undefined ? catalogLookup : options.catalogRole;
  const fromCatalog = () => listed(lookup?.(provider, /** @type {CatalogRole} */ (option.catalogRole)));
  const fromRole = () => resolveRoleModels(provider, /** @type {ModelRole} */ (option.role), { live: options.live, candidates: options.candidates })[0] ?? null;
  // "super" asks for a model that reasons: the candidate data knows that better than a catalog's middle tier.
  return strength === 'super' ? (fromRole() ?? fromCatalog()) : (fromCatalog() ?? fromRole());
}

/**
 * The model the router tries first at a provider: the pinned one when it belongs to the provider,
 * else the strength's model; null when the choice is auto.
 * @param {ProviderId} provider
 * @param {{ strength?: ModelStrength, pinned?: ModelRef | null, live?: readonly string[] | null, catalogRole?: CatalogRoleLookup | null, candidates?: RoleCandidates }} [options]
 *   strength and pinned default to the stored choice
 * @returns {ModelRef | null}
 */
export function selectedModel(provider, options = {}) {
  const pinned = options.pinned === undefined ? getPinnedModel() : options.pinned;
  if (pinned && pinned.provider === provider) return pinned;
  const model = strengthModel(provider, options.strength ?? getModelStrength(), options);
  return model ? { provider, model } : null;
}
