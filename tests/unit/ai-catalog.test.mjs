// The AI layer's catalog: the provider table (dialects, API roots, auth, transport defaults, key
// hints, quirks), the curated model snapshot (valid capability records, the Anthropic defaults,
// the NVIDIA section generated from the NVIDIA catalog), capability lookups and guesses, live model
// lists of each shape merged on top, the on-device presets, cost estimates and the pool
// allowlists.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createAnthropicFake } from '../../scripts/fakes/anthropic.mjs';
import { createGeminiFake } from '../../scripts/fakes/gemini.mjs';
import { createAdapter } from '../../src/js/ai/adapters/index.js';
import { capsFor, estimateCostUsd, fetchModels, findModel, heuristicCaps, isChatModelId, mergeModels, onDeviceModels, parseModelList, roleModel, SNAPSHOT, snapshotModels } from '../../src/js/ai/catalog/models.js';
import { isPoolModel, normalizePoolModel, parsePoolIds, poolAllowlist, POOL_IDS, POOLS } from '../../src/js/ai/catalog/pools.js';
import { getProvider, keyLooksValid, LOCAL_SERVER_PRESETS, presetEndpoint, PROVIDER_ORDER, PROVIDERS } from '../../src/js/ai/catalog/providers.js';
import { PROVIDER_IDS, validateCaps } from '../../src/js/ai/contract.js';
import { QUIRKS } from '../../src/js/ai/quirks/index.js';
import { directTransport, nativeAuthHeader } from '../../src/js/ai/transport.js';
import { NVIDIA_DEFAULT_MODEL, NVIDIA_MODELS, nvidiaSnapshotSection } from '../../src/js/models/nvidia-catalog.js';
import { WASM_CATALOG } from '../../src/js/models/wasm-catalog.js';
import { MODEL_CATALOG } from '../../src/js/webgpu/models.js';

