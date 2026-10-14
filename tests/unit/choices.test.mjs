// Picker values and option groups (src/js/models/choices.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { assistantGroups, choiceValue, GROUP_KEYS, nvidiaStatus, optionParts, parseAssistantChoice } from '../../src/js/models/choices.js';
import { GIB } from '../../src/js/models/device.js';
import { NVIDIA_DEFAULT_MODEL, NVIDIA_MODELS } from '../../src/js/models/nvidia-catalog.js';
import { WASM_CATALOG } from '../../src/js/models/wasm-catalog.js';
import { MODEL_CATALOG } from '../../src/js/webgpu/models.js';

const NVIDIA_IDS = NVIDIA_MODELS.map((m) => m.id);
const desktop = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 2 * GIB, hasF16: true };
const cpu = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 0, hasF16: false, webgpu: false };
const pro = { ...desktop, vendor: 'nvidia', maxStorageBufferBindingSize: 2 * GIB };
const LOCAL_REFS = [...Object.keys(MODEL_CATALOG).map((k) => `webgpu:${k}`), ...Object.keys(WASM_CATALOG).map((k) => `wasm:${k}`)];

/** @param {Partial<import('../../src/js/models/choices.js').NvidiaStatus>} [patch] */
const nvidia = (patch) => ({ state: 'configured', ids: NVIDIA_IDS, defaultModel: NVIDIA_DEFAULT_MODEL, currentMode: 'council', currentId: NVIDIA_DEFAULT_MODEL, ...patch });
const group = (groups, id) => groups.find((g) => g.id === id);
const item = (groups, value) => groups.flatMap((g) => g.items).find((i) => i.value === value);

describe('parseAssistantChoice', () => {
  it('maps modes, local refs and allowlisted NVIDIA models', () => {
    for (const mode of ['council', 'local', 'client', 'nvidia']) assert.deepEqual(parseAssistantChoice(mode, NVIDIA_IDS), { mode });
    assert.deepEqual(parseAssistantChoice('webgpu:qwen-3b', NVIDIA_IDS), { mode: 'client', local: 'webgpu:qwen-3b' });
    assert.deepEqual(parseAssistantChoice('wasm:smollm2-135m', NVIDIA_IDS), { mode: 'client', local: 'wasm:smollm2-135m' });
    assert.deepEqual(parseAssistantChoice(`nvidia:${NVIDIA_IDS[1]}`, NVIDIA_IDS), { mode: 'nvidia', nvidia: NVIDIA_IDS[1] });
  });

  it('rejects values the pickers never offer', () => {
    for (const value of ['nvidia:openai/not-listed', 'nvidia:', 'webgpu:bogus', 'wasm:qwen-3b', 'qwen-3b', 'auto', '__proto__', 'constructor', '']) {
      assert.equal(parseAssistantChoice(value, NVIDIA_IDS), null, value);
    }
    assert.equal(parseAssistantChoice(`nvidia:${NVIDIA_IDS[0]}`, []), null);
  });
});

describe('choiceValue', () => {
  const state = { mode: 'client', local: 'auto', nvidia: NVIDIA_DEFAULT_MODEL };
  it('shows auto as the model it resolves to once the device is known', () => {
    assert.equal(choiceValue(state, desktop), 'webgpu:qwen-3b');
    assert.equal(choiceValue(state, cpu), 'wasm:qwen-0.5b');
    assert.equal(choiceValue({ ...state, local: 'wasm:smollm2-135m' }, desktop), 'wasm:smollm2-135m');
  });

  it('shows the bare mode before the device probe', () => {
    assert.equal(choiceValue(state, null), 'client');
    assert.equal(choiceValue({ ...state, local: 'webgpu:gemma-2b' }, null), 'client');
    assert.equal(choiceValue({ ...state, mode: 'nvidia' }, null), 'nvidia');
  });

  it('names the NVIDIA model and keeps the other modes', () => {
    assert.equal(choiceValue({ ...state, mode: 'nvidia' }, desktop), `nvidia:${NVIDIA_DEFAULT_MODEL}`);
    assert.equal(choiceValue({ ...state, mode: 'council' }, desktop), 'council');
    assert.equal(choiceValue({ ...state, mode: 'local' }, desktop), 'local');
  });
});

