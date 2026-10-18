// Picker values and option groups (src/js/models/choices.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { POOLS } from '../../src/js/ai/catalog/pools.js';
import { assistantGroups, choiceValue, defaultPoolValue, GROUP_KEYS, groupLabel, optionParts, parsePickerValue, PROVIDER_GROUPS } from '../../src/js/models/choices.js';
import { classifyDevice, GIB } from '../../src/js/models/device.js';
import { NVIDIA_DEFAULT_MODEL, NVIDIA_MODELS } from '../../src/js/models/nvidia-catalog.js';
import { WASM_CATALOG } from '../../src/js/models/wasm-catalog.js';
import { MODEL_CATALOG } from '../../src/js/webgpu/models.js';

const NVIDIA_IDS = NVIDIA_MODELS.map((m) => m.id);
const desktop = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 2 * GIB, hasF16: true };
const cpu = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 0, hasF16: false, webgpu: false };
const pro = { ...desktop, vendor: 'nvidia', maxStorageBufferBindingSize: 2 * GIB };
const LOCAL_REFS = [...Object.keys(MODEL_CATALOG).map((k) => `webgpu:${k}`), ...Object.keys(WASM_CATALOG).map((k) => `wasm:${k}`)];

/**
 * @param {Partial<import('../../src/js/models/choices.js').PickerState>} [patch]
 * @returns {import('../../src/js/models/choices.js').PickerState}
 */
const state = (patch) => ({
  hw: desktop,
  history: [],
  pools: { nvidia: { configured: true, models: NVIDIA_IDS, defaultModel: NVIDIA_DEFAULT_MODEL }, groq: { configured: false, models: [], defaultModel: null } },
  keyed: [],
  models: {},
  server: false,
  serverModels: [],
  ...patch,
});
/** @param {import('../../src/js/models/choices.js').PickerGroup[]} groups @param {string} id */
const group = (groups, id) => groups.find((g) => g.id === id);
/** @param {import('../../src/js/models/choices.js').PickerGroup[]} groups @param {string} value */
const item = (groups, value) => /** @type {import('../../src/js/models/choices.js').PickerItem} */ (groups.flatMap((g) => g.items).find((i) => i.value === value));

describe('parsePickerValue', () => {
  it('maps Auto, the device, presets, provider models and the 2.x modes', () => {
    assert.deepEqual(parsePickerValue('auto'), { assistant: 'auto' });
    assert.deepEqual(parsePickerValue('council'), { assistant: 'auto' });
    assert.deepEqual(parsePickerValue('device'), { assistant: 'device' });
    assert.deepEqual(parsePickerValue('client'), { assistant: 'device' });
    assert.deepEqual(parsePickerValue('local'), { assistant: 'local:*' });
    assert.deepEqual(parsePickerValue('nvidia', { nvidiaModel: NVIDIA_IDS[2] }), { assistant: `nvidia:${NVIDIA_IDS[2]}` });
    assert.deepEqual(parsePickerValue('webgpu:qwen-3b'), { assistant: 'device', preference: 'webgpu:qwen-3b' });
    assert.deepEqual(parsePickerValue('wasm:smollm2-135m'), { assistant: 'device', preference: 'wasm:smollm2-135m' });
    assert.deepEqual(parsePickerValue('anthropic:claude-opus-5-5'), { assistant: 'anthropic:claude-opus-5-5' });
    assert.deepEqual(parsePickerValue('openrouter:meta-llama/llama-3.3-70b-instruct:free'), { assistant: 'openrouter:meta-llama/llama-3.3-70b-instruct:free' });
    assert.deepEqual(parsePickerValue('local:*'), { assistant: 'local:*' });
    assert.deepEqual(parsePickerValue('local:llama3.2:3b'), { assistant: 'local:llama3.2:3b' });
    assert.deepEqual(parsePickerValue(`nvidia:${NVIDIA_IDS[1]}`), { assistant: `nvidia:${NVIDIA_IDS[1]}` });
  });

  it('refuses values the pickers never offer', () => {
    for (const value of ['nvidia:openai/not-listed', 'nvidia:', 'nvidia', 'webgpu:bogus', 'wasm:qwen-3b', 'qwen-3b', 'anthropic:*', 'webgpu:auto', 'unknown:model', '__proto__', 'constructor', '', 'anthropic:has space']) {
      assert.equal(parsePickerValue(value), null, value);
    }
  });
});

describe('choiceValue', () => {
  it('shows the device as the model its auto resolves to once the device is known, stepped down by the history', () => {
    assert.equal(choiceValue({ assistant: 'device', preference: 'auto' }, desktop), 'webgpu:qwen-3b');
    assert.equal(choiceValue({ assistant: 'device', preference: 'auto' }, cpu), 'wasm:qwen-0.5b');
    assert.equal(choiceValue({ assistant: 'device', preference: 'wasm:smollm2-135m' }, desktop), 'wasm:smollm2-135m');
    const slow = [{ ref: 'webgpu:qwen-3b', deviceClass: classifyDevice(desktop), tokPerSec: 4, failures: 0 }];
    assert.equal(choiceValue({ assistant: 'device', preference: 'auto' }, desktop, slow), 'webgpu:qwen-1.5b');
  });

  it('shows "device" before the probe and every other value as stored', () => {
    assert.equal(choiceValue({ assistant: 'device', preference: 'auto' }, null), 'device');
    assert.equal(choiceValue({ assistant: 'device', preference: 'webgpu:gemma-2b' }, null), 'device');
    for (const value of /** @type {const} */ (['auto', 'local:*', 'anthropic:claude-opus-5-5', `nvidia:${NVIDIA_DEFAULT_MODEL}`])) assert.equal(choiceValue({ assistant: value, preference: 'auto' }, desktop), value);
  });
});

