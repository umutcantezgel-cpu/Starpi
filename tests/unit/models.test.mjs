import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { prebuiltAppConfig } from '@mlc-ai/web-llm';
import { WASM_CATALOG } from '../../src/js/models/wasm-catalog.js';
import {
  ALL_MODEL_IDS,
  budgetPrompt,
  chooseModel,
  detectMobile,
  MODEL_CATALOG,
  normalizePreference,
} from '../../src/js/webgpu/models.js';

const GIB = 1024 ** 3;
const desktop = { isMobile: false, deviceMemoryGB: 16, maxBufferSize: 2 * GIB, hasF16: true };
const byId = new Map(prebuiltAppConfig.model_list.map((m) => [m.model_id, m]));

describe('model catalog', () => {
  it('only references models that exist in the pinned WebLLM prebuilt list', () => {
    assert.equal(ALL_MODEL_IDS.length, 26);
    for (const id of ALL_MODEL_IDS) assert.ok(byId.has(id), `${id} is not a WebLLM prebuilt model`);
  });

  it('provides an f32 fallback for every model', () => {
    for (const spec of Object.values(MODEL_CATALOG)) {
      assert.match(spec.f16, /q4f16_1/);
      assert.match(spec.f32, /q4f32_1/);
      assert.equal(spec.f32, spec.f16.replace('q4f16_1', 'q4f32_1'));
    }
  });

  it('states the VRAM of the pinned WebLLM catalog', () => {
    for (const [key, spec] of Object.entries(MODEL_CATALOG)) {
      assert.equal(spec.vramMB.f16, Math.round(byId.get(spec.f16).vram_required_MB), `${key}: f16 VRAM`);
      assert.equal(spec.vramMB.f32, Math.round(byId.get(spec.f32).vram_required_MB), `${key}: f32 VRAM`);
    }
  });

  it('keeps every tier in its memory class', () => {
    for (const [key, spec] of Object.entries(MODEL_CATALOG)) {
      if (spec.tier === 't1') {
        assert.equal(byId.get(spec.f16).low_resource_required, true, `${key}: T1 must be a low-resource build`);
        assert.ok(spec.vramMB.f16 < 2048, `${key}: T1 needs less than 2 GB`);
      } else if (spec.tier === 't2') {
        assert.ok(spec.vramMB.f16 < 4096, `${key}: T2 needs less than 4 GB`);
      } else {
        assert.equal(spec.tier, 't3', key);
        assert.ok(spec.vramMB.f16 >= 4096, `${key}: T3 needs at least 4 GB`);
      }
    }
  });

  it('never requests more context than WebLLM compiled for', () => {
    for (const hw of [desktop, { ...desktop, isMobile: true }, { ...desktop, deviceMemoryGB: null }, { ...desktop, hasF16: false }]) {
      for (const key of Object.keys(MODEL_CATALOG)) {
        const c = chooseModel(hw, `webgpu:${key}`);
        const limit = byId.get(c.modelId).overrides?.context_window_size;
        assert.ok(limit === undefined || c.chatOptions.context_window_size <= limit, `${c.modelId}: context ${c.chatOptions.context_window_size} exceeds ${limit}`);
        assert.ok(c.chatOptions.prefill_chunk_size <= c.chatOptions.context_window_size, `${key}: prefill`);
        assert.ok(c.maxOutputTokens < c.chatOptions.context_window_size / 2, `${key}: output budget`);
      }
    }
  });

  it('keeps preset keys out of the i18n key pattern', () => {
    // A key like 'qwen2.5-3b' after a ternary would be read as an i18n key by tests/unit/i18n.test.mjs.
    for (const key of [...Object.keys(MODEL_CATALOG), ...Object.keys(WASM_CATALOG)]) assert.doesNotMatch(key, /^[a-z]\w*\./, key);
  });
});

