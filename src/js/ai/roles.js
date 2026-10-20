// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
// Model roles: which models of a provider serve short quick calls (fast), longer thought-through
// work (reasoning), images (vision) and verdicts over other answers (judge). The preferred models
// per provider and role are data (role-candidates.json); at run time they are intersected with the
// provider's live model list, so an id the provider no longer lists is never tried. A model the user
// pinned comes first. When every model of a role is busy the router moves on along ROLE_FALLBACK;
// vision has no substitute, because a text model cannot read the picture.
//
// The model catalog (catalog/models.js) sorts each provider's models into three tiers: fast,
// balanced and max. The roles build on them (CATALOG_ROLE_MAP):
//   fast       starts with the catalog's fast model
//   reasoning  starts with balanced, then max; a provider whose balanced model is its fast one has
//              no middle tier, so its list names a middle model first and max after it (a provider
//              with one model for every tier, such as the base model's, starts with that model)
//   judge      starts with max, the strongest model
//   vision     those of balanced, fast and max (in that order) whose capabilities say they see images
// Further models of the provider's snapshot may follow in each list. A provider the data leaves out
// gets these catalog models alone (catalogRoleModels), so a provider added to the catalog works
// before anyone writes its candidates.
import { findModel, roleModel } from './catalog/models.js';
import { isProviderId, PROVIDER_IDS } from './contract.js';
import candidateData from './role-candidates.json' with { type: 'json' };

/** @typedef {import('./contract.js').ProviderId} ProviderId */
/** @typedef {import('./contract.js').Caps} Caps */
/** @typedef {'fast' | 'reasoning' | 'vision' | 'judge'} ModelRole */
/** @typedef {Readonly<Partial<Record<ProviderId, Readonly<Partial<Record<ModelRole, readonly string[]>>>>>>} RoleCandidates */
/** @typedef {{ provider: ProviderId, model: string }} ModelRef */
/** @typedef {import('./catalog/models.js').ModelRole} CatalogTier */
/**
 * What the catalog says about a provider's models; the default reads the shipped snapshot.
 * @typedef {object} CatalogView
 * @property {(provider: ProviderId, tier: CatalogTier) => string | null} tier
 * @property {(provider: ProviderId, model: string) => Caps | null} caps
 */

/**
 * @typedef {object} ResolveOptions
 * @property {readonly string[] | null} [live]      the provider's live model ids; null or absent: not known yet, the data is used as it is
 * @property {ModelRef | null} [pinned]             the user's choice; first for its provider
 * @property {RoleCandidates} [candidates]          default ROLE_CANDIDATES
 * @property {(provider: ProviderId, model: string) => Caps | null} [caps]  keeps a pinned model without vision out of the vision role
 */

/**
 * @typedef {object} PoolEntry  one model with every role it serves
 * @property {ProviderId} provider
 * @property {string} model
 * @property {ModelRole[]} roles
 * @property {boolean} pinned
 */

export const MODEL_ROLES = /** @type {readonly ModelRole[]} */ (Object.freeze(['fast', 'reasoning', 'vision', 'judge']));

/** Roles tried after the requested one, in order. */
export const ROLE_FALLBACK = /** @type {Readonly<Record<ModelRole, readonly ModelRole[]>>} */ (
  Object.freeze({
    fast: Object.freeze(['reasoning']),
    reasoning: Object.freeze(['fast']),
    vision: Object.freeze([]),
    judge: Object.freeze(['reasoning']),
  })
);

/** The catalog tiers each role starts with, in order (see the header for the reasoning and vision rules). */
export const CATALOG_ROLE_MAP = /** @type {Readonly<Record<ModelRole, readonly CatalogTier[]>>} */ (
  Object.freeze({
    fast: Object.freeze(['fast']),
    reasoning: Object.freeze(['balanced', 'max']),
    vision: Object.freeze(['balanced', 'fast', 'max']),
    judge: Object.freeze(['max']),
  })
);

/** @type {CatalogView} */
const SHIPPED_CATALOG = Object.freeze({
  tier: (provider, tier) => roleModel(provider, tier),
  caps: (provider, model) => findModel(provider, model)?.caps ?? null,
});

/**
 * The models the catalog's tiers give a role at a provider, without repeats: for reasoning the fast
 * model is left out unless it is max as well (a provider without a middle tier starts with max), for
 * vision only models that see images.
 * @param {ProviderId} provider
 * @param {ModelRole} role
 * @param {CatalogView} [catalog]
 * @returns {string[]}
 */
export function catalogRoleModels(provider, role, catalog = SHIPPED_CATALOG) {
  const fast = catalog.tier(provider, 'fast');
  /** @type {string[]} */
  const out = [];
  for (const tier of CATALOG_ROLE_MAP[role] ?? []) {
    const model = catalog.tier(provider, tier);
    if (!model || out.includes(model)) continue;
    if (role === 'reasoning' && model === fast && tier !== 'max') continue;
    if (role === 'vision' && catalog.caps(provider, model)?.vision !== true) continue;
    out.push(model);
  }
  return out;
}

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * The candidate table of role-candidates.json, with unknown providers, unknown roles and anything
 * that is not a list of ids dropped.
 * @param {unknown} data
 * @returns {RoleCandidates}
 */
