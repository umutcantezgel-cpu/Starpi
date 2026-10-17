#!/usr/bin/env node
// Records the event-stream fixtures of the adapter tests from the local provider fakes
// (scripts/fakes): each fixture is the raw text/event-stream body the fake sends for a request the
// adapter itself built. Streams no fake produces are written by hand next to them and are not
// touched here: anthropic/fallback.sse (a server-side fallback in the middle of an answer) and
// openai-chat/ollama-split-tags.sse (reasoning tags split over deltas, no [DONE]).
//
// Usage: node tests/fixtures/ai/record.mjs   (rewrites tests/fixtures/ai/<dialect>/*.sse)
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnthropicFake } from '../../../scripts/fakes/anthropic.mjs';
import { createGeminiFake } from '../../../scripts/fakes/gemini.mjs';
import { createOpenAiFake } from '../../../scripts/fakes/openai.mjs';
import { createAdapter } from '../../../src/js/ai/adapters/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const LOOKUP = { name: 'lookup', description: 'Looks a word up.', schema: { type: 'object', properties: { query: { type: 'string' } } }, sideEffects: false };

/**
 * @param {string} provider
 * @param {string} model
 * @param {string} text
 * @param {Record<string, unknown>} [extra]
 * @returns {any}
 */
const req = (provider, model, text, extra = {}) => ({ provider, model, messages: [{ role: 'user', content: [{ type: 'text', text }] }], ...extra });

/**
 * @param {string} base
 * @param {{ path: string, headers?: Record<string, string>, body?: unknown }} built
 * @param {Record<string, string>} auth
 */
async function record(base, built, auth) {
  const res = await fetch(base + built.path, { method: 'POST', headers: { ...built.headers, ...auth }, body: JSON.stringify(built.body) });
  return res.text();
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} text
 */
function save(dir, name, text) {
  mkdirSync(path.join(HERE, dir), { recursive: true });
  writeFileSync(path.join(HERE, dir, `${name}.sse`), text);
}

const anthropic = createAnthropicFake({ gapMs: 0 });
const openai = createOpenAiFake({ gapMs: 0 });
const gemini = createGeminiFake({ gapMs: 0 });
const a = (await anthropic.listen(0)).url;
const o = (await openai.listen(0)).url;
const g = (await gemini.listen(0)).url;

