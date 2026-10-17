// Pool request validation (api/_lib/pool/request.js): the shared NVIDIA vectors give the same result
// as the NVIDIA proxy's own validator, images only for vision models and only as data URLs, no
// tools, output limits clamped, per-pool model allowlists, and Gemini's streamGenerateContent shape.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateChatRequest } from '../../api/_lib/nvidia-request.js';
import { findPoolSpec, POOL_IDS, POOL_SPECS } from '../../api/_lib/pool/allowlist.js';
import { poolRoute, validatePoolRequest } from '../../api/_lib/pool/request.js';
import { NVIDIA_MODELS, NVIDIA_UPSTREAM_URL } from '../../src/js/models/nvidia-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nvidia = /** @type {import('../../api/_lib/pool/allowlist.js').PoolSpec} */ (findPoolSpec('nvidia'));
const gemini = /** @type {import('../../api/_lib/pool/allowlist.js').PoolSpec} */ (findPoolSpec('gemini'));
const groq = /** @type {import('../../api/_lib/pool/allowlist.js').PoolSpec} */ (findPoolSpec('groq'));
const CHAT = /** @type {const} */ ({ dialect: 'openai-chat' });
const PNG = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(64, 'A')}`;
const visionModel = (/** @type {typeof nvidia} */ spec) => /** @type {{ id: string }} */ (spec.models.find((m) => m.vision));
const textModel = (/** @type {typeof nvidia} */ spec) => /** @type {{ id: string }} */ (spec.models.find((m) => !m.vision));

/** Expands `{"$repeat": [text, n]}` placeholders of the shared vectors. */
function expand(/** @type {unknown} */ value) {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 1 && entries[0][0] === '$repeat') {
      const [text, times] = /** @type {[string, number]} */ (entries[0][1]);
      return text.repeat(times);
    }
    return Object.fromEntries(entries.map(([k, v]) => [k, expand(v)]));
  }
  return value;
}

describe('pool allowlists', () => {
  it('describes four pools, each with a default model from its own list', () => {
    assert.deepEqual([...POOL_IDS], ['nvidia', 'groq', 'gemini', 'openrouter']);
    for (const spec of Object.values(POOL_SPECS)) {
      assert.ok(spec.models.some((m) => m.id === spec.defaultModel), spec.id);
      assert.ok(new URL(spec.root).protocol === 'https:', spec.id);
      assert.ok(spec.keyRpm > 0 && spec.limits.maxBodyBytes <= 4_000_000, spec.id);
      for (const m of spec.models) assert.ok(m.defaultMaxTokens <= m.maxOutputTokens, m.id);
    }
    assert.equal(`${nvidia.root}/v1/chat/completions`, NVIDIA_UPSTREAM_URL);
    assert.deepEqual(nvidia.models.map((m) => m.id), NVIDIA_MODELS.map((m) => m.id));
  });
});

describe('pool routes', () => {
  it('accepts chat completions for chat pools and streamGenerateContent for Gemini', () => {
    assert.deepEqual(poolRoute(nvidia, '/v1/chat/completions'), { ok: true, dialect: 'openai-chat' });
    assert.deepEqual(poolRoute(gemini, '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'), { ok: true, dialect: 'gemini', model: 'gemini-2.5-flash' });
    assert.deepEqual(poolRoute(gemini, '/v1beta/models/gemini-2.5-flash:streamGenerateContent'), { ok: true, dialect: 'gemini', model: 'gemini-2.5-flash' });
    for (const [spec, p] of [
      [nvidia, '/v1/models'],
      [nvidia, '/v1/responses'],
      [nvidia, '/v1/chat/completions?x=1'],
      [groq, '/v1beta/models/x:streamGenerateContent'],
      [gemini, '/v1/chat/completions'],
      [gemini, '/v1beta/models/gemini-2.5-flash:generateContent'],
      [gemini, '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=x'],
      [gemini, '/v1beta/models/../x:streamGenerateContent'],
    ]) {
      assert.deepEqual(poolRoute(/** @type {typeof nvidia} */ (spec), /** @type {string} */ (p)), { ok: false, status: 404, error: 'path_not_allowed' }, `${/** @type {typeof nvidia} */ (spec).id} ${p}`);
    }
  });
});

describe('chat pool requests', () => {
  const { vectors } = JSON.parse(readFileSync(path.join(ROOT, 'backend/test_fixtures/nvidia_validation.json'), 'utf8'));

  it('agrees with the NVIDIA validator on every shared vector', () => {
    assert.ok(vectors.length >= 30);
    for (const vector of vectors) {
      const data = expand(vector.body);
      const legacy = validateChatRequest(data);
      const pooled = validatePoolRequest(nvidia, CHAT, data);
      if (legacy.ok) {
        assert.ok(pooled.ok, `${vector.name}: ${JSON.stringify(pooled)}`);
        assert.deepEqual(pooled.body, legacy.body, vector.name);
        assert.equal(pooled.url, NVIDIA_UPSTREAM_URL);
      } else {
        assert.deepEqual(pooled, { ok: false, status: legacy.status, error: legacy.error, ...(legacy.field ? { field: legacy.field } : {}) }, vector.name);
      }
    }
  });

  it('accepts data-URL images in user messages of vision models only', () => {
    const vision = visionModel(nvidia).id;
    const content = [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: PNG, detail: 'low' } }];
    const ok = validatePoolRequest(nvidia, CHAT, { model: vision, messages: [{ role: 'user', content }] });
    assert.ok(ok.ok);
    assert.deepEqual(/** @type {any} */ (ok.body).messages, [{ role: 'user', content }]);
    const imageOnly = validatePoolRequest(nvidia, CHAT, { model: vision, messages: [{ role: 'user', content: [content[1]] }] });
    assert.ok(imageOnly.ok, 'an image alone is a question');

    const refused = [
      { model: textModel(nvidia).id, messages: [{ role: 'user', content }] },
      { model: vision, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }] },
      { model: vision, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,PHN2Zz4=' } }] }] },
      { model: vision, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG, detail: 'ultra' } }] }] },
      { model: vision, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AA==' } }] }] },
      { model: vision, messages: [{ role: 'user', content: Array(5).fill(content[1]) }] },
      { model: vision, messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content }, { role: 'user', content: 'and?' }] },
      { model: vision, messages: [{ role: 'user', content: [] }] },
      { model: vision, messages: [{ role: 'user', content: [{ type: 'text', text: '  ' }] }] },
    ];
    for (const data of refused) assert.deepEqual(validatePoolRequest(nvidia, CHAT, data), { ok: false, status: 400, error: 'invalid_field', field: 'messages' }, JSON.stringify(data).slice(0, 160));
  });

  it('drops tools and every other extra field, and clamps the output limit per model', () => {
    const model = groq.models[0];
    const result = validatePoolRequest(groq, CHAT, {
      model: model.id,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ type: 'function', function: { name: 'x' } }],
      tool_choice: 'required',
      response_format: { type: 'json_object' },
      max_tokens: 1_000_000,
      stream: false,
      reasoning_format: 'raw',
    });
    assert.ok(result.ok);
    assert.deepEqual(result.body, { model: model.id, messages: [{ role: 'user', content: 'Hi' }], max_tokens: model.maxOutputTokens, stream: true });
    assert.equal(result.url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.deepEqual(validatePoolRequest(groq, CHAT, { model: nvidia.models[0].id, messages: [{ role: 'user', content: 'Hi' }] }), { ok: false, status: 400, error: 'model_not_allowed' });
  });
});

describe('Gemini pool requests', () => {
  const route = /** @type {const} */ ({ dialect: 'gemini', model: 'gemini-2.5-flash' });

  it('builds the streaming request from contents, the system instruction and the allowed config', () => {
    const result = validatePoolRequest(gemini, route, {
      systemInstruction: { parts: [{ text: 'Answer briefly.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Hi' }] },
        { role: 'model', parts: [{ text: 'thinking...', thought: true }, { text: 'Hello', thoughtSignature: 'opaque' }] },
        { role: 'user', parts: [{ text: 'Describe' }, { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }] },
      ],
      generationConfig: { maxOutputTokens: 99_999, temperature: 0.5, topP: 0.9, thinkingConfig: { includeThoughts: true, thinkingBudget: 50_000 }, responseMimeType: 'application/json' },
      tools: [{ google_search: {} }],
      safetySettings: [],
      cachedContent: 'cachedContents/x',
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    assert.deepEqual(result.body, {
      contents: [
        { role: 'user', parts: [{ text: 'Hi' }] },
        { role: 'model', parts: [{ text: 'Hello' }] },
        { role: 'user', parts: [{ text: 'Describe' }, { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } }] },
      ],
      systemInstruction: { parts: [{ text: 'Answer briefly.' }] },
      generationConfig: { maxOutputTokens: 8192, temperature: 0.5, topP: 0.9, thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } },
    });
  });

  it('refuses tools in contents, foreign roles, bad images and a model outside the list', () => {
    const user = { role: 'user', parts: [{ text: 'Hi' }] };
    const cases = [
      [{ contents: [] }, 'contents'],
      [{ contents: [{ role: 'user', parts: [{ functionCall: { name: 'x', args: {} } }] }] }, 'contents'],
      [{ contents: [{ role: 'tool', parts: [{ text: 'x' }] }, user] }, 'contents'],
      [{ contents: [user, { role: 'model', parts: [{ text: 'last' }] }] }, 'contents'],
      [{ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: 'AAAA' } }] }] }, 'contents'],
      [{ contents: [{ role: 'user', parts: [{ fileData: { fileUri: 'https://example.com/x' } }] }] }, 'contents'],
      [{ contents: [user], systemInstruction: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } }, 'systemInstruction'],
      [{ contents: [user], generationConfig: { maxOutputTokens: 0 } }, 'maxOutputTokens'],
      [{ contents: [user], generationConfig: { temperature: 3 } }, 'temperature'],
      [{ contents: [user], generationConfig: { thinkingConfig: { thinkingLevel: 'extreme' } } }, 'thinkingConfig'],
      [{ contents: [user], generationConfig: 'x' }, 'generationConfig'],
    ];
    for (const [data, field] of cases) assert.deepEqual(validatePoolRequest(gemini, route, /** @type {any} */ (data)), { ok: false, status: 400, error: 'invalid_field', field }, JSON.stringify(data));
    assert.deepEqual(validatePoolRequest(gemini, { dialect: 'gemini', model: 'gemini-ultra-paid' }, { contents: [user] }), { ok: false, status: 400, error: 'model_not_allowed' });
    const lite = validatePoolRequest(gemini, { dialect: 'gemini', model: 'gemini-2.5-flash-lite' }, { contents: [{ parts: [{ text: 'Hi' }] }] });
    assert.ok(lite.ok);
    assert.deepEqual(/** @type {any} */ (lite.body).contents, [user], 'a content without a role is a user turn');
  });
});
