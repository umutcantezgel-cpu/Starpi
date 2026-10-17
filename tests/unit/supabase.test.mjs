import './setup.mjs';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { afterEach, describe, it, mock } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

// Records every module the data layer asks for, to tell whether the Supabase library was loaded,
// fails the library's module while `libraryMissing` is set (as a browser does for a lost chunk),
// and while `libraryStalled` is set hands out a library module that finishes loading only when the
// test resolves `globalThis.__supabaseLibraryGate` (a download over a stalled network).
/** @type {string[]} */
const requested = [];
let libraryMissing = false;
let libraryStalled = false;
let stalledLoads = 0;
const stalledLibrary = () =>
  `data:text/javascript;base64,${Buffer.from(
    `await globalThis.__supabaseLibraryGate;\nexport { createClient } from ${JSON.stringify(new URL('../../src/js/supabase-lib.js', import.meta.url).href)};\n// load ${(stalledLoads += 1)}\n`,
  ).toString('base64')}`;
// module.registerHooks exists from Node 22.15; the tests that need it are skipped before that.
const hooks = typeof nodeModule.registerHooks === 'function';
const needsHooks = hooks ? {} : { skip: 'module.registerHooks needs Node 22.15 or later' };
nodeModule.registerHooks?.({
  resolve(specifier, context, nextResolve) {
    requested.push(specifier);
    if (libraryMissing && specifier.endsWith('/supabase-lib.js')) throw new TypeError(`Failed to fetch dynamically imported module: ${specifier}`);
    // (The stand-in itself imports the real module by its file: URL.)
    if (libraryStalled && specifier.endsWith('/supabase-lib.js') && !specifier.startsWith('file:')) return { url: stalledLibrary(), shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const loadedLibrary = () => requested.some((s) => s.startsWith('@supabase/'));

const supabase = await import('../../src/js/supabase.js');
const libraryAtImport = loadedLibrary();

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Supabase data layer', () => {
  it('answers the connection state synchronously without loading the library', needsHooks, () => {
    assert.equal(libraryAtImport, false);
    assert.equal(supabase.getConnection().status, 'pending');
    assert.equal(supabase.canSyncChats(), false);
    const off = supabase.onConnectionChange(() => {});
    assert.equal(typeof off, 'function');
    off();
    assert.equal(loadedLibrary(), false);
  });

  it('fails a query as a network error while the library does not load, and loads it for the next one', needsHooks, async () => {
    let requests = 0;
    globalThis.fetch = /** @type {typeof fetch} */ (
      async () => {
        requests += 1;
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
    );
    libraryMissing = true;
    try {
      const res = await supabase.listEntities();
      assert.equal(res.ok ? null : res.error.kind, 'network');
      assert.equal(requests, 0);
    } finally {
      libraryMissing = false;
    }
    assert.equal(loadedLibrary(), false);
    const again = await supabase.listEntities();
    assert.deepEqual(again, { ok: true, data: [] });
    assert.equal(loadedLibrary(), true);
  });

  it('answers a query with the client it loaded', async () => {
    /** @type {string[]} */
    const urls = [];
    globalThis.fetch = /** @type {typeof fetch} */ (
      async (input) => {
        urls.push(String(input instanceof Request ? input.url : input));
        return new Response(JSON.stringify([{ id: 'd1', title: 'Notes', source_type: 'file', summary: null, raw_content: null, tags: [], created_at: '2026-01-01T00:00:00Z' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    );
    const res = await supabase.listDocuments();
    assert.deepEqual(res.ok ? res.data.map((d) => d.title) : res.error, ['Notes']);
    assert.ok(urls.some((u) => u.startsWith('https://example-project.supabase.co/rest/v1/knowledge_documents?')), urls.join('\n'));
  });

  it('turns a failed request into a result instead of a rejection', async () => {
    globalThis.fetch = /** @type {typeof fetch} */ (
      async () => {
        throw new TypeError('Failed to fetch');
      }
    );
    const res = await supabase.searchKnowledge('launch');
    assert.equal(res.ok, false);
    assert.equal(res.ok ? null : res.error.kind, 'network');
  });
});

describe('Supabase library over a stalled network', () => {
  it('gives up on the library after the Supabase timeout, goes offline, and uses a load that arrives late', { ...needsHooks, timeout: 10_000 }, async () => {
    const { TIMEOUTS_MS } = await import('../../src/js/config.js');
    // A module instance of its own: the one above has its client already.
    /** @type {typeof import('../../src/js/supabase.js')} */
    const fresh = await import(`../../src/js/supabase.js?${'stalled'}`);
    /** @type {(value?: unknown) => void} */
    let openGate = () => {};
    /** @type {any} */ (globalThis).__supabaseLibraryGate = new Promise((resolve) => {
      openGate = resolve;
    });
    let requests = 0;
    globalThis.fetch = /** @type {typeof fetch} */ (
      async () => {
        requests += 1;
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
      }
    );
    mock.timers.enable({ apis: ['setTimeout'] });
    libraryStalled = true;
    try {
      const connecting = fresh.connect();
      const query = fresh.listEntities();
      await nextTurn();
      mock.timers.tick(TIMEOUTS_MS.supabase - 1);
      await nextTurn();
      assert.equal(fresh.getConnection().status, 'pending');
      mock.timers.tick(1);
      const state = await connecting;
      assert.equal(state.status, 'offline');
      assert.equal(state.authError?.kind, 'timeout');
      const res = await query;
      assert.equal(res.ok ? null : res.error.kind, 'timeout');
      assert.equal(requests, 0);
      assert.equal(stalledLoads, 1);
    } finally {
      mock.timers.reset();
      libraryStalled = false;
    }
    // The stalled download finishes after all: the next request uses it instead of loading again.
    openGate();
    await nextTurn();
    const loadsBefore = requested.filter((s) => s.endsWith('/supabase-lib.js')).length;
    const again = await fresh.listEntities();
    assert.deepEqual(again, { ok: true, data: [] });
    assert.equal(requested.filter((s) => s.endsWith('/supabase-lib.js')).length, loadsBefore);
    assert.equal(stalledLoads, 1);
    delete (/** @type {any} */ (globalThis).__supabaseLibraryGate);
  });
});

describe('classifyError', () => {
  it('reads a library chunk that does not load as a network failure, in the words of each browser', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://app.example/assets/supabase-ABC.js',
      'error loading dynamically imported module: https://app.example/assets/supabase-ABC.js',
      'Importing a module script failed.',
    ]) {
      assert.equal(supabase.classifyError(new TypeError(message)).kind, 'network', message);
    }
  });
});
