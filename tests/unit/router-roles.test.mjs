// Roles, strengths and thinking on top of the model catalog: the role candidates start with the
// catalog's tiers (fast -> fast, balanced then max -> reasoning, max -> judge, the tiers that see
// images -> vision), every candidate is a model of the provider's snapshot, live lists and pins
// decide what is tried, the strengths max/super/auto/fast name catalog models per provider, and
// the thinking switch reaches each kind of model through its own lever.
import './setup.mjs';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/** A localStorage of this test file's own, so stored choices can be checked. */
const store = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (/** @type {string} */ k) => (store.has(k) ? store.get(k) : null),
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => void store.set(k, String(v)),
    removeItem: (/** @type {string} */ k) => void store.delete(k),
    clear: () => store.clear(),
  },
});

const { SNAPSHOT, findModel, roleModel } = await import('../../src/js/ai/catalog/models.js');
const roles = await import('../../src/js/ai/roles.js');
const selection = await import('../../src/js/ai/model-selection.js');
const thinking = await import('../../src/js/ai/thinking.js');

const { CATALOG_ROLE_MAP, MODEL_ROLES, ROLE_CANDIDATES, ROLE_FALLBACK, catalogRoleModels, parseModelRef, modelRef, readRoleCandidates, resolveRoleModels, roleCandidates, roleChain, roleChainModels, rolePool, rolesOf } = roles;

/** @typedef {import('../../src/js/ai/contract.js').ProviderId} ProviderId */

/** Providers whose snapshot section names catalog tiers. */
const TIERED = /** @type {ProviderId[]} */ (Object.entries(SNAPSHOT.providers).filter(([, s]) => s && Object.keys(s.roles ?? {}).length).map(([p]) => p));

describe('role candidates agree with the model catalog', () => {
  it('covers every provider with catalog tiers, and only models of its snapshot', () => {
    assert.ok(TIERED.length >= 5);
    for (const provider of TIERED) {
      const table = ROLE_CANDIDATES[provider];
      assert.ok(table, `${provider} has candidates`);
      const known = new Set(SNAPSHOT.providers[provider]?.models.map((m) => m.id));
      for (const role of MODEL_ROLES) for (const id of table[role] ?? []) assert.ok(known.has(id), `${provider}/${role}: ${id} is in the snapshot`);
    }
  });

  it('starts fast with the fast tier, judge with max and reasoning with balanced then max', () => {
    for (const provider of TIERED) {
      const tiers = /** @type {Record<string, string>} */ (SNAPSHOT.providers[provider]?.roles);
      const list = (/** @type {import('../../src/js/ai/roles.js').ModelRole} */ role) => roleCandidates(provider, role);
      assert.equal(list('fast')[0], tiers.fast, `${provider} fast`);
      assert.equal(list('judge')[0], tiers.max, `${provider} judge`);
      if (tiers.balanced !== tiers.fast) {
        assert.deepEqual(list('reasoning').slice(0, catalogRoleModels(provider, 'reasoning').length), catalogRoleModels(provider, 'reasoning'), `${provider} reasoning`);
      } else if (tiers.max === tiers.fast) {
        // One model for every tier: every list starts with it.
        assert.equal(list('reasoning')[0], tiers.fast, `${provider} reasoning starts with its one tier model`);
        assert.deepEqual(catalogRoleModels(provider, 'reasoning'), [tiers.max], `${provider} reasoning from the catalog`);
      } else {
        // No middle tier: the data names a middle model first, and max still follows.
        assert.notEqual(list('reasoning')[0], tiers.fast, `${provider} reasoning does not start with the fast model`);
        assert.ok(list('reasoning').includes(tiers.max), `${provider} reasoning reaches max`);
      }
    }
  });

  it('gives vision only models that see images, the catalog tiers first', () => {
    for (const provider of TIERED) {
      const vision = roleCandidates(provider, 'vision');
      for (const id of vision) assert.equal(findModel(provider, id)?.caps.vision, true, `${provider}: ${id} sees images`);
      const anchor = catalogRoleModels(provider, 'vision');
      assert.deepEqual(vision.slice(0, anchor.length), anchor, `${provider} vision`);
    }
  });

  it('maps the catalog tiers onto the roles', () => {
    assert.deepEqual(CATALOG_ROLE_MAP, { fast: ['fast'], reasoning: ['balanced', 'max'], vision: ['balanced', 'fast', 'max'], judge: ['max'] });
    assert.deepEqual(catalogRoleModels('anthropic', 'reasoning'), ['claude-sonnet-5-5', 'claude-opus-5-5']);
    assert.deepEqual(catalogRoleModels('anthropic', 'judge'), ['claude-opus-5-5']);
    assert.deepEqual(catalogRoleModels('deepseek', 'reasoning'), [roleModel('deepseek', 'max')], 'balanced is the fast model: max alone');
    assert.deepEqual(catalogRoleModels('groq', 'vision'), [], 'no tier of this provider sees images');
    const view = { tier: (/** @type {any} */ _p, /** @type {string} */ t) => ({ fast: 'f', balanced: 'b', max: 'm' })[t] ?? null, caps: (/** @type {any} */ _p, /** @type {string} */ id) => /** @type {any} */ ({ vision: id !== 'b' }) };
    assert.deepEqual(catalogRoleModels('openai', 'vision', view), ['f', 'm']);
    assert.deepEqual(catalogRoleModels('openai', 'reasoning', view), ['b', 'm']);
  });

  it('falls back to the catalog tiers for a provider the data leaves out', () => {
    assert.deepEqual(roleCandidates('anthropic', 'judge', {}), ['claude-opus-5-5']);
    assert.deepEqual(roleCandidates('anthropic', 'fast', {}), ['claude-haiku-5-5']);
    assert.deepEqual(roleCandidates('webgpu', 'fast', {}), [], 'on-device engines have no tiers');
    assert.deepEqual(roleCandidates('anthropic', 'vision', { anthropic: {} }), [], 'an entry without the role stays empty');
  });
});

