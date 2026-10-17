import './setup.mjs';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { describe, it, mock } from 'node:test';

// A browser that starts offline: navigator.onLine is false, and the window's `online` event is
// stood in for by an EventTarget. The Supabase library never loads here (as over a dead network),
// so a real second attempt shows up as a different error than the offline short cut of the first.
const hooks = typeof nodeModule.registerHooks === 'function';
const needsHooks = hooks ? {} : { skip: 'module.registerHooks needs Node 22.15 or later' };
nodeModule.registerHooks?.({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/supabase-lib.js')) throw new TypeError(`Failed to fetch dynamically imported module: ${specifier}`);
    return nextResolve(specifier, context);
  },
});

const windowEvents = new EventTarget();
globalThis.addEventListener = windowEvents.addEventListener.bind(windowEvents);
globalThis.removeEventListener = windowEvents.removeEventListener.bind(windowEvents);
let online = false;
Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, get: () => online });
// The retry delays (30 s and more) must neither run nor keep the test process alive.
mock.timers.enable({ apis: ['setTimeout'] });

const supabase = await import('../../src/js/supabase.js');

describe('Supabase reconnect after an offline start', () => {
  it('tries again when the browser reports a connection, not only after a reload', needsHooks, async () => {
    const first = await supabase.connect();
    assert.equal(first.status, 'offline');
    assert.equal(first.probeError?.message, 'The browser is offline');

    online = true;
    windowEvents.dispatchEvent(new Event('online'));
    const second = await supabase.connect();
    assert.equal(second.status, 'offline');
    assert.equal(second.probeError?.kind, 'network');
    assert.notEqual(second.probeError?.message, 'The browser is offline', 'the online event started a new attempt');
  });

  it('tries again when the retry delay ends', needsHooks, async () => {
    const before = supabase.getConnection().probeError?.message;
    mock.timers.tick(300_000);
    const again = await supabase.connect();
    assert.equal(again.status, 'offline');
    assert.match(String(again.probeError?.message), /supabase-lib\.js/);
    assert.equal(typeof before, 'string');
  });
});
