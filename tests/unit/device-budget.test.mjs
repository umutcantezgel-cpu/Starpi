// Output budgets per device class (src/js/models/device.js outputBudget, webgpu/models.js
// answerTokens) and the places that size on-device answers with them: the engine choice carries its
// device class, the in-browser AI adapters cap max tokens by the budget, and a processor model that
// a benchmark measured faster on this device may answer longer.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWasmAdapter } from '../../src/js/ai/adapters/wasm.js';
import { createWebllmAdapter } from '../../src/js/ai/adapters/webllm.js';
import { collect } from '../../src/js/ai/index.js';
import { GIB, OUTPUT_BUDGETS, outputBudget, WASM_OUTPUT_TOKENS } from '../../src/js/models/device.js';
import { WASM_CATALOG } from '../../src/js/models/wasm-catalog.js';
import { answerTokens, budgetPrompt, chooseModel } from '../../src/js/webgpu/models.js';
import { request, run } from '../fixtures/ai/replay.mjs';

const desktop = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 2 * GIB, hasF16: true };
const cpu = { isMobile: false, deviceMemoryGB: 8, maxBufferSize: 0, hasF16: false, webgpu: false };
const pro = { ...desktop, vendor: 'apple', maxStorageBufferBindingSize: 2 * GIB };

describe('outputBudget', () => {
  it('follows the table for WebGPU: 512 / 768 / 1024 / 2048 for phone / light / laptop / desktop and up', () => {
    assert.equal(outputBudget('mobile', 'webgpu'), 512);
    assert.equal(outputBudget('low', 'webgpu'), 768);
    assert.equal(outputBudget('laptop', 'webgpu'), 1024);
    assert.equal(outputBudget('desktop', 'webgpu'), 2048);
    assert.equal(outputBudget('desktop-pro', 'webgpu'), 2048);
    assert.deepEqual(Object.keys(OUTPUT_BUDGETS).sort(), ['cpu-only', 'desktop', 'desktop-pro', 'laptop', 'low', 'mobile']);
  });

  it('keeps processor models at their smaller budget unless a measurement says they are faster', () => {
    for (const cls of /** @type {const} */ (['cpu-only', 'mobile', 'laptop', 'desktop'])) {
      assert.equal(outputBudget(cls, 'wasm'), WASM_OUTPUT_TOKENS, cls);
      assert.equal(outputBudget(cls, 'wasm', null), WASM_OUTPUT_TOKENS, cls);
      assert.equal(outputBudget(cls, 'wasm', 0), WASM_OUTPUT_TOKENS, cls);
      assert.equal(outputBudget(cls, 'wasm', Number.NaN), WASM_OUTPUT_TOKENS, cls);
    }
    // 4 tok/s fills 240 tokens a minute: the default stays.
    assert.equal(outputBudget('cpu-only', 'wasm', 4), WASM_OUTPUT_TOKENS);
    // 7.5 tok/s fills 450 a minute: rounded down to 448.
    assert.equal(outputBudget('laptop', 'wasm', 7.5), 448);
    // Fast processors never exceed the table entry of their class.
    assert.equal(outputBudget('cpu-only', 'wasm', 30), 512);
    assert.equal(outputBudget('laptop', 'wasm', 30), 1024);
  });

  it('agrees with the processor catalog', () => {
    for (const [key, spec] of Object.entries(WASM_CATALOG)) assert.equal(spec.maxOutputTokens, WASM_OUTPUT_TOKENS, key);
  });
});