describe('assistantGroups', () => {
  it('orders the groups and lists every local preset exactly once', () => {
    for (const hw of [desktop, cpu, pro, { ...desktop, isMobile: true }, null]) {
      const groups = assistantGroups(hw, nvidia());
      assert.deepEqual(groups.map((g) => g.id), hw ? ['recommended', 'local', 'nvidia', 'other'] : ['local', 'nvidia', 'other']);
      const values = groups.flatMap((g) => g.items.map((i) => i.value));
      assert.equal(new Set(values).size, values.length, 'values are unique');
      for (const ref of LOCAL_REFS) assert.equal(values.filter((v) => v === ref).length, 1, ref);
      assert.deepEqual(group(groups, 'other').items.map((i) => i.value), ['council', 'local']);
      assert.deepEqual(group(groups, 'other').items.map((i) => i.labelKey), ['engine.mode_cloud', 'engine.mode_server']);
    }
  });

  it('recommends what auto picks, a larger model on strong GPUs and the default NVIDIA model', () => {
    const recommended = (hw) => group(assistantGroups(hw, nvidia()), 'recommended').items;
    assert.deepEqual(recommended(desktop).map((i) => [i.value, i.recommended]), [['webgpu:qwen-3b', 'auto'], [`nvidia:${NVIDIA_DEFAULT_MODEL}`, undefined]]);
    assert.deepEqual(recommended(pro).map((i) => i.value), ['webgpu:qwen-3b', 'webgpu:qwen-7b', `nvidia:${NVIDIA_DEFAULT_MODEL}`]);
    assert.equal(recommended(pro)[1].recommended, 'pro');
    assert.equal(recommended(cpu)[0].value, 'wasm:qwen-0.5b');
    const unconfigured = group(assistantGroups(desktop, nvidia({ state: 'unconfigured' })), 'recommended').items;
    assert.deepEqual(unconfigured.map((i) => i.value), ['webgpu:qwen-3b']);
  });

  it('labels presets from the catalogs with tier and download size', () => {
    const groups = assistantGroups(desktop, nvidia());
    assert.deepEqual(item(groups, 'webgpu:gemma-2b'), { value: 'webgpu:gemma-2b', runtime: 'webgpu', label: 'Gemma 2 2B', tier: 't2', sizeMB: 1500 });
    assert.deepEqual(item(groups, 'wasm:smollm2-135m'), { value: 'wasm:smollm2-135m', runtime: 'wasm', label: 'SmolLM2 135M', tier: 't1', sizeMB: 140 });
    assert.deepEqual(item(groups, `nvidia:${NVIDIA_IDS[1]}`), { value: `nvidia:${NVIDIA_IDS[1]}`, runtime: 'nvidia', label: NVIDIA_MODELS[1].label });
  });

  it('warns about WebGPU models without WebGPU and about T3 models without a strong GPU', () => {
    const onCpu = assistantGroups(cpu, nvidia());
    for (const key of Object.keys(MODEL_CATALOG)) {
      const entry = item(onCpu, `webgpu:${key}`);
      assert.equal(entry.warning, 'needs-webgpu', key);
      assert.equal(entry.disabled, undefined, `${key} stays selectable and explains itself when picked`);
    }
    for (const key of Object.keys(WASM_CATALOG)) assert.equal(item(onCpu, `wasm:${key}`).warning, undefined, key);
    for (const [hw, heavy] of [[desktop, true], [null, true], [pro, false]]) {
      const groups = assistantGroups(hw, nvidia());
      for (const [key, spec] of Object.entries(MODEL_CATALOG)) {
        assert.equal(item(groups, `webgpu:${key}`).warning, spec.tier === 't3' && heavy ? 'heavy' : undefined, `${key} on ${JSON.stringify(hw)}`);
      }
    }
  });

  it('shows the NVIDIA group as the server reports it', () => {
    const nvidiaGroup = (status) => group(assistantGroups(desktop, nvidia(status)), 'nvidia');
    // Configured: the server's models in catalog order, enabled.
    const configured = nvidiaGroup({ ids: [NVIDIA_IDS[3], NVIDIA_IDS[2], 'vendor/unknown'] });
    assert.deepEqual(configured.items.map((i) => i.value), [`nvidia:${NVIDIA_IDS[2]}`, `nvidia:${NVIDIA_IDS[3]}`]);
    assert.ok(configured.items.every((i) => !i.disabled));
    // Reachable without keys: every model disabled with a reason.
    const unconfigured = nvidiaGroup({ state: 'unconfigured' });
    assert.equal(unconfigured.items.length, NVIDIA_IDS.length);
    assert.ok(unconfigured.items.every((i) => i.disabled === true && i.warning === 'not-configured'));
    // No models offered, or not asked yet / no route, while another mode is active: no group.
    assert.equal(nvidiaGroup({ ids: [] }), undefined);
    assert.equal(nvidiaGroup({ state: 'pending' }), undefined);
    assert.equal(nvidiaGroup({ state: 'absent' }), undefined);
  });

  it('keeps a selected NVIDIA model visible whatever the server says', () => {
    const selected = NVIDIA_IDS[4];
    const status = (state, ids = NVIDIA_IDS) => nvidia({ state, ids, currentMode: 'nvidia', currentId: selected });
    const items = (state, ids) => group(assistantGroups(desktop, status(state, ids)), 'nvidia').items;
    assert.deepEqual(items('pending'), [{ value: `nvidia:${selected}`, runtime: 'nvidia', label: NVIDIA_MODELS[4].label }]);
    assert.deepEqual(items('absent'), [{ value: `nvidia:${selected}`, runtime: 'nvidia', label: NVIDIA_MODELS[4].label, warning: 'not-configured', disabled: true }]);
    assert.deepEqual(items('configured', [NVIDIA_IDS[1]]).map((i) => i.value), [`nvidia:${NVIDIA_IDS[1]}`, `nvidia:${selected}`]);
  });
});