describe('provider catalog', () => {
  it('describes every provider of the contract once, in picker order', () => {
    assert.deepEqual([...PROVIDER_ORDER].sort(), [...PROVIDER_IDS].sort());
    assert.deepEqual(Object.keys(PROVIDERS).sort(), [...PROVIDER_IDS].sort());
    for (const id of PROVIDER_IDS) {
      const info = PROVIDERS[id];
      assert.equal(info.id, id);
      assert.equal(createAdapter(id).dialect, info.dialect, id);
      assert.ok(Object.isFrozen(info));
      if (info.quirks) assert.ok(Object.hasOwn(QUIRKS, info.quirks), `${id}: quirks ${info.quirks}`);
    }
    assert.equal(getProvider('nope'), null);
    assert.equal(getProvider('__proto__'), null);
  });

  it('gives remote providers an https API root without a version segment and their native auth header', () => {
    for (const id of ['anthropic', 'openai', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'openrouter', 'nvidia']) {
      const info = PROVIDERS[/** @type {keyof typeof PROVIDERS} */ (id)];
      assert.match(info.baseUrl ?? '', /^https:\/\/[a-z0-9.-]+(?:\/[a-z]+)?$/, id);
      assert.doesNotMatch(info.baseUrl ?? '', /\/v\d/, id);
      assert.equal(nativeAuthHeader(id, 'k')[0], info.authHeader, id);
      assert.equal(createAdapter(/** @type {any} */ (id)).authHeader?.('k')[0], info.authHeader, id);
      assert.match(info.docsUrl ?? '', /^https:\/\//);
    }
  });

  it('sets the transport defaults of the design: direct where browsers are allowed, auto, pool, device', () => {
    const transport = Object.fromEntries(PROVIDER_IDS.map((id) => [id, PROVIDERS[id].transport]));
    assert.deepEqual(transport, { anthropic: 'direct', openai: 'direct', gemini: 'direct', xai: 'auto', groq: 'auto', mistral: 'auto', deepseek: 'auto', openrouter: 'direct', nvidia: 'pool', local: 'device', webgpu: 'device', wasm: 'device', companion: 'device' });
    assert.equal(PROVIDERS.local.auth, 'optional-bearer');
  });

  it('hints at key formats without rejecting anything', () => {
    // Keys are built here so that no key-shaped literal sits in the repository.
    assert.equal(keyLooksValid('anthropic', `sk-ant-${'a'.repeat(40)}`), true);
    assert.equal(keyLooksValid('anthropic', 'hello'), false);
    assert.equal(keyLooksValid('gemini', `AIza${'b'.repeat(35)}`), true);
    assert.equal(keyLooksValid('groq', `gsk_${'c'.repeat(40)}`), true);
    assert.equal(keyLooksValid('local', 'anything'), null);
  });

  it('lists the local server presets with their default ports', () => {
    assert.deepEqual(Object.values(LOCAL_SERVER_PRESETS).map((p) => presetEndpoint(p.id)), ['http://localhost:11434/v1', 'http://localhost:1234/v1', 'http://localhost:8000/v1', 'http://localhost:8080/v1']);
    assert.equal(LOCAL_SERVER_PRESETS.ollama.corsSetting, 'OLLAMA_ORIGINS');
  });
});

describe('model snapshot', () => {
  it('holds valid capability records for every curated model', () => {
    for (const [provider, section] of Object.entries(SNAPSHOT.providers)) {
      const ids = section.models.map((m) => m.id);
      assert.equal(new Set(ids).size, ids.length, provider);
      for (const m of section.models) assert.deepEqual(validateCaps(m.caps), [], `${provider}/${m.id}`);
      for (const [role, id] of Object.entries(section.roles)) assert.ok(ids.includes(/** @type {string} */ (id)), `${provider} ${role}`);
    }
    assert.ok(Object.isFrozen(SNAPSHOT.providers.anthropic?.models[0].caps));
  });

  it('has the Anthropic defaults: Opus for max, Sonnet balanced, Haiku fast, verified', () => {
    assert.equal(roleModel('anthropic', 'max'), 'claude-opus-5-5');
    assert.equal(roleModel('anthropic', 'balanced'), 'claude-sonnet-5-5');
    assert.equal(roleModel('anthropic', 'fast'), 'claude-haiku-5-5');
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
      const caps = capsFor('anthropic', id);
      assert.equal(caps.verified, true);
      assert.equal(caps.contextTokens, 1_000_000);
      assert.equal(caps.maxOutput, 128_000);
      assert.equal(caps.reasoning, 'adaptive');
      assert.equal(caps.search, 'native');
      assert.ok(caps.vision && caps.pdf && caps.tools);
    }
  });

  it('marks guessed capabilities of other providers as unverified', () => {
    for (const provider of ['openai', 'gemini', 'xai', 'groq', 'mistral', 'deepseek', 'openrouter']) {
      const models = snapshotModels(/** @type {any} */ (provider));
      assert.ok(models.length > 0, provider);
      assert.ok(models.every((m) => m.caps.verified === false), provider);
      for (const role of ['fast', 'balanced', 'max']) assert.ok(roleModel(/** @type {any} */ (provider), /** @type {any} */ (role)), `${provider} ${role}`);
    }
  });

  it('takes its NVIDIA section from the NVIDIA catalog', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(SNAPSHOT.providers.nvidia)), JSON.parse(JSON.stringify(nvidiaSnapshotSection())));
    assert.deepEqual(snapshotModels('nvidia').map((m) => m.id), NVIDIA_MODELS.map((m) => m.id));
    assert.equal(roleModel('nvidia', 'balanced'), NVIDIA_DEFAULT_MODEL);
    for (const m of NVIDIA_MODELS) {
      const caps = capsFor('nvidia', m.id);
      assert.equal(caps.free, true);
      assert.equal(caps.vision, m.vision);
      assert.equal(caps.reasoning, m.reasoning ? 'tagged' : 'none');
      assert.equal(caps.maxOutput, m.maxOutputTokens);
    }
  });

  it('describes the on-device presets from their own catalogs', () => {
    const device = onDeviceModels();
    assert.equal(device.length, Object.keys(MODEL_CATALOG).length + Object.keys(WASM_CATALOG).length);
    for (const m of device) {
      assert.match(m.id, /^(?:webgpu|wasm):/);
      assert.deepEqual(validateCaps(m.caps), []);
      assert.equal(m.caps.local, true);
      assert.equal(m.caps.free, true);
    }
    assert.equal(capsFor('wasm', 'wasm:smollm2-135m').maxOutput, WASM_CATALOG['smollm2-135m'].maxOutputTokens);
    assert.equal(snapshotModels('webgpu').length, Object.keys(MODEL_CATALOG).length);
  });
});

