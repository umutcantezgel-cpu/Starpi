#!/usr/bin/env node
// Maintainer tool, not part of CI: checks the NVIDIA allowlist against the live API before the catalog
// changes. It reads the key pool from NVIDIA_API_KEYS (parsed exactly as the proxy parses it), asks
// GET /v1/models once which allowlisted ids exist, then sends one small streamed request per model,
// moving to the next key on 429. It prints only `id | status | first-byte ms | reasoning? | content?`
// and counts; keys, headers and response bodies are never printed. It uses real quota.
//
// Usage: NVIDIA_API_KEYS="<key>,<key>" npm run nvidia:ping
import { parseKeys } from '../api/_lib/env.js';
import { NVIDIA_MODELS, NVIDIA_PROXY, NVIDIA_UPSTREAM_URL } from '../src/js/models/nvidia-catalog.js';

const MODELS_URL = new URL('../models', NVIDIA_UPSTREAM_URL).href;
const PROMPT = 'Reply with one short sentence: what is 2 + 2?';
// Reasoning models spend tokens on reasoning_content first; 256 leaves room for a short answer.
const MAX_TOKENS = 256;
// How long a stream may run after its first byte before the probe stops reading.
const READ_LIMIT_MS = 60_000;
// Keys tried per model while the answer is 429.
const MAX_ATTEMPTS = 3;

/** @typedef {{ status: string, firstByteMs: number | null, reasoning: boolean, content: boolean }} Probe */

const { keys, invalid } = parseKeys(process.env.NVIDIA_API_KEYS);
if (keys.length === 0) {
  console.error('NVIDIA_API_KEYS holds no valid key (nvapi- and 64 characters)');
  process.exit(2);
}
console.log(`keys: ${keys.length} valid${invalid ? `, ${invalid} ignored` : ''}`);

let cursor = 0;
const nextKey = () => keys[cursor++ % keys.length];

/** @param {string} key */
function headers(key, accept = 'application/json') {
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: accept };
}

/** @returns {Promise<Set<string> | null>} the model ids the API lists, or null when the list failed */
async function listedIds() {
  try {
    const res = await fetch(MODELS_URL, { headers: headers(nextKey()), redirect: 'error', signal: AbortSignal.timeout(NVIDIA_PROXY.attemptTimeoutMs) });
    if (!res.ok) {
      await res.body?.cancel();
      console.log(`GET /v1/models: ${res.status}`);
      return null;
    }
    const body = await res.json();
    return new Set((Array.isArray(body?.data) ? body.data : []).map((/** @type {{ id?: unknown }} */ m) => m?.id).filter((id) => typeof id === 'string'));
  } catch (err) {
    console.log(`GET /v1/models: ${err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network error'}`);
    return null;
  }
}

/**
 * Marks what one SSE line carries. Lines that are not JSON data are skipped.
 * @param {string} line
 * @param {Probe} probe
 */
function scan(line, probe) {
  const data = line.startsWith('data:') ? line.slice(5).trim() : '';
  if (!data || data === '[DONE]') return;
  try {
    const delta = JSON.parse(data)?.choices?.[0]?.delta ?? {};
    if (delta.reasoning_content || delta.reasoning) probe.reasoning = true;
    if (delta.content) probe.content = true;
  } catch {
    // keep-alive comments and partial lines carry nothing to report
  }
}

/**
 * One streamed request with the proxy's first-byte timeout; stops reading once content arrived.
 * @param {(typeof NVIDIA_MODELS)[number]} model
 * @param {string} key
 * @returns {Promise<Probe>}
 */
async function streamOnce(model, key) {
  /** @type {Probe} */
  const probe = { status: '-', firstByteMs: null, reasoning: false, content: false };
  const started = performance.now();
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), NVIDIA_PROXY.attemptTimeoutMs);
  try {
    const res = await fetch(NVIDIA_UPSTREAM_URL, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: headers(key, 'text/event-stream'),
      body: JSON.stringify({ ...model.upstream, model: model.id, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS, stream: true }),
    });
    probe.status = String(res.status);
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return probe;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!probe.content) {
      const { done, value } = await reader.read();
      if (done) break;
      if (probe.firstByteMs === null) {
        probe.firstByteMs = Math.round(performance.now() - started);
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), READ_LIMIT_MS);
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) scan(line, probe);
    }
    await reader.cancel();
  } catch {
    if (probe.firstByteMs === null) probe.status = controller.signal.aborted ? 'timeout' : 'network error';
  } finally {
    clearTimeout(timer);
  }
  return probe;
}

/** @param {(typeof NVIDIA_MODELS)[number]} model */
async function probeModel(model) {
  let probe = await streamOnce(model, nextKey());
  for (let attempt = 1; attempt < Math.min(MAX_ATTEMPTS, keys.length) && probe.status === '429'; attempt++) {
    probe = await streamOnce(model, nextKey());
  }
  return probe;
}

const listed = await listedIds();
const missing = listed ? NVIDIA_MODELS.filter((m) => !listed.has(m.id)).map((m) => m.id) : [];
if (listed) console.log(missing.length ? `not listed by /v1/models: ${missing.join(', ')}` : `all ${NVIDIA_MODELS.length} ids are listed by /v1/models`);

const yesNo = (/** @type {boolean} */ flag) => (flag ? 'yes' : 'no');
let failed = 0;
console.log('id | status | first-byte ms | reasoning? | content?');
for (const model of NVIDIA_MODELS) {
  const probe = await probeModel(model);
  if (probe.status !== '200') failed++;
  console.log([model.id, probe.status, probe.firstByteMs ?? '-', yesNo(probe.reasoning), yesNo(probe.content)].join(' | '));
}
console.log(`${NVIDIA_MODELS.length - failed}/${NVIDIA_MODELS.length} models answered with 200`);
process.exitCode = failed || missing.length || !listed ? 1 : 0;