export function readRoleCandidates(data) {
  /** @type {Partial<Record<ProviderId, Partial<Record<ModelRole, string[]>>>>} */
  const out = {};
  const providers = data && typeof data === 'object' ? /** @type {{ providers?: unknown }} */ (data).providers : null;
  if (!providers || typeof providers !== 'object') return deepFreeze(out);
  for (const [provider, roles] of Object.entries(providers)) {
    if (!isProviderId(provider) || !roles || typeof roles !== 'object') continue;
    /** @type {Partial<Record<ModelRole, string[]>>} */
    const table = {};
    for (const role of MODEL_ROLES) {
      const list = /** @type {Record<string, unknown>} */ (roles)[role];
      if (Array.isArray(list)) table[role] = [...new Set(list.filter((id) => typeof id === 'string' && id.length > 0 && id.length <= 200))];
    }
    out[provider] = table;
  }
  return deepFreeze(out);
}

/** The shipped candidate table. */
export const ROLE_CANDIDATES = readRoleCandidates(candidateData);

/**
 * @param {unknown} value
 * @returns {value is ModelRole}
 */
export function isModelRole(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (MODEL_ROLES).includes(value);
}

/**
 * The role followed by its fallback roles.
 * @param {ModelRole} role
 * @returns {ModelRole[]}
 */
export function roleChain(role) {
  return [role, ...(ROLE_FALLBACK[role] ?? [])];
}

/**
 * `provider:model`, the picker's reference of a model. Model ids may contain colons themselves.
 * @param {ModelRef} ref
 */
export function modelRef(ref) {
  return `${ref.provider}:${ref.model}`;
}

/**
 * Reads a `provider:model` reference; null when the provider is unknown or the model id is empty.
 * @param {unknown} value
 * @returns {ModelRef | null}
 */
export function parseModelRef(value) {
  if (typeof value !== 'string') return null;
  const at = value.indexOf(':');
  if (at <= 0) return null;
  const provider = value.slice(0, at);
  const model = value.slice(at + 1).trim();
  return isProviderId(provider) && model && model.length <= 200 ? { provider, model } : null;
}

/**
 * The preferred models of a provider for one role: the data's list, or the catalog's models for the
 * role when the data has no entry for the provider at all.
 * @param {ProviderId} provider
 * @param {ModelRole} role
 * @param {RoleCandidates} [candidates]
 * @returns {string[]}
 */
export function roleCandidates(provider, role, candidates = ROLE_CANDIDATES) {
  const table = candidates[provider];
  return table ? [...(table[role] ?? [])] : catalogRoleModels(provider, role);
}

/**
 * The models of a provider for one role: the candidates the live list names (all of them while no
 * list is known), with the pinned model first. A pinned model whose capabilities say it cannot see
 * images stays out of the vision role.
 * @param {ProviderId} provider
 * @param {ModelRole} role
 * @param {ResolveOptions} [options]
 * @returns {string[]}
 */
export function resolveRoleModels(provider, role, options = {}) {
  const live = Array.isArray(options.live) ? new Set(options.live) : null;
  const listed = roleCandidates(provider, role, options.candidates).filter((id) => !live || live.has(id));
  const pinned = options.pinned && options.pinned.provider === provider ? options.pinned.model : null;
  if (!pinned) return listed;
  if (role === 'vision' && options.caps?.(provider, pinned)?.vision === false) return listed;
  return [pinned, ...listed.filter((id) => id !== pinned)];
}

/**
 * The models of a provider along a role and its fallback roles, each with the role it serves,
 * without repeats.
 * @param {ProviderId} provider
 * @param {ModelRole} role
 * @param {ResolveOptions} [options]
 * @returns {Array<{ model: string, role: ModelRole }>}
 */
export function roleChainModels(provider, role, options = {}) {
  /** @type {Array<{ model: string, role: ModelRole }>} */
  const out = [];
  for (const r of roleChain(role)) {
    for (const model of resolveRoleModels(provider, r, options)) if (!out.some((e) => e.model === model)) out.push({ model, role: r });
  }
  return out;
}

/**
 * The roles a model has in the data.
 * @param {ProviderId} provider
 * @param {string} model
 * @param {RoleCandidates} [candidates]
 * @returns {ModelRole[]}
 */
export function rolesOf(provider, model, candidates = ROLE_CANDIDATES) {
  return MODEL_ROLES.filter((role) => (candidates[provider]?.[role] ?? []).includes(model));
}

/**
 * Every model the given providers offer for any role, in provider order, each with its roles.
 * The council picks its members and its judge from this pool.
 * @param {readonly ProviderId[]} providers
 * @param {{ live?: (provider: ProviderId) => readonly string[] | null, pinned?: ModelRef | null, candidates?: RoleCandidates, caps?: ResolveOptions['caps'] }} [options]
 * @returns {PoolEntry[]}
 */
export function rolePool(providers, options = {}) {
  /** @type {PoolEntry[]} */
  const out = [];
  for (const provider of [...new Set(providers)].filter(isProviderId)) {
    const live = options.live?.(provider) ?? null;
    for (const role of MODEL_ROLES) {
      for (const model of resolveRoleModels(provider, role, { live, pinned: options.pinned, candidates: options.candidates, caps: options.caps })) {
        const entry = out.find((e) => e.provider === provider && e.model === model);
        const pinned = options.pinned?.provider === provider && options.pinned.model === model;
        if (entry) {
          if (!entry.roles.includes(role)) entry.roles.push(role);
        } else out.push({ provider, model, roles: [role], pinned });
      }
    }
  }
  return out;
}

/** Providers in the contract's order; the default priority when the user set none. */
export const DEFAULT_PROVIDER_ORDER = PROVIDER_IDS;
