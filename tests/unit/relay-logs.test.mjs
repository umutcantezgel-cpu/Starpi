// No key in any log line: the relay, the pools and the provider ping run their failure paths while
// every console method is spied on, with test keys in headers, in upstream error bodies, in thrown
// errors and in malformed environment entries. Also the secret scrubber itself.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPools, handlePool } from '../../api/_lib/pool/handler.js';
import { handleRelay, relayRoots, serveRelay } from '../../api/_lib/relay/handler.js';
import { hasKnownKey, REDACTED, scrubSecrets } from '../../api/_lib/relay/scrub.js';
import { pingProvider } from '../../scripts/provider-ping.mjs';
import { NVIDIA_DEFAULT_MODEL } from '../../src/js/models/nvidia-catalog.js';
import { answer, frontGuards, jsonAnswer, jsonRequest, readAll, recordingFetch, testKey } from './relay-helpers.mjs';

const KEYS = [testKey('openai'), testKey('anthropic'), testKey('gemini'), testKey('nvidia'), testKey('groq')];

/**
 * Spies on every console method for the duration of `run`.
 * @param {import('node:test').TestContext} t
 */
function spyConsole(t) {
  /** @type {string[]} */
  const lines = [];
  for (const method of /** @type {const} */ (['log', 'info', 'warn', 'error', 'debug', 'trace'])) {
    t.mock.method(console, method, (/** @type {unknown[]} */ ...args) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.name} ${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  return lines;
}

/** @param {string} text */
const leaked = (text) => KEYS.filter((k) => text.includes(k) || text.includes(k.slice(8, 30)));

describe('secret scrubber', () => {
  it('replaces keys of every known shape, credential headers and query credentials', () => {
    for (const key of KEYS) assert.equal(scrubSecrets(`failed with ${key}.`), `failed with ${REDACTED}.`, key.slice(0, 6));
    assert.equal(scrubSecrets('Authorization: Bearer abcdefgh12345678'), `Authorization: ${REDACTED}`);
    assert.equal(scrubSecrets('x-goog-api-key=whatever-value'), `x-goog-api-key=${REDACTED}`);
    assert.equal(scrubSecrets('GET /v1beta/models?key=raw&alt=sse'), `GET /v1beta/models?key=${REDACTED}&alt=sse`);
    assert.equal(scrubSecrets('token abcDEF1234567890123456789012'), `token ${REDACTED}`);
    assert.equal(scrubSecrets('pool groq: key 2/3 rate limited (429), cooling 20 s'), 'pool groq: key 2/3 rate limited (429), cooling 20 s');
    assert.equal(scrubSecrets('TypeError'), 'TypeError');
    assert.equal(scrubSecrets('meta/llama-4-scout-17b-16e-instruct | 200'), 'meta/llama-4-scout-17b-16e-instruct | 200');
    assert.equal(scrubSecrets(`id ${'a1'.repeat(16)}`), `id ${REDACTED}`);
    assert.ok(hasKnownKey(`x ${KEYS[2]}`) && !hasKnownKey('covid-19-vaccine-effectiveness-2024') && !hasKnownKey('CAESBggBEAEYAQ'));
  });
});

describe('no key in logs', () => {
  it('holds for relay failures, upstream errors that quote the key and unexpected exceptions', async (t) => {
    const lines = spyConsole(t);
    const [openaiKey] = KEYS;
    const headers = { authorization: `Bearer ${openaiKey}` };
    const body = { model: 'gpt-test', messages: [{ role: 'user', content: `my key is ${openaiKey}` }] };
    const outputs = [];
    const scenarios = [
      recordingFetch(jsonAnswer(401, { error: { message: `Incorrect API key provided: ${openaiKey}`, code: 'invalid_api_key' } })),
      recordingFetch(() => {
        throw new TypeError(`getaddrinfo failed, Authorization: Bearer ${openaiKey}`);
      }),
      recordingFetch(answer(200, { 'content-type': 'text/event-stream' }, [`data: {"echo":"${openaiKey}"}\n\n`], { fail: true })),
    ];
    for (const fetch of scenarios) {
      const res = await handleRelay(jsonRequest('/api/relay/openai/v1/chat/completions', body, { headers }), { ...frontGuards(), roots: relayRoots({}), fetch });
      outputs.push(await readAll(res.body).catch(() => ''));
    }
    // An exception inside the handler: only the scrubbed error class reaches the log.
    const exploding = /** @type {any} */ ({ ...frontGuards(), roots: relayRoots({}), fetch: recordingFetch(jsonAnswer(200, {})) });
    Object.defineProperty(exploding, 'roots', { get: () => { throw new Error(`boom ${openaiKey}`); } });
    const crashed = await serveRelay(jsonRequest('/api/relay/openai/v1/chat/completions', body, { headers }), exploding);
    outputs.push(await crashed.text());
    assert.equal(crashed.status, 500);
    assert.ok(lines.length >= 1, 'the crash was logged');
    assert.deepEqual(leaked(lines.join('\n')), [], `console: ${lines.join(' | ')}`);
    // Only the stream itself may carry what the upstream sent back to the user who sent it.
    assert.deepEqual(leaked(outputs.slice(0, 2).concat(outputs.slice(3)).join('\n')), []);
  });

  it('holds for pool failover, parking and malformed key entries', async (t) => {
    const lines = spyConsole(t);
    const env = { NVIDIA_API_KEYS: `${KEYS[3]}, nvapi-${KEYS[0]}, ${testKey('nvidia', 2)}`, GROQ_API_KEYS: `${KEYS[4]} ${KEYS[4].slice(0, 10)}` };
    const fetch = recordingFetch(
      answer(429, { 'retry-after': '3' }, [`{"error":"${KEYS[3]} is rate limited"}`]),
      answer(401, {}, [`{"error":"bad key ${testKey('nvidia', 2)}"}`]),
    );
    const pools = buildPools(env, { fetch: /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (fetch)), now: () => Date.now() });
    const res = await handlePool(jsonRequest('/api/pool?provider=nvidia&path=%2Fv1%2Fchat%2Fcompletions', { model: NVIDIA_DEFAULT_MODEL, messages: [{ role: 'user', content: 'Hi' }] }), { ...frontGuards(), pools });
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.ok(lines.some((l) => l.includes('cooling')), 'the router logged its parking');
    assert.ok(lines.some((l) => l.includes('ignored 1 malformed')), 'malformed entries were counted');
    const all = `${lines.join('\n')}\n${text}`;
    assert.deepEqual(leaked(all), []);
    assert.ok(!all.includes(testKey('nvidia', 2)));
  });

  it('holds for the provider ping, which prints statuses only', async (t) => {
    const lines = spyConsole(t);
    /** @type {string[]} */
    const printed = [];
    const fetch = recordingFetch(jsonAnswer(401, { error: { message: `key ${KEYS[4]} invalid` } }));
    const result = await pingProvider({ id: 'groq', env: { GROQ_API_KEYS: KEYS[4] }, fetch: /** @type {any} */ (fetch), print: (l) => printed.push(l) });
    assert.equal(result.status, 'failed');
    assert.ok(printed.some((l) => l.startsWith('list: 401')));
    assert.deepEqual(leaked([...printed, ...lines].join('\n')), []);
    assert.ok(fetch.calls.length >= 2);
  });
});