describe('capability guesses', () => {
  it('guesses from the id and marks the result unverified', () => {
    const caps = heuristicCaps('groq', 'deepseek-r1-distill-llama-70b');
    assert.deepEqual(validateCaps(caps), []);
    assert.equal(caps.verified, false);
    assert.equal(caps.reasoning, 'tagged');
    assert.equal(heuristicCaps('openai', 'gpt-5.9-pro').reasoning, 'effort');
    assert.equal(heuristicCaps('gemini', 'gemini-2.5-flash-preview').reasoning, 'budget');
    assert.equal(heuristicCaps('gemini', 'gemini-3-flash').reasoning, 'effort');
    assert.equal(heuristicCaps('openrouter', 'some/model:free').free, true);
    assert.equal(heuristicCaps('openrouter', 'some/model').search, 'plugin');
    const local = heuristicCaps('local', 'llama3.2:3b');
    assert.equal(local.local, true);
    assert.equal(local.tools, false);
    assert.equal(local.contextTokens, 4096);
    assert.equal(capsFor('anthropic', 'claude-unknown-9').verified, false);
    assert.equal(findModel('anthropic', 'claude-unknown-9'), null);
  });

  it('lets list fields refine the guesses', () => {
    const caps = heuristicCaps('openrouter', 'x/y', { contextTokens: 64_000, maxOutput: 100_000, vision: true, priceIn: 1 });
    assert.equal(caps.contextTokens, 64_000);
    assert.equal(caps.maxOutput, 64_000, 'output never exceeds the context');
    assert.equal(caps.vision, true);
    assert.equal(caps.priceIn, 1);
  });

  it('estimates the cost of a call from price hints', () => {
    const caps = capsFor('anthropic', 'claude-opus-5-5');
    assert.equal(estimateCostUsd({ input: 1_000_000, cacheRead: 0, output: 0 }, caps), 4);
    assert.equal(estimateCostUsd({ input: 1_000_000, cacheRead: 1_000_000, output: 100_000 }, caps), 0.4 + 2);
    assert.equal(estimateCostUsd({ input: 1, output: 1 }, heuristicCaps('local', 'x')), null);
  });
});

