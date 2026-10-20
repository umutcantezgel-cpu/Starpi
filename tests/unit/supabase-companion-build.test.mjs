import './setup.mjs';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { describe, it, mock } from 'node:test';

// A build the companion serves (profile `companion`) may reach its own origin only: the library
// is never loaded, connect() ends offline at once without scheduling a retry, and queries answer
// as if the network were gone, without a single request.
const hooks = typeof nodeModule.registerHooks === 'function';
const needsHooks = hooks ? {} : { skip: 'module.registerHooks needs Node 22.15 or later' };
/** @type {string[]} */
const libraryLoads = [];
nodeModule.registerHooks?.({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/supabase-lib.js')) libraryLoads.push(specifier);
    return nextResolve(specifier, context);
  },
});

Object.defineProperty(globalThis, '__STARPI_PROFILE__', { value: 'companion', configurable: true });
/** @type {string[]} */
const requests = [];
globalThis.fetch = async (input) => {
  requests.push(String(input));
  throw new TypeError('fetch failed');
};
mock.timers.enable({ apis: ['setTimeout'] });
const timeouts = mock.method(globalThis, 'setTimeout');

const supabase = await import('../../src/js/supabase.js');

describe('the library in a build the companion serves', () => {
  it('is never loaded: the connection ends offline at once and is not retried', needsHooks, async () => {
    const state = await supabase.connect();
    assert.equal(state.status, 'offline');
    assert.equal(state.probeError?.kind, 'network');
    assert.equal(timeouts.mock.callCount(), 0, 'no retry scheduled');
    assert.deepEqual(libraryLoads, []);
    assert.deepEqual(requests, []);
  });

  it('answers queries as offline without any request', needsHooks, async () => {
    const found = await supabase.searchKnowledge('opening hours');
    assert.equal(found.ok, false);
    assert.equal(found.ok === false && found.error.kind, 'network');
    const account = await supabase.syncAccount();
    assert.equal(account.ok, false);
    assert.equal(supabase.getConnection().status, 'offline');
    assert.deepEqual(libraryLoads, []);
    assert.deepEqual(requests, []);
  });
});