describe('resolving the models of a role', () => {
  it('reads the data defensively', () => {
    const table = readRoleCandidates({ providers: { openai: { fast: ['a', 'a', '', 7, 'b'], weird: ['x'] }, nope: { fast: ['y'] } } });
    assert.deepEqual(table, { openai: { fast: ['a', 'b'] } });
    assert.ok(Object.isFrozen(table.openai?.fast));
    assert.deepEqual(readRoleCandidates(null), {});
  });

  it('keeps only ids the live list names, and puts the pinned model first', () => {
    const candidates = { openai: { fast: ['nano', 'mini', 'gone'], vision: ['mini'] } };
    assert.deepEqual(resolveRoleModels('openai', 'fast', { candidates }), ['nano', 'mini', 'gone'], 'no live list yet: the data as it is');
    assert.deepEqual(resolveRoleModels('openai', 'fast', { candidates, live: ['mini', 'nano'] }), ['nano', 'mini']);
    const pinned = { provider: /** @type {const} */ ('openai'), model: 'custom-1' };
    assert.deepEqual(resolveRoleModels('openai', 'fast', { candidates, live: ['mini'], pinned }), ['custom-1', 'mini'], 'a pin wins even when the list does not name it');
    assert.deepEqual(resolveRoleModels('anthropic', 'fast', { candidates: { anthropic: { fast: ['h'] } }, pinned }), ['h'], 'a pin at another provider changes nothing');
    const blind = () => /** @type {any} */ ({ vision: false });
    assert.deepEqual(resolveRoleModels('openai', 'vision', { candidates, pinned, caps: blind }), ['mini'], 'a pinned model that cannot see stays out of vision');
  });

  it('falls back fast -> reasoning, reasoning -> fast, judge -> reasoning and vision -> nothing', () => {
    assert.deepEqual(ROLE_FALLBACK, { fast: ['reasoning'], reasoning: ['fast'], vision: [], judge: ['reasoning'] });
    assert.deepEqual(roleChain('judge'), ['judge', 'reasoning']);
    const candidates = { openai: { fast: ['n', 'm'], reasoning: ['m', 'g'], judge: ['g'] } };
    assert.deepEqual(roleChainModels('openai', 'fast', { candidates }), [
      { model: 'n', role: 'fast' },
      { model: 'm', role: 'fast' },
      { model: 'g', role: 'reasoning' },
    ]);
    assert.deepEqual(roleChainModels('openai', 'vision', { candidates }), []);
  });

  it('reads provider:model references whose model ids hold colons', () => {
    assert.deepEqual(parseModelRef('openrouter:meta-llama/llama-3.3-70b-instruct:free'), { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free' });
    assert.equal(parseModelRef('nobody:model'), null);
    assert.equal(parseModelRef('openai:'), null);
    assert.equal(parseModelRef(42), null);
    assert.equal(modelRef({ provider: 'gemini', model: 'gemini-2.5-pro' }), 'gemini:gemini-2.5-pro');
  });

  it('pools every model of the providers with all its roles', () => {
    const pool = rolePool(['anthropic', 'anthropic', 'nope'], { live: () => ['claude-opus-5-5', 'claude-sonnet-5-5'] });
    assert.deepEqual(
      pool.map((e) => [e.model, e.roles]),
      [
        ['claude-sonnet-5-5', ['fast', 'reasoning', 'vision', 'judge']],
        ['claude-opus-5-5', ['reasoning', 'vision', 'judge']],
      ],
    );
    assert.deepEqual(rolesOf('anthropic', 'claude-haiku-5-5'), ['fast', 'vision']);
  });
});

describe('model strengths max, super, auto and fast', () => {
  beforeEach(() => {
    store.clear();
    selection.resetModelSelection();
    selection.setCatalogRoleLookup(undefined);
  });

  it('names the catalog tiers per provider', () => {
    for (const provider of TIERED) {
      const tiers = /** @type {Record<string, string>} */ (SNAPSHOT.providers[provider]?.roles);
      assert.equal(selection.strengthModel(provider, 'max'), tiers.max, `${provider} max`);
      assert.equal(selection.strengthModel(provider, 'fast'), tiers.fast, `${provider} fast`);
      assert.equal(selection.strengthModel(provider, 'super'), ROLE_CANDIDATES[provider]?.reasoning?.[0], `${provider} super`);
      if (tiers.balanced !== tiers.fast) assert.equal(selection.strengthModel(provider, 'super'), tiers.balanced, `${provider} super is the balanced tier`);
      assert.equal(selection.strengthModel(provider, 'auto'), null);
    }
  });

  it('passes over a model the live list does not name', () => {
    assert.equal(selection.strengthModel('openai', 'max', { live: ['gpt-5-mini', 'gpt-5-nano'] }), 'gpt-5-mini', 'max falls back to the next judge candidate');
    assert.equal(selection.strengthModel('openai', 'fast', { live: ['gpt-5-mini'] }), 'gpt-5-mini');
    assert.equal(selection.strengthModel('openai', 'max', { live: [] }), null);
    assert.equal(selection.strengthModel('openai', 'max', { catalogRole: null, candidates: { openai: { judge: ['j'] } } }), 'j', 'without the catalog the candidates answer');
    selection.setCatalogRoleLookup(() => 'from-lookup');
    assert.equal(selection.strengthModel('openai', 'fast'), 'from-lookup');
  });

  it('lets a pinned model win at its provider and keeps both choices', () => {
    assert.equal(selection.getModelStrength(), 'auto');
    assert.equal(selection.selectedModel('openai'), null, 'auto fixes no model');
    assert.equal(selection.setModelStrength('max'), true);
    assert.equal(store.get(selection.MODEL_STRENGTH_KEY), 'max');
    assert.deepEqual(selection.selectedModel('openai'), { provider: 'openai', model: 'gpt-5' });
    /** @type {Array<[string, unknown]>} */
    const seen = [];
    const off = selection.onModelSelectionChange((strength, pinned) => seen.push([strength, pinned]));
    selection.setPinnedModel({ provider: 'anthropic', model: 'claude-haiku-5-5' });
    off();
    assert.equal(store.get(selection.MODEL_PINNED_KEY), 'anthropic:claude-haiku-5-5');
    assert.deepEqual(selection.selectedModel('anthropic'), { provider: 'anthropic', model: 'claude-haiku-5-5' });
    assert.deepEqual(selection.selectedModel('openai'), { provider: 'openai', model: 'gpt-5' }, 'other providers keep the strength');
    assert.deepEqual(seen, [['max', { provider: 'anthropic', model: 'claude-haiku-5-5' }]]);
    selection.setModelStrength('fast');
    assert.equal(selection.getPinnedModel(), null, 'choosing a strength drops the pin');
    store.set(selection.MODEL_STRENGTH_KEY, 'bogus');
    assert.equal(selection.getModelStrength(), 'auto');
  });

  it('starts the router with the strength model among the live ids', async () => {
    const { planChain, routerDeps } = await import('../../src/js/ai/router.js');
    const { getPurpose } = await import('../../src/js/ai/purposes.js');
    const def = /** @type {import('../../src/js/ai/purposes.js').PurposeDef} */ (getPurpose('research_brief'));
    selection.setModelStrength('max');
    const deps = routerDeps({ configured: () => ['openai'], liveModels: () => ['gpt-5-mini', 'gpt-5-nano'], device: () => null });
    assert.deepEqual(planChain(def, {}, deps)[0], { tier: 'selected', provider: 'openai', model: 'gpt-5-mini', role: 'reasoning' }, 'gpt-5 is not listed, the next judge candidate is');
    selection.setModelStrength('auto');
    assert.equal(planChain(def, {}, deps)[0].tier, 'role', 'auto fixes no model: the role chain starts');
  });

  it('holds the choice for the page when the browser keeps nothing', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    try {
      assert.equal(selection.setModelStrength('super'), false);
      assert.equal(selection.getModelStrength(), 'super');
      assert.equal(thinking.setThinking(true), false);
      assert.equal(thinking.isThinkingOn(), true);
      thinking.setThinking(false);
      assert.equal(thinking.isThinkingOn(), false);
    } finally {
      if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
      selection.resetModelSelection();
    }
  });
});

describe('extended thinking per kind of model', () => {
  beforeEach(() => {
    store.clear();
    thinking.setThinking(false);
  });

  it('is off by default and remembers the switch', () => {
    assert.equal(thinking.isThinkingOn(), false);
    /** @type {boolean[]} */
    const seen = [];
    const off = thinking.onThinkingChange((on) => seen.push(on));
    thinking.setThinking(true);
    off();
    assert.equal(store.get(thinking.THINKING_KEY), 'on');
    assert.equal(thinking.isThinkingOn(), true);
    assert.deepEqual(seen, [true]);
  });

  it('names each provider kind its own lever', () => {
    /** @param {ProviderId} provider @param {string} model @param {boolean} on */
    const plan = (provider, model, on) => thinking.thinkingPlan({ provider, model, caps: findModel(provider, model)?.caps ?? null, on });
    assert.deepEqual(plan('anthropic', 'claude-opus-5-5', true), { control: 'effort', value: 'high' });
    assert.deepEqual(plan('anthropic', 'claude-opus-5-5', false), { control: 'effort', value: 'low' }, 'off is low effort, never a disabled config');
    assert.deepEqual(plan('openai', 'gpt-5', true), { control: 'effort', value: 'high' });
    assert.deepEqual(plan('gemini', 'gemini-3-pro-preview', true), { control: 'thinkingLevel', value: 'high' });
    assert.deepEqual(plan('gemini', 'gemini-2.5-flash', true), { control: 'budget', value: -1 });
    assert.deepEqual(plan('gemini', 'gemini-2.5-flash', false), { control: 'budget', value: 0 });
    assert.deepEqual(plan('local', 'qwen3:8b', false), { control: 'no_think', value: '/no_think' });
    assert.deepEqual(plan('local', 'qwen3:8b', true), { control: 'none', value: null }, 'a tagged model thinks by itself');
    assert.deepEqual(plan('local', 'llama3.2:3b', false), { control: 'none', value: null });
    assert.deepEqual(plan('deepseek', 'deepseek-chat', true), { control: 'none', value: null });
  });

  it('applies the choice to a request: options, more tokens and time, /no_think', () => {
    const on = thinking.thinkingFor({ provider: 'anthropic', model: 'claude-sonnet-5-5', on: true, role: 'reasoning', show: false });
    assert.equal(on.thinks, true);
    assert.deepEqual(on.request, { mode: 'on', effort: 'high', show: false });
    const req = thinking.applyThinking({ provider: 'anthropic', model: 'claude-sonnet-5-5', messages: [], maxOutputTokens: 1000, timeoutMs: 10_000 }, on);
    assert.equal(req.maxOutputTokens, 1000 + thinking.THINKING_EXTRA_TOKENS);
    assert.equal(req.timeoutMs, 10_000 * thinking.THINKING_TIMEOUT_FACTOR);

    const quick = thinking.thinkingFor({ provider: 'anthropic', model: 'claude-haiku-5-5', on: true, role: 'fast' });
    assert.equal(quick.thinks, false, 'the fast role stays quick');
    assert.deepEqual(quick.request, { mode: 'off', effort: 'low' });
    assert.equal(thinking.thinkingFor({ provider: 'anthropic', model: 'claude-haiku-5-5', on: true, role: 'fast', force: true }).thinks, true);

    const local = thinking.thinkingFor({ provider: 'local', model: 'qwen3:8b', on: false });
    const plain = thinking.applyThinking({ provider: 'local', model: 'qwen3:8b', messages: [], system: 'Be brief.' }, local);
    assert.equal(plain.system, 'Be brief.\n\n/no_think');
    assert.equal(thinking.applyThinking(plain, local).system, plain.system, 'added once');
    assert.deepEqual(plain.thinking, { mode: 'off' });

    const none = thinking.thinkingFor({ provider: 'deepseek', model: 'deepseek-chat', on: true, role: 'reasoning' });
    assert.equal(none.thinks, false);
    assert.equal(thinking.applyThinking({ provider: 'deepseek', model: 'deepseek-chat', messages: [], thinking: { mode: 'on' } }, none).thinking, undefined);
  });

  it('follows the stored switch when the caller does not say', () => {
    thinking.setThinking(true);
    assert.equal(thinking.thinkingFor({ provider: 'openai', model: 'gpt-5', role: 'judge' }).thinks, true);
    thinking.setThinking(false);
    assert.equal(thinking.thinkingFor({ provider: 'openai', model: 'gpt-5', role: 'judge' }).thinks, false);
  });
});