describe('live model lists', () => {
  it('reads the Anthropic, Gemini and OpenRouter shapes, and ids elsewhere', () => {
    const anthropic = parseModelList('anthropic', {
      data: [{ id: 'claude-new-1', display_name: 'Claude New', max_input_tokens: 500_000, max_tokens: 64_000, capabilities: { image_input: { supported: true }, thinking: { types: { adaptive: { supported: true } } } } }],
    });
    assert.deepEqual(anthropic, [{ id: 'claude-new-1', label: 'Claude New', contextTokens: 500_000, maxOutput: 64_000, hints: { vision: true, reasoning: 'adaptive' } }]);
    const gemini = parseModelList('gemini', {
      models: [
        { name: 'models/gemini-x', displayName: 'Gemini X', inputTokenLimit: 1000, outputTokenLimit: 100, supportedGenerationMethods: ['generateContent'], thinking: true },
        { name: 'models/embedding-x', supportedGenerationMethods: ['embedContent'] },
      ],
    });
    assert.deepEqual(gemini.map((m) => m.id), ['gemini-x']);
    assert.equal(gemini[0].hints?.reasoning, 'budget');
    const router = parseModelList('openrouter', {
      data: [{ id: 'a/b:free', name: 'A B', context_length: 32_000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning'], top_provider: { max_completion_tokens: 4000 } }],
    });
    assert.deepEqual(router[0], {
      id: 'a/b:free',
      label: 'A B',
      contextTokens: 32_000,
      maxOutput: 4000,
      hints: { vision: true, pdf: false, imageOut: false, tools: true, parallelTools: true, json: false, free: true, reasoning: 'effort', reasoningVisible: true, priceIn: 0, priceOut: 0 },
    });
    const plain = parseModelList('mistral', { data: [{ id: 'mistral-large-latest' }, { id: 'mistral-embed' }, { id: 'mistral-moderation-latest' }] });
    assert.deepEqual(plain, [{ id: 'mistral-large-latest' }]);
    assert.equal(isChatModelId('whisper-large-v3'), false);
    assert.deepEqual(parseModelList('groq', null), []);
  });

  it('merges a live list over the snapshot: limits refreshed, missing models flagged, new ones unverified', () => {
    const merged = mergeModels('anthropic', [
      { id: 'claude-opus-5-5', contextTokens: 900_000, maxOutput: 100_000 },
      { id: 'claude-new-1', label: 'Claude New' },
    ]);
    const opus = merged.find((m) => m.id === 'claude-opus-5-5');
    assert.equal(opus?.caps.contextTokens, 900_000);
    assert.equal(opus?.caps.verified, true);
    assert.equal(merged.find((m) => m.id === 'claude-haiku-5-5')?.listed, false);
    const added = merged.find((m) => m.id === 'claude-new-1');
    assert.equal(added?.source, 'live');
    assert.equal(added?.caps.verified, false);
    assert.deepEqual(mergeModels('anthropic', null), snapshotModels('anthropic'));
  });

  describe('through a transport', () => {
    /** @type {ReturnType<typeof createAnthropicFake>} */
    let anthropic;
    /** @type {ReturnType<typeof createGeminiFake>} */
    let gemini;
    let aUrl = '';
    let gUrl = '';
    before(async () => {
      anthropic = createAnthropicFake({ gapMs: 0 });
      gemini = createGeminiFake({ gapMs: 0 });
      aUrl = (await anthropic.listen(0)).url;
      gUrl = (await gemini.listen(0)).url;
    });
    after(async () => {
      await anthropic.close();
      await gemini.close();
    });

    it('fetches and merges the list, and keeps the snapshot when the list fails', async () => {
      const { models, error } = await fetchModels('anthropic', directTransport(aUrl, 'test-key', undefined, { provider: 'anthropic' }));
      assert.equal(error, null);
      assert.ok(models.every((m) => m.listed));
      assert.equal(anthropic.requests.at(-1)?.headers['anthropic-version'], '2023-06-01');
      const google = await fetchModels('gemini', directTransport(gUrl, 'test-key', undefined, { provider: 'gemini' }));
      assert.ok(google.models.some((m) => m.id === 'gemini-fake-flash' && m.source === 'live' && m.caps.contextTokens === 1_048_576));
      assert.equal(google.models.find((m) => m.id === 'gemini-2.5-pro')?.listed, false);
      const failed = await fetchModels('anthropic', directTransport(aUrl, null, undefined, { provider: 'anthropic' }));
      assert.ok(failed.error instanceof Error);
      assert.deepEqual(failed.models, snapshotModels('anthropic'));
      const none = await fetchModels('webgpu', directTransport(aUrl, null));
      assert.equal(none.error, null);
    });
  });
});

describe('pool allowlists', () => {
  it('take the NVIDIA list from its catalog and know their defaults', () => {
    assert.deepEqual([...POOL_IDS], ['nvidia', 'groq', 'gemini', 'openrouter']);
    assert.deepEqual([...poolAllowlist('nvidia')], NVIDIA_MODELS.map((m) => m.id));
    for (const id of POOL_IDS) {
      const pool = POOLS[id];
      assert.ok(pool.models.includes(pool.defaultModel), id);
      assert.ok(pool.visionModels.every((m) => pool.models.includes(m)), id);
      assert.ok(pool.maxOutputTokens > 0 && pool.maxOutputTokens <= 4096, id);
      assert.ok(Object.isFrozen(pool.models));
      assert.equal(PROVIDERS[pool.provider].pool, true);
    }
  });

  it('only allow models the snapshot knows for their provider; router pool models are free', () => {
    for (const id of /** @type {const} */ (['groq', 'gemini', 'openrouter'])) {
      for (const model of POOLS[id].models) assert.ok(findModel(POOLS[id].provider, model), `${id}: ${model}`);
    }
    for (const model of POOLS.openrouter.models) assert.equal(capsFor('openrouter', model).free, true, model);
  });

  it('match exact ids only and parse the pool setting', () => {
    assert.equal(isPoolModel('groq', 'llama-3.3-70b-versatile'), true);
    assert.equal(isPoolModel('groq', 'LLAMA-3.3-70B-VERSATILE'), false);
    assert.equal(isPoolModel('nope', 'x'), false);
    assert.equal(isPoolModel('groq', 42), false);
    assert.equal(normalizePoolModel('gemini', 'evil'), POOLS.gemini.defaultModel);
    assert.equal(normalizePoolModel('nope', 'x'), null);
    assert.deepEqual(parsePoolIds(' Groq, nvidia,unknown,groq ,'), ['groq', 'nvidia']);
    assert.deepEqual(parsePoolIds(undefined), []);
  });
});
