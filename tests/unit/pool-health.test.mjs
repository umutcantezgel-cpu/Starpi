// GET /api/health and GET /api/models/pool: booleans and public model facts only, never a key, a
// key count or an address; simulated providers follow STARPI_<ID>_BASE_URL on loopback only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildPools, handlePoolModels, poolStatus } from '../../api/_lib/pool/handler.js';
import { RELAY_PROVIDERS } from '../../api/_lib/relay/upstreams.js';
import * as healthRoute from '../../api/health.js';
import * as modelsRoute from '../../api/models/pool.js';
import { testKey } from './relay-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { version } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const io = { fetch, now: () => Date.now(), warn: () => {} };

/**
 * Every leaf of a JSON value, with its path.
 * @param {unknown} value
 * @param {string} [at]
 * @returns {Array<[string, unknown]>}
 */
function leaves(value, at = '') {
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => leaves(v, `${at}.${k}`));
  return [[at, value]];
}

describe('health report', () => {
  it('has the documented shape with booleans only', () => {
    const env = { NVIDIA_API_KEYS: `${testKey('nvidia', 1)},${testKey('nvidia', 2)}`, GEMINI_API_KEYS: testKey('gemini'), STARPI_GEMINI_BASE_URL: 'http://127.0.0.1:4613' };
    const report = healthRoute.healthReport(env, poolStatus(buildPools(env, io)));
    assert.deepEqual(Object.keys(report), ['version', 'pools', 'simulated', 'voice', 'research', 'access']);
    assert.equal(report.version, version);
    assert.deepEqual(report.pools, { minimax: false, nvidia: true, groq: false, gemini: true, openrouter: false });
    assert.deepEqual(Object.keys(report.simulated).sort(), [...RELAY_PROVIDERS].sort());
    assert.equal(report.simulated.gemini, true);
    assert.equal(report.simulated.nvidia, false);
    // The site's Gemini keys also serve the speech routes (api/voice/*) and the research steps.
    assert.deepEqual(report.voice, { tts: true, stt: true, live: true });
    assert.equal(report.research, true);
    assert.equal(report.access, false);
    for (const [where, leaf] of leaves({ ...report, version: undefined })) {
      if (where !== '.version') assert.equal(typeof leaf, 'boolean', where);
    }
    const text = JSON.stringify(report);
    assert.ok(!text.includes('nvapi-') && !text.includes('AIza') && !text.includes('127.0.0.1') && !/"2"|:2[,}]/.test(text), 'no key, address or key count');
  });

  it('reports pools disabled by STARPI_POOL_PROVIDERS as unconfigured, fakes off loopback as real, and the access code as a flag', () => {
    const env = { STARPI_POOL_PROVIDERS: 'groq', NVIDIA_API_KEYS: testKey('nvidia'), GROQ_API_KEYS: testKey('groq'), STARPI_OPENAI_BASE_URL: 'https://fake.example', STARPI_ACCESS_CODE: 'abcdefghijklmnop' };
    const report = healthRoute.healthReport(env, poolStatus(buildPools(env, io)));
    assert.deepEqual(report.pools, { minimax: false, nvidia: false, groq: true, gemini: false, openrouter: false });
    assert.equal(report.simulated.openai, false);
    assert.equal(report.access, true);
    assert.ok(!JSON.stringify(report).includes('abcdefghijklmnop'));
  });

  it('asks each feature route whether it serves requests', () => {
    const on = { available: () => true };
    const off = { available: () => false };
    const report = healthRoute.healthReport({}, poolStatus({}), { tts: on, stt: off, live: {}, research: { available: () => /** @type {any} */ ('yes') } });
    assert.deepEqual(report.voice, { tts: true, stt: false, live: false });
    assert.equal(report.research, false, 'only a real true counts');
  });
});

describe('pool models', () => {
  it('lists every pool with configured, dialect, limits and public model facts', async () => {
    const res = handlePoolModels({ pools: buildPools({ GROQ_API_KEYS: `${testKey('groq', 1)},${testKey('groq', 2)}` }, io) });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.version, 1);
    assert.deepEqual(Object.keys(body.pools), ['minimax', 'nvidia', 'groq', 'gemini', 'openrouter']);
    assert.equal(body.pools.groq.configured, true);
    assert.equal(body.pools.nvidia.configured, false);
    assert.equal(body.pools.gemini.dialect, 'gemini');
    for (const pool of Object.values(body.pools)) {
      assert.deepEqual(Object.keys(pool), ['configured', 'dialect', 'defaultModel', 'limits', 'models']);
      for (const m of /** @type {any} */ (pool).models) assert.deepEqual(Object.keys(m), ['id', 'label', 'vendor', 'reasoning', 'vision', 'maxOutputTokens', 'defaultMaxTokens']);
    }
    const text = JSON.stringify(body);
    assert.ok(!text.includes('gsk_') && !text.includes('chat_template_kwargs') && !text.includes('reasoning_effort') && !/keys|count/i.test(text));
  });
});

describe('health and models routes', () => {
  const ENV = ['MINIMAX_API_KEYS', 'NVIDIA_API_KEYS', 'GROQ_API_KEYS', 'GEMINI_API_KEYS', 'OPENROUTER_API_KEYS', 'STARPI_POOL_PROVIDERS', 'STARPI_ACCESS_CODE'];
  /** @type {Record<string, string | undefined>} */
  let saved = {};
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
    for (const name of ENV) delete process.env[name];
  });
  afterEach(() => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('answers GET with no-store JSON and 405 with Allow for every other method', async () => {
    for (const route of [healthRoute, modelsRoute]) {
      const res = await route.GET();
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      await res.json();
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
        const refused = await route[/** @type {'POST'} */ (method)]();
        assert.equal(refused.status, 405, method);
        assert.equal(refused.headers.get('allow'), 'GET');
      }
    }
    process.env.GROQ_API_KEYS = testKey('groq');
    assert.equal((await (await healthRoute.GET()).json()).pools.groq, true);
  });
});