describe('answerTokens', () => {
  it('gives a free answer the device budget within half the context window', () => {
    // Desktop, Qwen 3B with 4,096 tokens of context: the whole 2,048.
    assert.equal(answerTokens(chooseModel(desktop, 'auto'), { free: true }), 2048);
    // Laptop (memory hidden), Qwen 1.5B with 2,048 tokens of context: 1,024.
    const laptop = chooseModel({ ...desktop, deviceMemoryGB: null }, 'auto');
    assert.equal(laptop.deviceClass, 'laptop');
    assert.equal(answerTokens(laptop, { free: true }), 1024);
    // A phone: 512.
    const phone = chooseModel({ ...desktop, isMobile: true }, 'auto');
    assert.equal(phone.deviceClass, 'mobile');
    assert.equal(answerTokens(phone, { free: true }), 512);
    // A light device: 768.
    assert.equal(answerTokens(chooseModel({ ...desktop, deviceMemoryGB: 4 }, 'auto'), { free: true }), 768);
    // A strong GPU with a T1 preset: the budget is cut to half of its 2,048-token context.
    const small = chooseModel(pro, 'webgpu:llama-1b');
    assert.equal(small.deviceClass, 'desktop-pro');
    assert.equal(answerTokens(small, { free: true }), 1024);
  });

  it('keeps grounded answers at the preset length, within the same budget', () => {
    assert.equal(answerTokens(chooseModel(desktop, 'auto'), { free: false }), 512);
    assert.equal(answerTokens(chooseModel(cpu, 'auto'), { free: false }), WASM_OUTPUT_TOKENS);
    assert.equal(answerTokens({ chatOptions: { context_window_size: 512 }, maxOutputTokens: 512, deviceClass: 'desktop' }, { free: false }), 256);
  });

  it('lets a measured processor model answer longer, never beyond its budget', () => {
    const wasm = chooseModel(cpu, 'auto');
    assert.equal(wasm.deviceClass, 'cpu-only');
    assert.equal(answerTokens(wasm, { free: true }), WASM_OUTPUT_TOKENS);
    assert.equal(answerTokens(wasm, { free: true, tokPerSec: 3 }), WASM_OUTPUT_TOKENS);
    assert.equal(answerTokens(wasm, { free: true, tokPerSec: 25 }), 512);
    assert.equal(answerTokens(wasm, { free: false, tokPerSec: 25 }), WASM_OUTPUT_TOKENS, 'grounded answers keep the preset length');
  });

  it('treats a model without a device class conservatively', () => {
    assert.equal(answerTokens({ chatOptions: { context_window_size: 4096 } }, { free: true }), 512);
    assert.equal(answerTokens({ runtime: 'wasm', chatOptions: { context_window_size: 2048 } }, { free: true }), WASM_OUTPUT_TOKENS);
  });

  it('leaves the prompt room that budgetPrompt reserves for the answer', () => {
    for (const hw of [desktop, pro, cpu, { ...desktop, isMobile: true }, { ...desktop, deviceMemoryGB: null }]) {
      const model = chooseModel(hw, 'auto');
      const maxOutputTokens = answerTokens(model, { free: true, tokPerSec: 50 });
      const contextWindow = model.chatOptions.context_window_size;
      assert.ok(maxOutputTokens <= contextWindow / 2, `${model.ref}: ${maxOutputTokens}`);
      const out = budgetPrompt({ contextWindow, maxOutputTokens, system: 's'.repeat(9000), context: '', history: [], user: 'u'.repeat(9000) });
      const chars = out.system.length + out.user.length;
      assert.ok(chars <= (contextWindow - maxOutputTokens - 128) * 3, `${model.ref}: ${chars} characters of prompt`);
    }
  });
});

/**
 * A stand-in for the engine controller of webgpu/engine.js that records what it was asked.
 * @param {Record<string, unknown>} model
 */
function controller(model) {
  /** @type {any[]} */
  const requests = [];
  return {
    requests,
    getEngineState: () => ({ status: 'ready', model }),
    interrupt() {},
    /** @param {any} req */
    async generate(req) {
      requests.push(req);
      req.onDelta('Done.');
      return 'Done.';
    },
  };
}

describe('on-device adapters', () => {
  it('cap the output by the budget of the loaded model', async () => {
    const desktopModel = chooseModel(desktop, 'auto');
    const engine = controller(desktopModel);
    const adapter = createWebllmAdapter({ loadController: async () => engine });
    const result = await collect(await run(adapter, request('webgpu', 'auto', 'Hi'), null));
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(engine.requests[0].maxTokens, 2048, 'desktop budget, not the preset length');
    // A purpose that asks for less gets what it asks for; more is cut to the budget.
    await collect(await run(adapter, request('webgpu', 'auto', 'Hi', { maxOutputTokens: 40 }), null));
    assert.equal(engine.requests[1].maxTokens, 40);
    const phone = controller(chooseModel({ ...desktop, isMobile: true }, 'auto'));
    await collect(await run(createWebllmAdapter({ loadController: async () => phone }), request('webgpu', 'auto', 'Hi', { maxOutputTokens: 1500 }), null));
    assert.equal(phone.requests[0].maxTokens, 512);
  });

  it('size a processor model by its measured rate', async () => {
    const model = chooseModel(cpu, 'auto');
    /** @type {any[]} */
    const asked = [];
    const engine = controller(model);
    const fast = createWasmAdapter({ loadController: async () => engine, measuredRate: async (m) => (asked.push(m), 30) });
    await collect(await run(fast, request('wasm', 'auto', 'Hi'), null));
    assert.equal(engine.requests[0].maxTokens, 512);
    assert.equal(asked[0].modelId, model.modelId);
    const unmeasured = createWasmAdapter({ loadController: async () => engine, measuredRate: async () => null });
    await collect(await run(unmeasured, request('wasm', 'auto', 'Hi'), null));
    assert.equal(engine.requests[1].maxTokens, WASM_OUTPUT_TOKENS);
    const broken = createWasmAdapter({
      loadController: async () => engine,
      measuredRate: async () => {
        throw new Error('no database');
      },
    });
    const result = await collect(await run(broken, request('wasm', 'auto', 'Hi'), null));
    assert.equal(result.stopReason, 'end_turn', 'a history that cannot be read never fails the answer');
    assert.equal(engine.requests[2].maxTokens, WASM_OUTPUT_TOKENS);
  });
});
