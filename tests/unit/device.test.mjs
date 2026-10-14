// Device classes, model recommendations and hardware badges (src/js/models/device.js).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { hasKey, LOCALES } from '../../src/js/i18n/index.js';
import { classifyDevice, GIB, hardwareBadges, recommendModels } from '../../src/js/models/device.js';

const desktop = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 2 * GIB, hasF16: true };
const cpu = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 0, hasF16: false, webgpu: false };
const pro = { ...desktop, vendor: 'apple', maxStorageBufferBindingSize: 2 * GIB };

describe('classifyDevice', () => {
  const cases = [
    ['no WebGPU', cpu, 'cpu-only'],
    ['no WebGPU on a phone', { ...cpu, isMobile: true }, 'cpu-only'],
    ['phone', { ...desktop, isMobile: true }, 'mobile'],
    ['phone with a strong GPU', { ...pro, isMobile: true }, 'mobile'],
    ['256 MiB buffer', { ...desktop, maxBufferSize: 256 * 1024 ** 2 }, 'low'],
    ['4 GB RAM', { ...desktop, deviceMemoryGB: 4 }, 'low'],
    ['4 GB RAM and a strong GPU', { ...pro, deviceMemoryGB: 4 }, 'low'],
    ['memory hidden', { ...desktop, deviceMemoryGB: null }, 'laptop'],
    ['8 GB RAM', desktop, 'desktop'],
    ['Apple silicon', pro, 'desktop-pro'],
    ['Apple silicon, memory hidden', { ...pro, deviceMemoryGB: null }, 'desktop-pro'],
    ['vendor in upper case', { ...pro, vendor: 'NVIDIA' }, 'desktop-pro'],
    ['Intel GPU', { ...pro, vendor: 'intel' }, 'desktop'],
    ['NVIDIA without shader-f16', { ...pro, vendor: 'nvidia', hasF16: false }, 'desktop'],
    ['AMD with a small binding size', { ...pro, vendor: 'amd', maxStorageBufferBindingSize: 128 * 1024 ** 2 }, 'desktop'],
  ];
  for (const [name, hw, expected] of cases) {
    it(`${name} -> ${expected}`, () => assert.equal(classifyDevice(hw), expected));
  }
});

describe('recommendModels', () => {
  const cases = [
    [cpu, 'cpu-only', 'wasm:qwen-0.5b'],
    [{ ...cpu, deviceMemoryGB: null }, 'cpu-only', 'wasm:qwen-0.5b'],
    [{ ...cpu, deviceMemoryGB: 2 }, 'cpu-only', 'wasm:smollm2-360m'],
    [{ ...cpu, isMobile: true }, 'cpu-only', 'wasm:smollm2-360m'],
    [{ ...cpu, deviceMemoryGB: 1 }, 'cpu-only', 'wasm:smollm2-135m'],
    [{ ...desktop, isMobile: true }, 'mobile', 'webgpu:llama-1b'],
    [{ ...desktop, deviceMemoryGB: 4 }, 'low', 'webgpu:llama-1b'],
    [{ ...desktop, deviceMemoryGB: null }, 'laptop', 'webgpu:qwen-1.5b'],
    [desktop, 'desktop', 'webgpu:qwen-3b'],
    [pro, 'desktop-pro', 'webgpu:qwen-3b'],
    [{ ...pro, deviceMemoryGB: null }, 'desktop-pro', 'webgpu:qwen-1.5b'],
  ];
  it('resolves auto per device class', () => {
    for (const [hw, cls, local] of cases) {
      const rec = recommendModels(hw);
      assert.equal(rec.cls, cls, JSON.stringify(hw));
      assert.equal(rec.local, local, JSON.stringify(hw));
      assert.equal(rec.pro, cls === 'desktop-pro' ? 'webgpu:qwen-7b' : null, JSON.stringify(hw));
    }
  });
});

describe('hardwareBadges', () => {
  it('names the runtime, the memory and the device class', () => {
    assert.deepEqual(hardwareBadges({ ...cpu, deviceMemoryGB: null }), [
      { key: 'models.badge_cpu_only' },
      { key: 'models.badge_memory_hidden' },
      { key: 'models.class_cpu_only' },
    ]);
    assert.deepEqual(hardwareBadges(desktop), [
      { key: 'models.badge_webgpu_f16' },
      { key: 'models.badge_memory', params: { gb: '8' } },
      { key: 'models.class_desktop' },
    ]);
    assert.equal(hardwareBadges({ ...desktop, hasF16: false })[0].key, 'models.badge_webgpu');
  });

  it('uses keys that exist in every locale', () => {
    const profiles = [cpu, { ...cpu, deviceMemoryGB: null }, desktop, { ...desktop, hasF16: false }, { ...desktop, isMobile: true }];
    profiles.push({ ...desktop, deviceMemoryGB: 4 }, { ...desktop, deviceMemoryGB: null }, pro);
    const keys = new Set(profiles.flatMap((hw) => hardwareBadges(hw).map((b) => b.key)));
    assert.equal(keys.size, 11);
    for (const locale of LOCALES) for (const key of keys) assert.ok(hasKey(key, locale), `${key} missing in ${locale}`);
  });
});

describe('pure model modules', () => {
  it('touch no browser globals, so they run in Node, workers and the page', () => {
    for (const file of ['device.js', 'wasm-catalog.js', 'choices.js']) {
      const code = readFileSync(new URL(`../../src/js/models/${file}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, '');
      assert.doesNotMatch(code, /\b(navigator|document|window|caches|self|location)\b/, file);
    }
  });
});