describe('nvidiaStatus', () => {
  const current = { mode: 'nvidia', local: 'auto', nvidia: NVIDIA_IDS[2] };
  const offered = { reachable: true, configured: true, defaultModel: NVIDIA_IDS[1], models: NVIDIA_IDS.slice(0, 3).map((id) => ({ id })) };

  it('is pending until the proxy answers, and names the bundled default meanwhile', () => {
    assert.deepEqual(nvidiaStatus(null, current), { state: 'pending', ids: [], defaultModel: NVIDIA_DEFAULT_MODEL, currentMode: 'nvidia', currentId: NVIDIA_IDS[2] });
  });

  it('tells a missing proxy, a proxy without keys and a ready one apart', () => {
    assert.equal(nvidiaStatus({ ...offered, reachable: false, configured: false, models: [] }, current).state, 'absent');
    assert.equal(nvidiaStatus({ ...offered, configured: false }, current).state, 'unconfigured');
    const ready = nvidiaStatus(offered, { ...current, mode: 'council' });
    assert.deepEqual(ready, { state: 'configured', ids: NVIDIA_IDS.slice(0, 3), defaultModel: NVIDIA_IDS[1], currentMode: 'council', currentId: NVIDIA_IDS[2] });
    assert.equal(nvidiaStatus({ ...offered, defaultModel: null }, current).defaultModel, NVIDIA_DEFAULT_MODEL);
  });

  it('feeds assistantGroups: the recommended NVIDIA entry is the proxy default', () => {
    const groups = assistantGroups(desktop, nvidiaStatus(offered, { ...current, mode: 'council' }));
    assert.deepEqual(group(groups, 'recommended').items.at(-1)?.value, `nvidia:${NVIDIA_IDS[1]}`);
    assert.deepEqual(group(groups, 'nvidia').items.map((i) => i.value), [`nvidia:${NVIDIA_IDS[0]}`, `nvidia:${NVIDIA_IDS[2]}`]);
    // No proxy here: the group is gone unless NVIDIA is the current mode.
    const absent = { reachable: false, configured: false, defaultModel: null, models: [] };
    assert.equal(group(assistantGroups(desktop, nvidiaStatus(absent, { ...current, mode: 'council' })), 'nvidia'), undefined);
    assert.deepEqual(group(assistantGroups(desktop, nvidiaStatus(absent, current)), 'nvidia').items.map((i) => [i.value, i.disabled]), [[`nvidia:${NVIDIA_IDS[2]}`, true]]);
  });
});

