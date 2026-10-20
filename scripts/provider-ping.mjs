#!/usr/bin/env node
// Maintainer tool, not part of CI: checks one provider live with a real key before its catalog,
// pool allowlist or relay entry changes. Without a key it prints "skipped" and exits 0, so it is
// safe to run anywhere. With a key it
//   - lists the provider's models (or voices, or one search) and counts the entries; a provider
//     without a model list (MiniMax) answers one small chat request instead,
//   - asks whether the API allows browser calls (a CORS preflight from a foreign origin),
//   - for a site pool: sends one small streamed request per allowlisted model (or --model) and
//     names the allowlisted ids the list does not contain.
// It prints statuses, timings and model ids only; keys, headers and response bodies are never
// printed, and every line goes through the relay's secret scrubber. It uses real quota.
//
// Usage: node scripts/provider-ping.mjs --provider <id> [--model <id>]
//   keys: the pool variable (MINIMAX_API_KEYS, NVIDIA_API_KEYS, GROQ_API_KEYS, GEMINI_API_KEYS, OPENROUTER_API_KEYS)
//   or <ID>_API_KEY (ANTHROPIC_API_KEY, OPENAI_API_KEY, ELEVENLABS_API_KEY, BRAVE_API_KEY, ...);
//   STARPI_<ID>_BASE_URL points it at a local fake. `npm run nvidia:ping` keeps its own report.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPoolModel, findPoolSpec, MINIMAX_POOL_UPSTREAM, parsePoolKeys } from '../api/_lib/pool/allowlist.js';
import { poolRoute, validatePoolRequest } from '../api/_lib/pool/request.js';
import { scrubSecrets } from '../api/_lib/relay/scrub.js';
import { authHeaderFor, findUpstream, RELAY_PROVIDERS, resolveRoot } from '../api/_lib/relay/upstreams.js';

const PROMPT = 'Reply with one short sentence: what is 2 + 2?';
const TIMEOUT_MS = 20_000;
const READ_LIMIT_MS = 60_000;
const MAX_TOKENS = 256;
const PROBE_ORIGIN = 'https://example.com';
const SINGLE_KEY = /^[\x21-\x7e]{8,1024}$/;

/**
 * @typedef {{ id: string, env: Record<string, string | undefined>, fetch?: typeof fetch, print?: (line: string) => void, model?: string }} PingOptions
 * @typedef {{ status: 'skipped' | 'ok' | 'failed', lines: string[] }} PingResult
 */

/**
 * What one list check asks for: a GET of the models (or voices, or one search), Tavily's POST, or
 * for a provider without a model list one small chat request (`models: false`: its answer names no
 * models to compare with a pool allowlist).
 * @param {string} id
 * @returns {{ method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>, count: (json: any) => number, models?: false }}
 */
function listCheck(id) {
  const data = (/** @type {any} */ json) => (Array.isArray(json?.data) ? json.data.length : 0);
  switch (id) {
    case 'minimax':
      return {
        method: 'POST',
        path: '/v1/chat/completions',
        body: { model: findPoolSpec('minimax')?.defaultModel, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS, ...MINIMAX_POOL_UPSTREAM },
        count: (json) => (Array.isArray(json?.choices) ? json.choices.length : 0),
        models: false,
      };
    case 'anthropic':
      return { method: 'GET', path: '/v1/models', headers: { 'anthropic-version': '2023-06-01' }, count: data };
    case 'gemini':
      return { method: 'GET', path: '/v1beta/models', count: (json) => (Array.isArray(json?.models) ? json.models.length : 0) };
    case 'elevenlabs':
      return { method: 'GET', path: '/v1/voices', count: (json) => (Array.isArray(json?.voices) ? json.voices.length : 0) };
    case 'brave':
      return { method: 'GET', path: '/res/v1/web/search?q=test&count=1', count: (json) => (Array.isArray(json?.web?.results) ? json.web.results.length : 0) };
    case 'tavily':
      return { method: 'POST', path: '/search', body: { query: 'test', max_results: 1 }, count: (json) => (Array.isArray(json?.results) ? json.results.length : 0) };
    default:
      return { method: 'GET', path: '/v1/models', count: data };
  }
}

