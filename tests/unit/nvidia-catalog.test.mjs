import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  catalogJson,
  findNvidiaModel,
  NVIDIA_CATALOG,
  NVIDIA_CLIENT_TIMEOUTS,
  NVIDIA_DEFAULT_MODEL,
  NVIDIA_LIMITS,
  NVIDIA_MODELS,
  NVIDIA_PROXY,
  normalizeNvidiaModel,
  publicCatalog,
} from '../../src/js/models/nvidia-catalog.js';

/** The i18n test reads `: 'x.y'` and `? 'x.y'` in src/ as translation keys (tests/unit/i18n.test.mjs). */
const I18N_KEY_SHAPE = /^[a-z]\w*\.[\w.-]+$/;

describe('NVIDIA model catalog', () => {
  it('lists unique, well-formed ids and contains the default model', () => {
    const ids = NVIDIA_MODELS.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate model id');
    for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
    assert.ok(ids.includes(NVIDIA_DEFAULT_MODEL));
    assert.equal(NVIDIA_CATALOG.upstream, 'https://integrate.api.nvidia.com/v1/chat/completions');
  });

  it('keeps labels and vendors out of the i18n key shape and bounds every token budget', () => {
    for (const m of NVIDIA_MODELS) {
      assert.ok(m.label.trim().length > 0 && m.label.length <= 80, m.id);
      assert.doesNotMatch(m.label, I18N_KEY_SHAPE, m.id);
      assert.doesNotMatch(m.vendor, I18N_KEY_SHAPE, m.id);
      assert.ok(m.defaultMaxTokens >= 1 && m.defaultMaxTokens <= m.maxOutputTokens, m.id);
      assert.ok(m.maxOutputTokens <= NVIDIA_LIMITS.maxOutputTokens, m.id);
      for (const key of Object.keys(m.upstream ?? {})) assert.ok(['chat_template_kwargs', 'reasoning_effort'].includes(key), `${m.id}: ${key}`);
    }
  });

  it('is frozen, so no importer can change the allowlist at runtime', () => {
    assert.ok(Object.isFrozen(NVIDIA_CATALOG) && Object.isFrozen(NVIDIA_MODELS) && Object.isFrozen(NVIDIA_MODELS[0]));
    assert.throws(() => {
      /** @type {any} */ (NVIDIA_MODELS).push({ id: 'evil/model' });
    });
  });

  it('lets the proxy answer before the browser gives up', () => {
    assert.ok(NVIDIA_PROXY.attemptTimeoutMs <= NVIDIA_PROXY.failoverBudgetMs);
    assert.ok(NVIDIA_CLIENT_TIMEOUTS.firstByte > NVIDIA_PROXY.failoverBudgetMs);
    assert.ok(NVIDIA_CLIENT_TIMEOUTS.idle > NVIDIA_PROXY.idleTimeoutMs);
    assert.ok(NVIDIA_CLIENT_TIMEOUTS.total > NVIDIA_PROXY.streamMaxMs);
    assert.ok(NVIDIA_PROXY.streamMaxMs > NVIDIA_PROXY.failoverBudgetMs);
    const c = NVIDIA_PROXY.cooldownMs;
    assert.ok(c.rateLimitedMin <= c.rateLimitedDefault && c.rateLimitedDefault <= c.rateLimitedMax);
  });

  it('normalizes stored ids against the allowlist', () => {
    assert.equal(normalizeNvidiaModel('z-ai/glm-5.3'), 'z-ai/glm-5.3');
    for (const bad of ['evil/model', '', null, undefined, 42, '__proto__', 'constructor']) assert.equal(normalizeNvidiaModel(bad), NVIDIA_DEFAULT_MODEL);
    assert.equal(findNvidiaModel('nvidia/unknown'), undefined);
    assert.equal(findNvidiaModel('toString'), undefined);
  });

  it('publishes the model list without upstream extras', () => {
    const body = publicCatalog(true);
    assert.equal(body.configured, true);
    assert.equal(body.defaultModel, NVIDIA_DEFAULT_MODEL);
    assert.deepEqual(body.models.map((m) => m.id), NVIDIA_MODELS.map((m) => m.id));
    assert.ok(body.models.every((m) => !('upstream' in m)));
    assert.equal(publicCatalog(false).configured, false);
  });

  it('serializes to the JSON the Python backend reads', () => {
    assert.deepEqual(JSON.parse(catalogJson()), JSON.parse(JSON.stringify(NVIDIA_CATALOG)));
    assert.ok(catalogJson().endsWith('}\n'));
  });
});
