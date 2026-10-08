import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { prebuiltAppConfig } from '@mlc-ai/web-llm';
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

describe('model catalog', () => {
  it('only references models that exist in the pinned WebLLM prebuilt list', () => {
    const known = new Set(prebuiltAppConfig.model_list.map((m) => m.model_id));
    for (const id of ALL_MODEL_IDS) assert.ok(known.has(id), `${id} is not a WebLLM prebuilt model`);
  });

  it('provides an f32 fallback for every model', () => {
    for (const spec of Object.values(MODEL_CATALOG)) {
      assert.match(spec.f16, /q4f16_1/);
      assert.match(spec.f32, /q4f32_1/);
    }
  });
});

describe('README model table', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const num = (/** @type {string} */ s) => Number(s.replaceAll(',', ''));
  // | `qwen-3b` (desktop default, …) | `…` / `…` | 1.9 GB | 2,505 MB / 2,894 MB | 4,096 |
  const rows = new Map(
    [...readme.matchAll(/^\| `([\w.-]+)`[^|]*\|[^|]*\| ([\d.]+) GB \| ([\d,]+) MB \/ ([\d,]+) MB \| ([\d,]+) \|$/gm)].map(
      ([, key, gb, f16, f32, ctx]) => [key, { gb: Number(gb), f16: num(f16), f32: num(f32), ctx: num(ctx) }],
    ),
  );
  const byId = new Map(prebuiltAppConfig.model_list.map((m) => [m.model_id, m]));

  it('has one row per preset', () => {
    assert.deepEqual([...rows.keys()].sort(), Object.keys(MODEL_CATALOG).sort());
  });

  it('states the VRAM of the pinned WebLLM catalog and the context window the app requests', () => {
    for (const [key, spec] of Object.entries(MODEL_CATALOG)) {
      const row = rows.get(key);
      assert.ok(row, key);
      const f16 = byId.get(spec.f16);
      const f32 = byId.get(spec.f32);
      assert.equal(row.f16, Math.round(f16.vram_required_MB), `${key}: f16 VRAM`);
      assert.equal(row.f32, Math.round(f32.vram_required_MB), `${key}: f32 VRAM`);
      assert.equal(row.gb, spec.approxDownloadMB / 1000, `${key}: download size`);
      const ctx = chooseModel(desktop, /** @type {any} */ (key)).chatOptions.context_window_size;
      assert.equal(row.ctx, ctx, `${key}: context window`);
      for (const m of [f16, f32]) {
        const limit = m.overrides?.context_window_size;
        if (limit !== undefined) assert.ok(ctx <= limit, `${m.model_id}: context ${ctx} exceeds ${limit}`);
      }
    }
  });
});

describe('normalizePreference', () => {
  it('keeps known keys and maps everything else to auto', () => {
    assert.equal(normalizePreference('qwen-3b'), 'qwen-3b');
    assert.equal(normalizePreference('deepseek-r1'), 'auto');
    assert.equal(normalizePreference('__proto__'), 'auto');
    assert.equal(normalizePreference(null), 'auto');
  });
});

describe('chooseModel', () => {
  it('picks the 3B model on capable desktops', () => {
    const c = chooseModel(desktop, 'auto');
    assert.equal(c.key, 'qwen-3b');
    assert.equal(c.modelId, MODEL_CATALOG['qwen-3b'].f16);
    assert.deepEqual(c.chatOptions, { context_window_size: 4096, prefill_chunk_size: 512 });
    assert.equal(c.reason, 'auto');
  });

  it('is conservative when device memory is hidden (Safari/Firefox)', () => {
    assert.equal(chooseModel({ ...desktop, deviceMemoryGB: null }, 'auto').key, 'qwen-1.5b');
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
  });

  it('honours manual preferences', () => {
    const c = chooseModel({ ...desktop, isMobile: true }, 'qwen-3b');
    assert.equal(c.key, 'qwen-3b');
    assert.equal(c.reason, 'manual');
    assert.equal(c.chatOptions.prefill_chunk_size, 128);
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
});
