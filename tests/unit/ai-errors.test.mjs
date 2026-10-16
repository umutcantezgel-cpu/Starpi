// AiError and the HTTP classifier: status first, body codes and phrases refine it, Retry-After in
// every form, the relay's upstream status, nothing of the provider's text in the error, and an
// i18n text for every code in both languages.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AI_ERROR_CODES,
  AI_ERROR_KEYS,
  AI_RETRY_KEY,
  AiError,
  errorMessageKey,
  fromHttp,
  isRetryable,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  retryDelayFromBody,
  toAiError,
} from '../../src/js/ai/errors.js';
import { STOP_NOTE_KEYS } from '../../src/js/ai/stop-reason.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** @param {string} lang */
const dictionary = (lang) => JSON.parse(readFileSync(path.join(ROOT, `src/locales/ai/${lang}.json`), 'utf8'));
const LEAK = 'sk-test-1234 secret detail';

/**
 * @param {Record<string, unknown>} dict
 * @param {string} key  `ai.`-prefixed
 */
function lookup(dict, key) {
  /** @type {any} */
  let node = dict;
  for (const part of key.split('.').slice(1)) node = node?.[part];
  return node;
}

describe('AiError', () => {
  it('carries code, status, retry delay, provider and a safe provider code only', () => {
    const err = new AiError('rate_limited', { status: 429, retryAfterMs: 1500.4, provider: 'openai', providerCode: 'Rate_Limit_Exceeded' });
    assert.equal(err.name, 'AiError');
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 1500);
    assert.equal(err.provider, 'openai');
    assert.equal(err.providerCode, 'rate_limit_exceeded');
    assert.equal(err.message, 'rate_limited (HTTP 429)');
    assert.equal(err.messageKey, 'ai.error.rate_limited');
    assert.equal(err.retryable, true);
    assert.equal(new AiError('auth', { providerCode: 'Key sk-1 is bad' }).providerCode, null);
    assert.equal(new AiError('server', { retryAfterMs: 10 * MAX_RETRY_AFTER_MS }).retryAfterMs, MAX_RETRY_AFTER_MS);
  });

  it('refuses unknown codes', () => {
    assert.throws(() => new AiError(/** @type {any} */ ('oops')), TypeError);
  });

  it('marks only transient codes as retryable', () => {
    assert.deepEqual(AI_ERROR_CODES.filter(isRetryable).sort(), ['network', 'rate_limited', 'server', 'stream_cut', 'timeout']);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  it('reads seconds, HTTP dates and retry-after-ms', () => {
    assert.equal(parseRetryAfter({ 'Retry-After': '7' }), 7000);
    assert.equal(parseRetryAfter(new Headers({ 'retry-after': '1.5' })), 1500);
    assert.equal(parseRetryAfter({ 'retry-after': 'Thu, 01 Jan 2026 00:00:30 GMT' }, now), 30_000);
    assert.equal(parseRetryAfter({ 'retry-after': 'Wed, 31 Dec 2025 23:00:00 GMT' }, now), 0);
    assert.equal(parseRetryAfter({ 'retry-after-ms': '250', 'retry-after': '9' }), 250);
    assert.equal(parseRetryAfter({ 'retry-after': '86400' }), MAX_RETRY_AFTER_MS);
    assert.equal(parseRetryAfter({ 'retry-after': 'soon' }), null);
    assert.equal(parseRetryAfter(null), null);
  });

  it('reads a retry delay from structured retry info in a body', () => {
    assert.equal(retryDelayFromBody('{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"7s"}]}}'), 7000);
    assert.equal(retryDelayFromBody('{"retryDelay": "0.5s"}'), 500);
    assert.equal(retryDelayFromBody('nothing here'), null);
  });
});

describe('fromHttp', () => {
  /** @param {number} status @param {unknown} [body] @param {Record<string, string>} [headers] */
  const classify = (status, body, headers = {}) => fromHttp(status, headers, typeof body === 'string' ? body : JSON.stringify(body ?? {}), { provider: 'openai' });

  it('maps statuses', () => {
    assert.equal(classify(401).code, 'auth');
    assert.equal(classify(403).code, 'auth');
    assert.equal(classify(402).code, 'quota');
    assert.equal(classify(429).code, 'rate_limited');
    assert.equal(classify(404).code, 'not_found');
    assert.equal(classify(410).code, 'not_found');
    assert.equal(classify(400).code, 'bad_request');
    assert.equal(classify(422).code, 'bad_request');
    assert.equal(classify(408).code, 'timeout');
    assert.equal(classify(504).code, 'timeout');
    for (const s of [500, 502, 503, 529]) assert.equal(classify(s).code, 'server', String(s));
    assert.equal(classify(418).code, 'bad_request');
    assert.equal(classify(302).code, 'bad_response');
  });

  it('tells quota from rate limits and context length from other bad requests', () => {
    assert.equal(classify(429, { error: { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your quota' } }).code, 'quota');
    assert.equal(classify(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }).code, 'rate_limited');
    assert.equal(classify(400, { error: { code: 'context_length_exceeded' } }).code, 'context_length');
    assert.equal(classify(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } }).code, 'context_length');
    assert.equal(classify(413, 'Request exceeds the maximum context length of the model').code, 'context_length');
    assert.equal(classify(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }).code, 'auth');
    assert.equal(classify(400, { error: { type: 'invalid_request_error', message: 'messages: field required' } }).code, 'bad_request');
  });

  it('keeps the provider identifier, never the provider text', () => {
    const err = classify(429, { error: { code: 429, message: LEAK, status: 'RESOURCE_EXHAUSTED' } });
    assert.equal(err.providerCode, 'resource_exhausted');
    assert.ok(!JSON.stringify({ ...err, message: err.message, stack: '' }).includes('secret'));
    assert.ok(!err.message.includes('secret'));
    assert.equal(classify(500, `<html>${LEAK}</html>`).providerCode, null);
  });

  it('takes the retry delay from headers or the body, for rate limits and server errors only', () => {
    assert.equal(classify(429, {}, { 'retry-after': '3' }).retryAfterMs, 3000);
    assert.equal(classify(503, {}, { 'retry-after': '4' }).retryAfterMs, 4000);
    assert.equal(classify(429, { error: { details: [{ retryDelay: '9s' }] } }).retryAfterMs, 9000);
    assert.equal(classify(400, {}, { 'retry-after': '3' }).retryAfterMs, null);
  });

  it("classifies the relay's answers by the upstream status", () => {
    const err = classify(502, { error: 'rate_limit_error', upstreamStatus: 429 });
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.status, 429);
    assert.equal(err.providerCode, 'rate_limit_error');
    assert.equal(classify(502, { error: 'upstream_error' }).code, 'server');
  });

  it('accepts a parsed body and an empty one', () => {
    assert.equal(fromHttp(429, null, { error: { code: 'insufficient_quota' } }).code, 'quota');
    assert.equal(fromHttp(401, undefined, undefined).code, 'auth');
  });
});

