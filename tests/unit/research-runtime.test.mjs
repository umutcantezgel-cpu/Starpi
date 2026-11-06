// Which provider searches the web for a research report (src/js/research/runtime.js). OpenAI's web
// search terms require inline citation links wherever its results are shown, and a report shows its
// web part as plain paragraphs with its pages listed apart, so a report never searches with OpenAI:
// the next provider of the order with the person's key does, else the site's pool, else none. The
// chat's web passages (ai/hybrid.js browserWebSearch), which its answer cites inline, keep the
// whole order. Keys are fake values made at run time in an in-memory session area, the adapters
// are fakes that record each request, and nothing reaches the network.
import './setup.mjs';
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { browserWebSearch } from '../../src/js/ai/hybrid.js';
import { registerAdapter } from '../../src/js/ai/index.js';
import { removeKey, setKey } from '../../src/js/ai/keys.js';
import { runResearch } from '../../src/js/research/deep.js';
import { browserRuntime, RESEARCH_WEB_ORDER, WEB_ORDER } from '../../src/js/research/runtime.js';

/** @typedef {import('../../src/js/ai/contract.js').ProviderId} ProviderId */

/** A Web Storage stand-in: keys live in the tab's session storage, model choices in local storage. */
class MemoryStorage {
  constructor() {
    /** @type {Map<string, string>} */
    this.map = new Map();
  }
  /** @param {string} key */
  getItem(key) {
    return this.map.get(key) ?? null;
  }
  /** @param {string} key @param {string} value */
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  /** @param {string} key */
  removeItem(key) {
    this.map.delete(key);
  }
}
Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true, writable: true });
Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true, writable: true });

const PAGE = 'https://example.org/hall';
const ANSWER = 'The hall opened in 1907.';

/** @type {Array<{ provider: string, search: boolean }>} */
const requests = [];

/**
 * A fake adapter: records who was asked and whether with web search, and answers with one sentence
 * that rests on one page.
 * @param {ProviderId} id
 * @returns {import('../../src/js/ai/stream.js').SdkAdapter}
 */
function fakeAdapter(id) {
  return {
    kind: 'sdk',
    id,
    dialect: 'test',
    async *stream(req) {
      requests.push({ provider: req.provider, search: req.search?.enabled === true });
      yield { type: 'start', provider: id, model: req.model, requestId: null };
      yield { type: 'text', delta: ANSWER };
      yield { type: 'citation', url: PAGE, title: 'The hall', start: 0, end: ANSWER.length };
      yield { type: 'end', stopReason: 'end_turn' };
    },
  };
}

/** A fake key, made at run time. */
const fakeKey = (/** @type {string} */ id) => ['test', id, 'key', '0123456789'].join('-');

/**
 * Gives the person keys for exactly these providers of WEB_ORDER.
 * @param {readonly ProviderId[]} ids
 */
async function useKeys(ids) {
  for (const id of WEB_ORDER) {
    if (ids.includes(id)) await setKey(id, fakeKey(id));
    else await removeKey(id);
  }
}

/** The browser's research runtime with its routes, model calls and clock, over no documents. */
function researchRuntime() {
  return { ...browserRuntime(), backends: { search: async () => [], documents: async () => [] }, saveArtifact: async () => {} };
}

const job = () => ({ id: 'job-web', question: 'When did the hall open?', createdAt: Date.UTC(2026, 10, 6), locale: 'en', options: { web: true } });

/** @type {Array<() => void>} */
let unregister = [];
before(() => {
  unregister = WEB_ORDER.map((id) => registerAdapter(id, fakeAdapter(id)));
});
after(() => {
  for (const off of unregister) off();
});
afterEach(async () => {
  await useKeys([]);
  requests.length = 0;
});

describe('research runtime: the web part of a report', () => {
  it('leaves OpenAI, and only OpenAI, out of the order a report searches in', () => {
    assert.deepEqual(RESEARCH_WEB_ORDER, ['gemini', 'anthropic', 'xai', 'openrouter']);
    assert.deepEqual(RESEARCH_WEB_ORDER, WEB_ORDER.filter((id) => id !== 'openai'));
    assert.ok(WEB_ORDER.includes('openai'), 'the chat keeps OpenAI');
    assert.ok(Object.isFrozen(WEB_ORDER) && Object.isFrozen(RESEARCH_WEB_ORDER));
  });

  it('takes the next provider of the order where OpenAI would have been first', async () => {
    await useKeys(['openai', 'xai']);
    assert.equal((await browserRuntime({ webOrder: WEB_ORDER }).routes()).web?.provider, 'openai', 'OpenAI comes first in the whole order');
    assert.equal((await browserRuntime().routes()).web?.provider, 'xai');
    await useKeys(['openai', 'openrouter']);
    assert.equal((await browserRuntime().routes()).web?.provider, 'openrouter');
  });

  it('never searches with OpenAI for a report, whichever keys the person has', async () => {
    for (let mask = 1; mask < 1 << WEB_ORDER.length; mask++) {
      const ids = WEB_ORDER.filter((_, i) => mask & (1 << i));
      await useKeys(ids);
      const { web } = await browserRuntime().routes();
      assert.notEqual(web?.provider, 'openai', ids.join(', '));
      assert.equal(web?.provider ?? null, RESEARCH_WEB_ORDER.find((id) => ids.includes(id)) ?? null, ids.join(', '));
    }
  });

  it('runs the web search of a report with xAI when the person has keys for OpenAI and xAI', async () => {
    await useKeys(['openai', 'xai']);
    const out = await runResearch(job(), researchRuntime());
    assert.equal(out.parts.web?.status, 'done');
    assert.equal(out.parts.web?.provider?.id, 'xai');
    assert.deepEqual([...new Set(requests.filter((r) => r.search).map((r) => r.provider))], ['xai']);
  });

  it('leaves the web part off with only an OpenAI key and no site pool', async () => {
    await useKeys(['openai']);
    const out = await runResearch(job(), researchRuntime());
    assert.deepEqual({ status: out.parts.web?.status, reason: out.parts.web?.reason }, { status: 'off', reason: 'no_provider' });
    assert.deepEqual(requests.filter((r) => r.search), [], 'nothing searched the web');
  });
});

describe('research runtime: the chat keeps the whole order', () => {
  it('searches the web passages of a chat answer with OpenAI first, as before', async () => {
    await useKeys(['openai', 'xai']);
    const search = await browserWebSearch('en');
    assert.ok(search, 'a web search is set up');
    const answer = await search('When did the hall open?');
    assert.deepEqual(requests, [{ provider: 'openai', search: true }]);
    assert.deepEqual(answer.sources, [{ uri: PAGE, title: 'The hall' }]);
  });
});