/**
 * Listed model ids, for the pool allowlist comparison.
 * @param {string} id
 * @param {any} json
 * @returns {Set<string>}
 */
function listedIds(id, json) {
  if (id === 'gemini') return new Set((json?.models ?? []).map((/** @type {any} */ m) => String(m?.name ?? '').replace(/^models\//, '')));
  return new Set((json?.data ?? []).map((/** @type {any} */ m) => m?.id).filter((/** @type {unknown} */ v) => typeof v === 'string'));
}

/**
 * The keys for a provider: its pool variable, else <ID>_API_KEY.
 * @param {string} id
 * @param {Record<string, string | undefined>} env
 * @returns {{ keys: string[], variables: string[] }}
 */
function keysFor(id, env) {
  const single = `${id.toUpperCase()}_API_KEY`;
  const spec = findPoolSpec(id);
  if (spec) {
    const { keys } = parsePoolKeys(spec, env[spec.keysVariable]);
    if (keys.length > 0) return { keys, variables: [spec.keysVariable] };
  }
  const value = (env[single] ?? '').trim();
  return { keys: SINGLE_KEY.test(value) ? [value] : [], variables: spec ? [spec.keysVariable, single] : [single] };
}

/**
 * @param {typeof fetch} send
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} ms
 */
async function timed(send, url, init, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return { res: await send(url, { ...init, redirect: 'error', signal: controller.signal }), error: null };
  } catch {
    return { res: null, error: controller.signal.aborted ? 'timeout' : 'network error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One streamed request to a pool model; reads until content arrives.
 * @param {typeof fetch} send
 * @param {import('../api/_lib/pool/allowlist.js').PoolSpec} spec
 * @param {import('../api/_lib/pool/allowlist.js').PoolModel} model
 * @param {[string, string]} auth
 */
async function streamOnce(send, spec, model, auth) {
  const data = spec.dialect === 'gemini'
    ? { contents: [{ role: 'user', parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: MAX_TOKENS } }
    : { model: model.id, messages: [{ role: 'user', content: PROMPT }], max_tokens: MAX_TOKENS };
  const route = poolRoute(spec, spec.dialect === 'gemini' ? `/v1beta/models/${model.id}:streamGenerateContent?alt=sse` : '/v1/chat/completions');
  if (!route.ok) return { status: 'invalid path', firstByteMs: null, content: false };
  const built = validatePoolRequest(spec, route, data);
  if (!built.ok) return { status: built.error, firstByteMs: null, content: false };
  const started = performance.now();
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  /** @type {{ status: string, firstByteMs: number | null, content: boolean }} */
  const probe = { status: '-', firstByteMs: null, content: false };
  try {
    const res = await send(built.url, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: { [auth[0]]: auth[1], 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(built.body),
    });
    probe.status = String(res.status);
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      return probe;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!probe.content) {
      const { done, value } = await reader.read();
      if (done) break;
      if (probe.firstByteMs === null) {
        probe.firstByteMs = Math.round(performance.now() - started);
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(), READ_LIMIT_MS);
      }
      text += decoder.decode(value, { stream: true });
      // Content arrived: an OpenAI-style delta with text, or a Gemini part with text.
      probe.content = /"content":"[^"]|"text":"[^"]/.test(text);
    }
    await reader.cancel();
  } catch {
    if (probe.firstByteMs === null) probe.status = controller.signal.aborted ? 'timeout' : 'network error';
  } finally {
    clearTimeout(timer);
  }
  return probe;
}

/**
 * Pings one provider and reports through `print`.
 * @param {PingOptions} options
 * @returns {Promise<PingResult>}
 */
export async function pingProvider({ id, env, fetch: send = fetch, print = (line) => console.log(line), model }) {
  /** @type {string[]} */
  const lines = [];
  const say = (/** @type {string} */ line) => {
    const clean = scrubSecrets(line);
    lines.push(clean);
    print(clean);
  };
  const upstream = findUpstream(id);
  if (!upstream) {
    say(`unknown provider ${id.slice(0, 40)}; known: ${RELAY_PROVIDERS.join(', ')}`);
    return { status: 'failed', lines };
  }
  const { keys, variables } = keysFor(id, env);
  if (keys.length === 0) {
    say(`${id}: skipped (no key in ${variables.join(' or ')})`);
    return { status: 'skipped', lines };
  }
  const { root, simulated } = resolveRoot(id, upstream.root, env);
  say(`${id}: ${keys.length} key${keys.length === 1 ? '' : 's'}${simulated ? ', simulated provider' : ''}`);
  let failed = false;
  let cursor = 0;
  const nextKey = () => keys[cursor++ % keys.length];

  const check = listCheck(id);
  const auth = authHeaderFor(upstream.auth, nextKey());
  const listed = await timed(send, root + check.path, {
    method: check.method,
    headers: { [auth[0]]: auth[1], ...(check.headers ?? {}), ...(check.body ? { 'Content-Type': 'application/json' } : {}) },
    ...(check.body ? { body: JSON.stringify(check.body) } : {}),
  }, TIMEOUT_MS);
  /** @type {any} */
  let listJson = null;
  if (!listed.res) {
    failed = true;
    say(`list: ${listed.error}`);
  } else {
    try {
      listJson = listed.res.ok ? await listed.res.json() : null;
    } catch {
      listJson = null;
    }
    if (!listed.res.ok) await listed.res.body?.cancel().catch(() => {});
    if (!listed.res.ok) failed = true;
    say(`list: ${listed.res.status}${listJson ? ` (${check.count(listJson)} entries)` : ''}`);
  }

  // A browser on a foreign origin may call the API directly only when the preflight allows it.
  const preflight = await timed(send, root + check.path.split('?')[0], {
    method: 'OPTIONS',
    headers: { Origin: PROBE_ORIGIN, 'Access-Control-Request-Method': check.method, 'Access-Control-Request-Headers': [auth[0], 'content-type'].join(', ') },
  }, TIMEOUT_MS);
  const allowed = preflight.res?.headers.get('access-control-allow-origin');
  await preflight.res?.body?.cancel().catch(() => {});
  say(`browser access (CORS): ${preflight.res ? (allowed === '*' || allowed === PROBE_ORIGIN ? 'yes' : 'no') : preflight.error}`);

  const spec = findPoolSpec(id);
  if (spec) {
    const poolSpec = { ...spec, root };
    if (listJson && check.models !== false) {
      const ids = listedIds(id, listJson);
      const missing = spec.models.filter((m) => !ids.has(m.id)).map((m) => m.id);
      say(missing.length ? `not listed: ${missing.join(', ')}` : `all ${spec.models.length} allowlisted ids are listed`);
      if (missing.length) failed = true;
    }
    const models = model ? [findPoolModel(spec, model)].filter((m) => m !== undefined) : spec.models;
    if (model && models.length === 0) {
      say(`${model.slice(0, 100)} is not in the ${id} pool allowlist`);
      failed = true;
    }
    say('id | status | first-byte ms | content?');
    for (const m of models) {
      const probe = await streamOnce(send, poolSpec, m, authHeaderFor(spec.auth, nextKey()));
      if (probe.status !== '200' || !probe.content) failed = true;
      say([m.id, probe.status, probe.firstByteMs ?? '-', probe.content ? 'yes' : 'no'].join(' | '));
    }
  }
  return { status: failed ? 'failed' : 'ok', lines };
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    out[m[1]] = m[2] ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.provider) {
    console.log(`usage: node scripts/provider-ping.mjs --provider <${RELAY_PROVIDERS.join('|')}> [--model <id>]`);
    process.exit(2);
  }
  const result = await pingProvider({ id: args.provider, env: process.env, model: args.model });
  process.exitCode = result.status === 'failed' ? 1 : 0;
}