describe('README WebGPU model table', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const num = (/** @type {string} */ s) => Number(s.replaceAll(',', ''));
  // | T2 | `qwen-3b` (desktop default, …) | `…` / `…` | 1.9 GB | 2,505 MB / 2,894 MB | 4,096 |
  const rows = new Map(
    [...readme.matchAll(/^\| (T[123]) \| `([\w.-]+)`[^|]*\|[^|]*\| ([\d.]+) GB \| ([\d,]+) MB \/ ([\d,]+) MB \| ([\d,]+) \|$/gm)].map(
      ([, tier, key, gb, f16, f32, ctx]) => [key, { tier, gb: Number(gb), f16: num(f16), f32: num(f32), ctx: num(ctx) }],
    ),
  );

  it('has one row per preset', () => {
    assert.deepEqual([...rows.keys()].sort(), Object.keys(MODEL_CATALOG).sort());
  });

  it('states the tier, VRAM, download size and the context window the app requests', () => {
    for (const [key, spec] of Object.entries(MODEL_CATALOG)) {
      const row = rows.get(key);
      assert.ok(row, key);
      assert.equal(row.tier, spec.tier.toUpperCase(), `${key}: tier`);
      assert.equal(row.f16, spec.vramMB.f16, `${key}: f16 VRAM`);
      assert.equal(row.f32, spec.vramMB.f32, `${key}: f32 VRAM`);
      assert.equal(row.gb, spec.approxDownloadMB / 1000, `${key}: download size`);
      assert.equal(row.ctx, chooseModel(desktop, `webgpu:${key}`).chatOptions.context_window_size, `${key}: context window`);
    }
  });
});

describe('normalizePreference', () => {
  it('migrates 2.0 keys to WebGPU refs and keeps catalog refs', () => {
    assert.equal(normalizePreference('qwen-3b'), 'webgpu:qwen-3b');
    assert.equal(normalizePreference('llama-1b'), 'webgpu:llama-1b');
    assert.equal(normalizePreference('webgpu:gemma-9b'), 'webgpu:gemma-9b');
    assert.equal(normalizePreference('wasm:smollm2-360m'), 'wasm:smollm2-360m');
    assert.equal(normalizePreference('auto'), 'auto');
  });

  it('maps everything else to auto', () => {
    for (const value of ['wasm:qwen-3b', 'webgpu:smollm2-135m', 'webgpu:__proto__', 'wasm:constructor', 'nvidia:openai/gpt-oss-20b', 'deepseek-r1', '__proto__', 'webgpu:', '', null, undefined, 3]) {
      assert.equal(normalizePreference(value), 'auto', String(value));
    }
  });
});

describe('chooseModel', () => {
  it('picks the 3B model on capable desktops', () => {
    const c = chooseModel(desktop, 'auto');
    assert.equal(c.key, 'qwen-3b');
    assert.equal(c.runtime, 'webgpu');
    assert.equal(c.ref, 'webgpu:qwen-3b');
    assert.equal(c.modelId, MODEL_CATALOG['qwen-3b'].f16);
    assert.deepEqual(c.chatOptions, { context_window_size: 4096, prefill_chunk_size: 512 });
    assert.equal(c.vramMB, 2505);
    assert.equal(c.maxOutputTokens, 512);
    assert.equal(c.reason, 'auto');
  });

  it('is conservative when device memory is hidden (Safari/Firefox)', () => {
    assert.equal(chooseModel({ ...desktop, deviceMemoryGB: null }, 'auto').key, 'qwen-1.5b');
    // Also on a strong GPU: auto keeps the pick of earlier versions, so a cached model is reused.
    const apple = { ...desktop, deviceMemoryGB: null, vendor: 'apple', maxStorageBufferBindingSize: 2 * GIB };
    assert.equal(chooseModel(apple, 'auto').key, 'qwen-1.5b');
  });

  it('uses the compact model on mobile and small adapters', () => {
    const mobile = chooseModel({ ...desktop, isMobile: true }, 'auto');
    assert.equal(mobile.key, 'llama-1b');
    assert.deepEqual(mobile.chatOptions, { context_window_size: 2048, prefill_chunk_size: 128 });
    assert.equal(chooseModel({ ...desktop, maxBufferSize: 256 * 1024 ** 2 }, 'auto').key, 'llama-1b');
    assert.equal(chooseModel({ ...desktop, deviceMemoryGB: 4 }, 'auto').key, 'llama-1b');
  });

  it('falls back to f32 kernels without shader-f16', () => {
    const c = chooseModel({ ...desktop, hasF16: false }, 'auto');
    assert.equal(c.modelId, MODEL_CATALOG['qwen-3b'].f32);
    assert.equal(c.f16, false);
    assert.equal(c.vramMB, 2894);
  });

  it('honours manual preferences, also stored 2.0 keys', () => {
    for (const pref of ['qwen-3b', 'webgpu:qwen-3b']) {
      const c = chooseModel({ ...desktop, isMobile: true }, pref);
      assert.equal(c.key, 'qwen-3b');
      assert.equal(c.reason, 'manual');
      assert.deepEqual(c.chatOptions, { context_window_size: 2048, prefill_chunk_size: 128 });
    }
    assert.equal(chooseModel(desktop, 'webgpu:gemma-9b').tier, 't3');
  });

  it('runs a processor (WASM) model when the device has no WebGPU', () => {
    const cpu = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 0, hasF16: false, webgpu: false };
    const c = chooseModel(cpu, 'auto');
    assert.equal(c.runtime, 'wasm');
    assert.equal(c.key, 'qwen-0.5b');
    assert.equal(c.ref, 'wasm:qwen-0.5b');
    assert.equal(c.modelId, WASM_CATALOG['qwen-0.5b'].repo);
    assert.equal(c.vramMB, null);
    assert.equal(c.f16, false);
    assert.equal(c.chatOptions.context_window_size, 2048);
    assert.equal(c.maxOutputTokens, 384);
    assert.equal(c.wasm?.revision, WASM_CATALOG['qwen-0.5b'].revision);
    assert.equal(chooseModel({ ...cpu, isMobile: true }, 'auto').key, 'smollm2-360m');
    assert.equal(chooseModel({ ...cpu, deviceMemoryGB: 1 }, 'auto').key, 'smollm2-135m');
  });

  it('keeps an explicit runtime: WASM on a WebGPU device, WebGPU on a device without it', () => {
    const wasm = chooseModel(desktop, 'wasm:smollm2-135m');
    assert.equal(wasm.runtime, 'wasm');
    assert.equal(wasm.reason, 'manual');
    // The engine reports this one as unsupported instead of silently switching runtimes.
    const gpu = chooseModel({ ...desktop, webgpu: false, hasF16: true }, 'webgpu:llama-1b');
    assert.equal(gpu.runtime, 'webgpu');
    assert.equal(gpu.f16, false);
  });

  it('never picks a T3 preset automatically', () => {
    const profiles = [];
    for (const webgpu of [true, false]) {
      for (const isMobile of [false, true]) {
        for (const deviceMemoryGB of [null, 0.5, 2, 4, 8]) {
          for (const vendor of ['apple', 'nvidia', 'amd', 'intel', '']) {
            profiles.push({ webgpu, isMobile, deviceMemoryGB, vendor, hasF16: true, maxBufferSize: 4 * GIB, maxStorageBufferBindingSize: 4 * GIB });
          }
        }
      }
    }
    for (const hw of profiles) assert.notEqual(chooseModel(hw, 'auto').tier, 't3', JSON.stringify(hw));
  });
});

