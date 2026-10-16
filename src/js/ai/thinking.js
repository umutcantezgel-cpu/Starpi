// @ts-check
// Origin: generic infrastructure first written for a related project of the same author (MIT); re-expressed for Starpi.
// Extended thinking: one switch for the whole app, kept in this browser's localStorage, and how it
// reaches each kind of model. The adapters speak the contract's ThinkingOptions ({ mode, effort,
// show }); thinkingFor() picks those options per model and names the provider's own lever as a plan
// the adapters and the UI can rely on:
//   effort         Anthropic (adaptive thinking) and OpenAI-style reasoning effort: high when on,
//                  low when off (the 5.5 Claude models cannot switch thinking off; low is the lever)
//   thinkingLevel  Gemini models with thinking levels: high or low
//   budget         Gemini models with a thinking budget: dynamic (-1) when on, 0 when off
//   no_think       local qwen-family models that always reason: "/no_think" in the system prompt when off
//   none           no lever
// A call made for the fast or vision role stays quick: the switch does not apply to it unless the
// caller forces it. With thinking on, the token limit grows (reasoning counts against it) and the
// call gets more time.
import { readLocal, removeLocal, writeLocal } from '../storage.js';

/** @typedef {import('./contract.js').AiRequest} AiRequest */
/** @typedef {import('./contract.js').Caps} Caps */
/** @typedef {import('./contract.js').ProviderId} ProviderId */
/** @typedef {import('./contract.js').ThinkingOptions} ThinkingOptions */
/** @typedef {import('./roles.js').ModelRole} ModelRole */
/** @typedef {'effort' | 'thinkingLevel' | 'budget' | 'no_think' | 'none'} ThinkingControl */
/** @typedef {{ control: ThinkingControl, value: string | number | null }} ThinkingPlan */

/**
 * @typedef {object} ThinkingChoice
 * @property {boolean} thinks                    the model is asked to think
 * @property {ThinkingOptions | undefined} request  for AiRequest.thinking; undefined when the model has no lever
 * @property {ThinkingPlan} plan
 * @property {number} extraTokens                added to the token limit
 * @property {number} timeoutFactor              the call's time limit is multiplied by it
 */

export const THINKING_KEY = 'starpi_thinking_v1';
/** Reasoning counts against the output limit; this much more room is given when thinking is on. */
export const THINKING_EXTRA_TOKENS = 4096;
/** A thinking call gets this many times its usual time limit. */
export const THINKING_TIMEOUT_FACTOR = 2;
/** The directive that turns reasoning off for qwen-family models. */
export const NO_THINK = '/no_think';

const ON_DEVICE = new Set(['local', 'webgpu', 'wasm']);
const QUICK_ROLES = new Set(['fast', 'vision']);

/** @type {Set<(on: boolean) => void>} */
const listeners = new Set();
/** The switch for this page when the browser would not store it; null: the stored value holds. */
let pageValue = /** @type {boolean | null} */ (null);

/** Whether extended thinking is on (default off). */
export function isThinkingOn() {
  return pageValue ?? readLocal(THINKING_KEY) === 'on';
}

/**
 * Switches extended thinking and tells the listeners.
 * @param {boolean} on
 * @returns {boolean} false when the browser did not keep the setting (it then holds for this page)
 */
export function setThinking(on) {
  const next = Boolean(on);
  let stored;
  if (next) stored = writeLocal(THINKING_KEY, 'on');
  else {
    removeLocal(THINKING_KEY);
    stored = readLocal(THINKING_KEY) === null;
  }
  pageValue = stored ? null : next;
  for (const fn of listeners) {
    try {
      fn(next);
    } catch {
      // one listener must not stop the others
    }
  }
  return stored;
}

/**
 * @param {(on: boolean) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onThinkingChange(fn) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Whether a model id belongs to the qwen family, whose models obey "/no_think".
 * @param {string} model
 */
export function isQwenFamily(model) {
  return /qwen|qwq/i.test(String(model));
}