describe('assistantGroups', () => {
  it('orders the groups and lists every on-device preset exactly once', () => {
    for (const hw of [desktop, cpu, pro, { ...desktop, isMobile: true }, null]) {
      const groups = assistantGroups(state({ hw }));
      assert.deepEqual(groups.map((g) => g.id), ['recommended', 'device', 'pools']);
      const values = groups.flatMap((g) => g.items.map((i) => i.value));
      assert.equal(new Set(values).size, values.length, 'values are unique');
      for (const ref of LOCAL_REFS) assert.equal(values.filter((v) => v === ref).length, 1, ref);
      assert.equal(groups[0].items[0].value, 'auto');
      assert.equal(groups[0].items[0].labelKey, 'chat-thread.picker.auto');
    }
  });

  it('recommends Auto, what the device runs best, a larger model on strong GPUs and the default free model', () => {
    const recommended = (/** @type {any} */ hw) => /** @type {any} */ (group(assistantGroups(state({ hw })), 'recommended')).items;
    assert.deepEqual(recommended(desktop).map((/** @type {any} */ i) => [i.value, i.recommended]), [['auto', undefined], ['webgpu:qwen-3b', 'auto'], [`nvidia:${NVIDIA_DEFAULT_MODEL}`, undefined]]);
    assert.deepEqual(recommended(pro).map((/** @type {any} */ i) => i.value), ['auto', 'webgpu:qwen-3b', 'webgpu:qwen-7b', `nvidia:${NVIDIA_DEFAULT_MODEL}`]);
    assert.equal(recommended(pro)[2].recommended, 'pro');
    assert.equal(recommended(cpu)[1].value, 'wasm:qwen-0.5b');
    // Without the site's pools nothing free is recommended.
    const none = /** @type {any} */ (group(assistantGroups(state({ pools: {} })), 'recommended')).items;
    assert.deepEqual(none.map((/** @type {any} */ i) => i.value), ['auto', 'webgpu:qwen-3b']);
    assert.equal(defaultPoolValue(state({ pools: null })), null);
  });

  it('suggests a larger model the history measured fast on this device', () => {
    const history = [{ ref: 'webgpu:qwen-7b', deviceClass: classifyDevice(desktop), tokPerSec: 41, failures: 0 }];
    const items = /** @type {any} */ (group(assistantGroups(state({ history })), 'recommended')).items;
    assert.deepEqual(items.find((/** @type {any} */ i) => i.recommended === 'measured')?.value, 'webgpu:qwen-7b');
  });

  it('lists the free models of the pools that have keys, and a provider group for every key of the user', () => {
    const pools = { nvidia: { configured: true, models: NVIDIA_IDS.slice(0, 3), defaultModel: NVIDIA_IDS[0] }, groq: { configured: true, models: [], defaultModel: null } };
    const groups = assistantGroups(state({ pools }));
    const free = /** @type {any} */ (group(groups, 'pools')).items;
    assert.ok(free.every((/** @type {any} */ i) => i.runtime === 'pool' && i.free === true));
    assert.ok(free.some((/** @type {any} */ i) => i.value === `groq:${POOLS.groq.defaultModel}`));
    assert.equal(free.filter((/** @type {any} */ i) => i.provider === 'nvidia').length + 1, 3, 'the default free model moved to the recommended group');

    // A key of the user's: its provider gets its own group, and the pool leaves its models to it.
    const keyed = assistantGroups(state({ pools, keyed: ['groq', 'anthropic'], models: { anthropic: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { id: 'claude-new', label: 'claude-new', unverified: true }], groq: [{ id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile' }] } }));
    assert.deepEqual(keyed.map((g) => g.id), ['recommended', 'device', 'pools', 'anthropic', 'groq']);
    assert.ok(/** @type {any} */ (group(keyed, 'pools')).items.every((/** @type {any} */ i) => i.provider !== 'groq'));
    assert.deepEqual(item(keyed, 'anthropic:claude-opus-5-5'), { value: 'anthropic:claude-opus-5-5', runtime: 'key', provider: 'anthropic', label: 'Claude Opus 5.5' });
    assert.equal(item(keyed, 'anthropic:claude-new').unverified, true);
    assert.deepEqual(groupLabel('anthropic'), { text: 'Anthropic' });
    assert.deepEqual(groupLabel('pools'), { key: GROUP_KEYS.pools });
    assert.ok(PROVIDER_GROUPS.every((id) => groupLabel(id).text));
  });

  it('shows the own server with its listed models and keeps a stored value nothing offers', () => {
    const groups = assistantGroups(state({ server: true, serverModels: ['llama3.2:3b', 'qwen3:8b'] }));
    assert.deepEqual(/** @type {any} */ (group(groups, 'server')).items.map((/** @type {any} */ i) => i.value), ['local:*', 'local:llama3.2:3b', 'local:qwen3:8b']);
    // A model that left a list, and a free model while the site has not answered.
    assert.ok(item(assistantGroups(state({ keyed: ['openai'], models: { openai: [] }, current: 'openai:gpt-old' })), 'openai:gpt-old'));
    assert.ok(item(assistantGroups(state({ pools: null, current: `nvidia:${NVIDIA_IDS[4]}` })), `nvidia:${NVIDIA_IDS[4]}`));
    assert.ok(item(assistantGroups(state({ current: 'local:qwen3:8b' })), 'local:qwen3:8b'));
  });

  it('labels presets from the catalogs with tier and download size and warns where they will not run well', () => {
    const groups = assistantGroups(state());
    assert.deepEqual(item(groups, 'webgpu:gemma-2b'), { value: 'webgpu:gemma-2b', runtime: 'webgpu', label: 'Gemma 2 2B', tier: 't2', sizeMB: 1500 });
    assert.deepEqual(item(groups, 'wasm:smollm2-135m'), { value: 'wasm:smollm2-135m', runtime: 'wasm', label: 'SmolLM2 135M', tier: 't1', sizeMB: 140 });
    const onCpu = assistantGroups(state({ hw: cpu }));
    for (const key of Object.keys(MODEL_CATALOG)) assert.equal(item(onCpu, `webgpu:${key}`).warning, 'needs-webgpu', key);
    for (const [hw, heavy] of /** @type {const} */ ([[desktop, true], [null, true], [pro, false]])) {
      const g = assistantGroups(state({ hw }));
      for (const [key, spec] of Object.entries(MODEL_CATALOG)) assert.equal(item(g, `webgpu:${key}`).warning, spec.tier === 't3' && heavy ? 'heavy' : undefined, key);
    }
  });
});

describe('optionParts', () => {
  const groups = assistantGroups(state({ hw: pro }));

  it('names the model, where it runs, its download, the recommendation and a warning, in that order', () => {
    assert.deepEqual(optionParts(item(groups, 'webgpu:qwen-3b')), [{ text: 'Qwen 2.5 3B' }, { key: 'models.runtime_webgpu' }, { key: 'models.download_size', gb: 1.9 }, { key: 'models.recommended' }]);
    assert.deepEqual(optionParts(item(groups, 'webgpu:qwen-7b')).at(-1), { key: 'models.pro_pick' });
    assert.deepEqual(optionParts(item(assistantGroups(state()), 'webgpu:gemma-9b')).at(-1), { key: 'models.warn_heavy' });
    assert.deepEqual(optionParts(item(groups, `nvidia:${NVIDIA_IDS[1]}`)), [{ text: NVIDIA_MODELS[1].label }, { key: 'chat-thread.picker.runtime_pool' }]);
    assert.deepEqual(optionParts(item(groups, 'auto')), [{ key: 'chat-thread.picker.auto' }]);
    assert.deepEqual(optionParts({ value: 'openai:x', runtime: 'key', label: 'x', unverified: true }), [{ text: 'x' }, { key: 'chat-thread.picker.unverified' }]);
  });

  it('only uses keys both locales define', async () => {
    const { hasKey } = await import('../../src/js/i18n/index.js');
    const keys = new Set(Object.values(GROUP_KEYS));
    for (const hw of [desktop, cpu, pro, null]) {
      for (const g of assistantGroups(state({ hw, server: true, keyed: ['openai'], models: { openai: [{ id: 'm', label: 'M', unverified: true }] } }))) {
        for (const part of g.items.flatMap(optionParts)) if ('key' in part) keys.add(part.key);
      }
    }
    for (const key of keys) for (const locale of ['en', 'de']) assert.ok(hasKey(key, locale), `${locale}:${key}`);
  });
});

describe('model names are catalog data', () => {
  it('never appear in the locale files', () => {
    const labels = [...Object.values(MODEL_CATALOG), ...Object.values(WASM_CATALOG), ...NVIDIA_MODELS].map((m) => m.label);
    for (const file of ['en.json', 'de.json', 'chat-thread/en.json', 'chat-thread/de.json']) {
      const dict = JSON.parse(readFileSync(new URL(`../../src/locales/${file}`, import.meta.url), 'utf8'));
      /** @type {Array<[string, string]>} */
      const entries = [];
      /** @param {Record<string, unknown>} obj @param {string} prefix */
      const walk = (obj, prefix) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v && typeof v === 'object') walk(/** @type {Record<string, unknown>} */ (v), `${prefix}${k}.`);
          else entries.push([`${prefix}${k}`, String(v)]);
        }
      };
      walk(dict, '');
      for (const [key, value] of entries) for (const label of labels) assert.ok(!value.includes(label), `${file}:${key} contains "${label}"`);
    }
  });
});