describe('detectMobile', () => {
  it('prefers userAgentData and falls back to the UA string', () => {
    assert.equal(detectMobile({ userAgent: 'Mozilla/5.0 (iPhone)', userAgentDataMobile: false }), false);
    assert.equal(detectMobile({ userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile' }), true);
    assert.equal(detectMobile({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), false);
  });
});

describe('budgetPrompt', () => {
  it('fits everything into the context window and keeps the newest history', () => {
    const big = 'x'.repeat(50_000);
    const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'y'.repeat(500)}` }));
    const out = budgetPrompt({ contextWindow: 2048, maxOutputTokens: 512, system: 'sys', context: big, history, user: big });
    const total = out.system.length + out.context.length + out.user.length + out.history.reduce((n, m) => n + m.content.length, 0);
    assert.ok(total <= (2048 - 512 - 128) * 3, `prompt too large: ${total}`);
    assert.ok(out.user.length > 0 && out.context.length > 0);
    if (out.history.length > 0) assert.match(out.history.at(-1).content, /^turn 9/);
  });

  it('passes small prompts through unchanged', () => {
    const out = budgetPrompt({ contextWindow: 4096, maxOutputTokens: 512, system: 'sys', context: 'ctx', history: [{ role: 'user', content: 'hi' }], user: 'q' });
    assert.deepEqual(out, { system: 'sys', context: 'ctx', user: 'q', history: [{ role: 'user', content: 'hi' }] });
  });

  it('turnChars widens the per-turn history cap', () => {
    const history = [{ role: /** @type {const} */ ('user'), content: 'z'.repeat(1_500) }];
    const input = { contextWindow: 4096, maxOutputTokens: 768, system: 'sys', context: '', history, user: 'q' };
    assert.equal(budgetPrompt(input).history[0].content, `${'z'.repeat(599)}…`);
    assert.equal(budgetPrompt({ ...input, turnChars: 2_000 }).history[0].content, history[0].content);
    assert.equal(budgetPrompt({ ...input, turnChars: 1_000 }).history[0].content.length, 1_000);
  });
});