try {
  const claude = createAdapter('anthropic');
  const anthropicAuth = { 'x-api-key': 'fixture-key' };
  /** @type {Array<[string, any]>} */
  const anthropicCases = [
    ['text', req('anthropic', 'claude-opus-5-5', 'What is a fixture?', { thinking: { mode: 'on', show: true } })],
    ['tool', req('anthropic', 'claude-opus-5-5', 'Look it up [[fake:tool]]', { tools: [LOOKUP] })],
    ['search', req('anthropic', 'claude-sonnet-5-5', 'Search the topic', { search: { enabled: true }, thinking: { mode: 'off' } })],
    ['pause', req('anthropic', 'claude-sonnet-5-5', 'Search the topic [[fake:pause]]', { search: { enabled: true }, thinking: { mode: 'off' } })],
    ['refusal', req('anthropic', 'claude-opus-5-5', 'Something declined [[fake:refusal]]', { thinking: { mode: 'off' } })],
    ['redacted', req('anthropic', 'claude-opus-5-5', 'Hidden thoughts [[fake:redacted]]', { thinking: { mode: 'off' } })],
    ['length', req('anthropic', 'claude-haiku-5-5', 'A long answer [[fake:length]]', { thinking: { mode: 'off' } })],
    ['stream-error', req('anthropic', 'claude-haiku-5-5', 'Fails midway [[fake:stream-error]]', { thinking: { mode: 'off' } })],
  ];
  for (const [name, r] of anthropicCases) {
    const built = /** @type {any} */ (claude).buildRequest(r);
    save('anthropic', name, await record(a, built, anthropicAuth));
  }

  const responses = createAdapter('openai');
  const bearer = { authorization: 'Bearer fixture-key' };
  /** @type {Array<[string, any]>} */
  const responseCases = [
    ['reasoning', req('openai', 'gpt-5', 'Think first [[fake:reasoning]]', { thinking: { mode: 'on' } })],
    ['search', req('openai', 'gpt-5-mini', 'Search the topic', { search: { enabled: true } })],
    ['tool', req('openai', 'gpt-5-mini', 'Look it up [[fake:tool]]', { tools: [LOOKUP] })],
    ['refusal', req('openai', 'gpt-5-mini', 'Something declined [[fake:refusal]]')],
    ['length', req('openai', 'gpt-5-nano', 'A long answer [[fake:length]]')],
    ['failed', req('openai', 'gpt-5-nano', 'Fails [[fake:stream-error]]')],
  ];
  for (const [name, r] of responseCases) {
    const built = /** @type {any} */ (responses).buildRequest(r);
    save('openai-responses', name, await record(o, built, bearer));
  }

  /** @type {Array<[string, string, string, any]>} */
  const chatCases = [
    ['openai-text', 'openai', 'local', req('local', 'fake-gpt-small', 'Hello')],
    ['openai-tool', 'openai', 'local', req('local', 'fake-gpt-small', 'Look it up [[fake:tool]]', { tools: [LOOKUP] })],
    ['openai-refusal', 'openai', 'local', req('local', 'fake-gpt-small', 'Declined [[fake:refusal]]')],
    ['xai-reasoning', 'xai', 'xai', req('xai', 'fake-grok-reasoner', 'Think first [[fake:reasoning]]')],
    ['groq-reasoning', 'groq', 'groq', req('groq', 'fake-groq-reasoner', 'Think first [[fake:reasoning]]')],
    ['mistral-reasoning', 'mistral', 'mistral', req('mistral', 'fake-mistral-reasoner', 'Think first [[fake:reasoning]]')],
    ['mistral-tool', 'mistral', 'mistral', req('mistral', 'fake-mistral-small', 'Look it up [[fake:tool]]', { tools: [LOOKUP] })],
    ['mistral-length', 'mistral', 'mistral', req('mistral', 'fake-mistral-small', 'A long answer [[fake:length]]')],
    ['deepseek-reasoning', 'deepseek', 'deepseek', req('deepseek', 'fake-deepseek-reasoner', 'Think first [[fake:reasoning]]')],
    ['openrouter-reasoning', 'openrouter', 'openrouter', req('openrouter', 'fake/router-reasoner:free', 'Think first [[fake:reasoning]]')],
    ['openrouter-search', 'openrouter', 'openrouter', req('openrouter', 'fake/router-small', 'Search the topic', { search: { enabled: true } })],
    ['nvidia-text', 'nvidia', 'nvidia', req('nvidia', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'Hello')],
    ['ollama-reasoning', 'ollama', 'local', req('local', 'fake-local-reasoner:4b', 'Think first [[fake:reasoning]]')],
    ['stream-error', 'xai', 'xai', req('xai', 'fake-grok-fast', 'Fails [[fake:stream-error]]')],
  ];
  for (const [name, flavor, provider, r] of chatCases) {
    const built = /** @type {any} */ (createAdapter(/** @type {any} */ (provider))).buildRequest(r);
    save('openai-chat', name, await record(`${o}/flavor/${flavor}`, built, flavor === 'ollama' ? {} : bearer));
  }

  const gem = createAdapter('gemini');
  const google = { 'x-goog-api-key': 'fixture-key' };
  /** @type {Array<[string, any]>} */
  const geminiCases = [
    ['reasoning', req('gemini', 'gemini-2.5-flash', 'Think first [[fake:reasoning]]', { thinking: { mode: 'on' } })],
    ['tool', req('gemini', 'gemini-2.5-flash', 'Look it up [[fake:tool]]', { tools: [LOOKUP], thinking: { mode: 'on' } })],
    ['search', req('gemini', 'gemini-2.5-flash', 'Search the topic', { search: { enabled: true }, thinking: { mode: 'off' } })],
    ['search-de', req('gemini', 'gemini-2.5-flash', 'Was ist das für ein Thema?', { search: { enabled: true }, thinking: { mode: 'off' } })],
    ['blocked', req('gemini', 'gemini-2.5-flash', 'Declined [[fake:blocked]]', { thinking: { mode: 'off' } })],
    ['refusal', req('gemini', 'gemini-2.5-flash', 'Declined [[fake:refusal]]', { thinking: { mode: 'off' } })],
    ['length', req('gemini', 'gemini-2.5-flash-lite', 'A long answer [[fake:length]]', { thinking: { mode: 'off' } })],
    ['image', req('gemini', 'gemini-2.5-flash-image', 'Draw a square [[fake:image]]')],
  ];
  for (const [name, r] of geminiCases) {
    const built = /** @type {any} */ (gem).buildRequest(r);
    save('gemini', name, await record(g, built, google));
  }
} finally {
  await Promise.all([anthropic.close(), openai.close(), gemini.close()]);
}
console.log('fixtures recorded');