describe('optionParts', () => {
  const groups = assistantGroups(desktop, nvidia());

  it('names the model, where it runs, its download, the recommendation and a warning, in that order', () => {
    assert.deepEqual(optionParts(item(groups, 'webgpu:qwen-3b')), [
      { text: 'Qwen 2.5 3B' },
      { key: 'models.runtime_webgpu' },
      { key: 'models.download_size', gb: 1.9 },
      { key: 'models.recommended' },
    ]);
    assert.deepEqual(optionParts(item(groups, 'webgpu:gemma-9b')), [
      { text: 'Gemma 2 9B' },
      { key: 'models.runtime_webgpu' },
      { key: 'models.download_size', gb: 5.3 },
      { key: 'models.warn_heavy' },
    ]);
    assert.deepEqual(optionParts(item(groups, 'wasm:smollm2-135m')), [{ text: 'SmolLM2 135M' }, { key: 'models.runtime_wasm' }, { key: 'models.download_size', gb: 0.14 }]);
    assert.deepEqual(optionParts(item(assistantGroups(pro, nvidia()), 'webgpu:qwen-7b')).at(-1), { key: 'models.pro_pick' });
    assert.deepEqual(optionParts(item(assistantGroups(cpu, nvidia()), 'webgpu:llama-1b')).at(-1), { key: 'models.warn_needs_webgpu' });
  });

  it('gives NVIDIA models no download and marks them when the proxy has no keys', () => {
    assert.deepEqual(optionParts(item(groups, `nvidia:${NVIDIA_IDS[1]}`)), [{ text: NVIDIA_MODELS[1].label }, { key: 'models.runtime_nvidia' }]);
    const unconfigured = assistantGroups(desktop, nvidia({ state: 'unconfigured' }));
    assert.deepEqual(optionParts(item(unconfigured, `nvidia:${NVIDIA_IDS[1]}`)), [
      { text: NVIDIA_MODELS[1].label },
      { key: 'models.runtime_nvidia' },
      { key: 'models.warn_not_configured' },
    ]);
  });

  it('uses a single key for the other assistants', () => {
    assert.deepEqual(optionParts(item(groups, 'council')), [{ key: 'engine.mode_cloud' }]);
    assert.deepEqual(optionParts(item(groups, 'local')), [{ key: 'engine.mode_server' }]);
  });

  it('only uses keys both locales define, with the placeholders the parts fill', async () => {
    const { hasKey, t } = await import('../../src/js/i18n/index.js');
    const keys = new Set(Object.values(GROUP_KEYS));
    for (const hw of [desktop, cpu, pro, null]) {
      for (const state of ['configured', 'unconfigured']) {
        for (const g of assistantGroups(hw, nvidia({ state }))) {
          for (const part of g.items.flatMap(optionParts)) if ('key' in part) keys.add(part.key);
        }
      }
    }
    assert.deepEqual(Object.keys(GROUP_KEYS), ['recommended', 'local', 'nvidia', 'other']);
    for (const key of keys) {
      for (const locale of ['en', 'de']) assert.ok(hasKey(key, locale), `${locale}:${key}`);
    }
    assert.equal(t('models.download_size', { gb: '1.9' }, 'en'), '1.9 GB download');
    assert.equal(t('models.group_recommended', undefined, 'de'), 'Empfohlen für Ihr Gerät');
  });
});

describe('model names are catalog data', () => {
  it('never appear in the locale files', () => {
    const labels = [...Object.values(MODEL_CATALOG), ...Object.values(WASM_CATALOG), ...NVIDIA_MODELS].map((m) => m.label);
    for (const locale of ['en', 'de']) {
      const dict = JSON.parse(readFileSync(new URL(`../../src/locales/${locale}.json`, import.meta.url), 'utf8'));
      /** @type {Array<[string, string]>} */
      const entries = [];
      const walk = (obj, prefix) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v && typeof v === 'object') walk(v, `${prefix}${k}.`);
          else entries.push([`${prefix}${k}`, String(v)]);
        }
      };
      walk(dict, '');
      for (const [key, value] of entries) for (const label of labels) assert.ok(!value.includes(label), `${locale}:${key} contains "${label}"`);
    }
  });
});