/**
 * How a model's thinking is controlled when the catalog does not say: from the provider and the id.
 * @param {ProviderId} provider
 * @param {string} model
 * @returns {Caps['reasoning']}
 */
export function guessReasoning(provider, model) {
  const id = String(model).toLowerCase();
  if (provider === 'anthropic') return 'adaptive';
  if (provider === 'gemini') return /gemini-2\.5/.test(id) ? 'budget' : /gemini-[3-9]/.test(id) ? 'effort' : 'none';
  if (provider === 'openai') return /^(?:o\d|gpt-5)/.test(id) ? 'effort' : 'none';
  if (/gpt-oss|grok-3-mini/.test(id)) return 'effort';
  if (/qwen3|qwq|deepseek-r1|reasoner|magistral|thinking|nemotron-3-(?:super|ultra)/.test(id)) return 'tagged';
  return 'none';
}

/**
 * The provider's own lever for a model, on or off.
 * @param {{ provider: ProviderId, model: string, caps?: Caps | null, on: boolean }} target
 * @returns {ThinkingPlan}
 */
export function thinkingPlan({ provider, model, caps, on }) {
  const kind = caps?.reasoning ?? guessReasoning(provider, model);
  if (kind === 'adaptive') return { control: 'effort', value: on ? 'high' : 'low' };
  if (kind === 'effort') return { control: provider === 'gemini' ? 'thinkingLevel' : 'effort', value: on ? 'high' : 'low' };
  if (kind === 'budget') return { control: 'budget', value: on ? -1 : 0 };
  if (kind === 'tagged' && !on && ON_DEVICE.has(provider) && isQwenFamily(model)) return { control: 'no_think', value: NO_THINK };
  return { control: 'none', value: null };
}

/**
 * What one call sends for thinking.
 * @param {{ provider: ProviderId, model: string, caps?: Caps | null, on?: boolean, role?: ModelRole | null, force?: boolean, show?: boolean }} target
 *   on: the switch (default: the stored one); force: also for the fast and vision roles; show: stream visible reasoning
 * @returns {ThinkingChoice}
 */
export function thinkingFor(target) {
  const wanted = target.on ?? isThinkingOn();
  const thinks = wanted && (target.force === true || !QUICK_ROLES.has(target.role ?? ''));
  const plan = thinkingPlan({ provider: target.provider, model: target.model, caps: target.caps, on: thinks });
  /** @type {ThinkingOptions | undefined} */
  let request;
  if (plan.control === 'effort' || plan.control === 'thinkingLevel') request = thinks ? { mode: 'on', effort: 'high', show: target.show ?? true } : { mode: 'off', effort: 'low' };
  else if (plan.control === 'budget') request = thinks ? { mode: 'on', show: target.show ?? true } : { mode: 'off' };
  else if (plan.control === 'no_think') request = { mode: 'off' };
  const active = thinks && plan.control !== 'none' && plan.control !== 'no_think';
  return { thinks: active, request, plan, extraTokens: active ? THINKING_EXTRA_TOKENS : 0, timeoutFactor: active ? THINKING_TIMEOUT_FACTOR : 1 };
}

/**
 * A request with the thinking choice applied: the options, the larger token limit and time limit,
 * and "/no_think" at the end of the system prompt for the models that need it.
 * @param {AiRequest} req
 * @param {ThinkingChoice} choice
 * @returns {AiRequest}
 */
export function applyThinking(req, choice) {
  /** @type {AiRequest} */
  const out = { ...req };
  if (choice.request) out.thinking = choice.request;
  else delete out.thinking;
  if (choice.extraTokens && typeof req.maxOutputTokens === 'number') out.maxOutputTokens = req.maxOutputTokens + choice.extraTokens;
  if (choice.timeoutFactor !== 1 && typeof req.timeoutMs === 'number') out.timeoutMs = Math.round(req.timeoutMs * choice.timeoutFactor);
  if (choice.plan.control === 'no_think' && !(req.system ?? '').includes(NO_THINK)) out.system = req.system ? `${req.system}\n\n${NO_THINK}` : NO_THINK;
  return out;
}
