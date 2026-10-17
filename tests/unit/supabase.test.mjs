import './setup.mjs';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { afterEach, describe, it } from 'node:test';

// Records every module the data layer asks for, to tell whether the Supabase library was loaded,
// and fails the library's module while `libraryMissing` is set (as a browser does for a lost chunk).
/** @type {string[]} */
const requested = [];
let libraryMissing = false;
// module.registerHooks exists from Node 22.15; the tests that need it are skipped before that.
const hooks = typeof nodeModule.registerHooks === 'function';
const needsHooks = hooks ? {} : { skip: 'module.registerHooks needs Node 22.15 or later' };
nodeModule.registerHooks?.({
  resolve(specifier, context, nextResolve) {
    requested.push(specifier);
    if (libraryMissing && specifier.endsWith('/supabase-lib.js')) throw new TypeError(`Failed to fetch dynamically imported module: ${specifier}`);
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