describe('toAiError', () => {
  it('maps aborts, timeouts, network failures and cut streams', () => {
    const ac = new AbortController();
    ac.abort();
    assert.equal(toAiError(new DOMException('x', 'AbortError'), { signal: ac.signal }).code, 'aborted');
    const timed = new AbortController();
    timed.abort(new DOMException('t', 'TimeoutError'));
    assert.equal(toAiError(new Error('x'), { signal: timed.signal }).code, 'timeout');
    const reasoned = new AbortController();
    reasoned.abort(new AiError('timeout'));
    assert.equal(toAiError(new Error('x'), { signal: reasoned.signal }).code, 'timeout');
    assert.equal(toAiError(new TypeError('Failed to fetch'), { beforeResponse: 'cors' }).code, 'cors');
    assert.equal(toAiError(new TypeError('fetch failed')).code, 'network');
    assert.equal(toAiError(new TypeError('terminated'), { responded: true }).code, 'stream_cut');
    assert.equal(toAiError(Object.assign(new Error('x'), { name: 'TimeoutError' })).code, 'timeout');
  });

  it('unwraps AiErrors and reads the status of SDK errors', () => {
    const inner = new AiError('cors');
    assert.equal(toAiError(inner), inner);
    assert.equal(toAiError(new Error('connection error', { cause: inner })), inner);
    const sdk = Object.assign(new Error(LEAK), { status: 429, headers: { 'retry-after': '2' }, error: { type: 'error', error: { type: 'rate_limit_error' } } });
    const err = toAiError(sdk, { provider: 'anthropic' });
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.retryAfterMs, 2000);
    assert.equal(err.provider, 'anthropic');
    assert.ok(!err.message.includes('secret'));
  });
});

describe('ai locale namespace', () => {
  const en = dictionary('en');
  const de = dictionary('de');

  it('has a text for every error code, the retry hint and every stop note, in both languages', () => {
    const keys = [...Object.values(AI_ERROR_KEYS), AI_RETRY_KEY, ...Object.values(STOP_NOTE_KEYS)];
    for (const key of keys) {
      for (const [lang, dict] of [['en', en], ['de', de]]) {
        const text = lookup(dict, key);
        assert.equal(typeof text, 'string', `${lang}: ${key}`);
        assert.ok(text.trim().length > 0, `${lang}: ${key}`);
      }
    }
    for (const code of AI_ERROR_CODES) assert.equal(errorMessageKey(code), `ai.error.${code}`);
  });

  it('has the same keys and placeholders in English and German', () => {
    /** @param {any} obj @param {string} [prefix] @returns {Array<[string, string]>} */
    const flat = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [[`${prefix}${k}`, String(v)]]));
    const enFlat = new Map(flat(en));
    const deFlat = new Map(flat(de));
    assert.deepEqual([...enFlat.keys()].sort(), [...deFlat.keys()].sort());
    /** @param {string} s */
    const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, text] of enFlat) assert.deepEqual(holes(text), holes(/** @type {string} */ (deFlat.get(key))), key);
  });
});
