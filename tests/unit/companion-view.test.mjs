// The companion's card under Settings and the Companion tab (src/js/companion/view.js) in a DOM,
// with a stand-in pairing: the probe runs only when "Connect the companion" is opened, pairing
// errors show the companion's code in words, a paired card shows the link and unpairs after
// asking, the red rollback banner, the tab's pages load only while the tab is shown, and German.
/* global document, window */
import './setup.mjs';
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';

const GLOBALS = ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLDetailsElement', 'SVGElement', 'NodeFilter', 'Text', 'MutationObserver', 'localStorage', 'sessionStorage', 'location'];

/** @type {typeof import('../../src/js/companion/view.js')} */
let view;
/** @type {typeof import('../../src/js/dom.js')} */
let dom;
/** @type {typeof import('../../src/js/i18n/index.js')} */
let i18n;
/** @type {typeof import('../../src/js/companion/client.js')} */
let client;

before(async () => {
  const jsdom = new JSDOM('<!doctype html><html><body><div id="toastRegion"></div></body></html>', { url: 'https://app.example/' });
  for (const key of GLOBALS) {
    const value = key === 'window' ? jsdom.window : key === 'document' ? jsdom.window.document : /** @type {any} */ (jsdom.window)[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom = await import('../../src/js/dom.js');
  dom.installDelegation();
  view = await import('../../src/js/companion/view.js');
  i18n = await import('../../src/js/i18n/index.js');
  client = await import('../../src/js/companion/client.js');
});

after(() => {
  for (const key of GLOBALS) delete (/** @type {any} */ (globalThis))[key];
});

afterEach(async () => {
  document.querySelectorAll('[data-test-host]').forEach((el) => el.remove());
  await i18n.setLocale('en');
});

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** @param {string} seq */
const head = (seq) => ({ seq: Number(seq), hash: 'a'.repeat(64), sig: 'b'.repeat(86) });

/**
 * A stand-in pairing.
 * @param {{ paired?: boolean, selfServed?: boolean, role?: 'owner' | 'member', routes?: Record<string, any> }} [opts]
 */
function fakePairing(opts = {}) {
  /** @type {any} */
  let state = {
    phase: opts.paired ? 'paired' : 'unpaired',
    mode: opts.paired ? 'bearer' : null,
    origin: 'http://127.0.0.1:47821',
    role: opts.paired ? (opts.role ?? 'owner') : null,
    session: opts.paired ? 'sess-1' : null,
    expiresAt: opts.paired ? '2099-01-01T00:00:00Z' : null,
    keyId: opts.paired ? 'c'.repeat(64) : null,
    lost: false,
    audit: { state: opts.paired ? 'ok' : 'unknown', stored: null, reported: null },
  };
  /** @type {Set<(s: any) => void>} */
  const listeners = new Set();
  /** @type {string[]} */
  const calls = [];
  const set = (/** @type {any} */ patch) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn(state);
  };
  const pairing = {
    state: () => state,
    subscribe: (/** @type {any} */ fn) => (listeners.add(fn), () => listeners.delete(fn)),
    selfServed: () => opts.selfServed === true,
    restore: async () => state,
    client: () => null,
    probe: async (/** @type {string} */ origin) => {
      calls.push(`probe:${origin}`);
      if (origin.endsWith(':1')) throw new client.CompanionError('unreachable');
      return { name: 'starpi-companion', version: '2.1.0', pairing: true };
    },
    pair: async (/** @type {{ code: string, origin?: string }} */ input) => {
      calls.push(`pair:${input.code}:${input.origin ?? ''}`);
      if (input.code !== 'ABCD-EFGH') throw new client.CompanionError('pairing_failed');
      set({ phase: 'paired', mode: 'bearer', role: 'owner', session: 'sess-1', expiresAt: '2099-01-01T00:00:00Z', keyId: 'c'.repeat(64), audit: { state: 'ok', stored: null, reported: null } });
      return state;
    },
    unpair: async () => {
      calls.push('unpair');
      set({ phase: 'unpaired', mode: null, role: null, session: null });
    },
    call: async (/** @type {string} */ method, /** @type {string} */ path) => {
      calls.push(`${method} ${path}`);
      const answer = opts.routes?.[`${method} ${path}`];
      if (answer === undefined) throw new client.CompanionError('not_found');
      return typeof answer === 'function' ? answer() : answer;
    },
    stream: async () => {},
    checkAudit: async () => state.audit,
    acceptCurrent: async () => {
      calls.push('accept');
      set({ audit: { ...state.audit, state: 'ok' } });
      return true;
    },
  };
  return { pairing: /** @type {any} */ (pairing), calls, set };
}

/** Shell services for a view in the test DOM. */
function services() {
  /** @type {Map<string, () => void>} */
  const tabHooks = new Map();
  /** @type {string[]} */
  const switched = [];
  return {
    tabHooks,
    switched,
    value: /** @type {any} */ ({
      onAction: dom.onAction,
      onChange: dom.onChange,
      onLocaleChange: i18n.onLocaleChange,
      onTabOpen: (/** @type {string} */ tab, /** @type {() => void} */ hook) => tabHooks.set(tab, hook),
      switchTab: (/** @type {string} */ tab) => switched.push(tab),
      setNavVisible: () => {},
      toast: () => () => {},
    }),
  };
}

function host(hidden = false) {
  const el = document.createElement('div');
  el.dataset.testHost = '';
  if (hidden) el.classList.add('hidden');
  document.body.append(el);
  return el;
}

/** @param {Element} el @param {string} selector */
function click(el, selector) {
  const target = /** @type {HTMLElement} */ (el.querySelector(selector));
  assert.ok(target, `no ${selector}`);
  target.click();
}

describe('Settings → Companion', () => {
  it('probes only when "Connect the companion" is opened, and pairs with the code and address', async () => {
    const { pairing, calls } = fakePairing();
    const el = host();
    view.mountCompanionSettings(el, services().value, { pairing });
    assert.match(el.textContent ?? '', /Not paired/);
    assert.deepEqual(calls, []);
    const details = /** @type {HTMLDetailsElement} */ (el.querySelector('[data-companion-connect]'));
    // Opening it fires its toggle event.
    details.open = true;
    await settle();
    assert.deepEqual(calls, ['probe:http://127.0.0.1:47821']);
    assert.match(el.querySelector('[data-companion-probe]')?.textContent ?? '', /Starpi Core 2\.1\.0 answers at http:\/\/127\.0\.0\.1:47821/);

    const origin = /** @type {HTMLInputElement} */ (el.querySelector('[data-companion-field="origin"]'));
    origin.value = 'http://127.0.0.1:1';
    origin.dispatchEvent(new window.Event('change'));
    await settle();
    assert.match(el.querySelector('[data-companion-probe]')?.textContent ?? '', /No companion answers/);

    origin.value = 'http://127.0.0.1:5000';
    const code = /** @type {HTMLInputElement} */ (el.querySelector('[data-companion-field="code"]'));
    code.value = 'WRONG-ONE';
    click(el, '[data-action="companion-pair"]');
    await settle();
    assert.match(el.querySelector('[data-companion-result]')?.textContent ?? '', /wrong or expired/);
    code.value = 'ABCD-EFGH';
    click(el, '[data-action="companion-pair"]');
    await settle();
    assert.ok(calls.includes('pair:ABCD-EFGH:http://127.0.0.1:5000'));
    assert.match(el.textContent ?? '', /This site, with a token kept sealed in this browser/);
  });

  it('refuses an address that is not on this computer before asking', async () => {
    const { pairing, calls } = fakePairing();
    const el = host();
    view.mountCompanionSettings(el, services().value, { pairing });
    /** @type {HTMLInputElement} */ (el.querySelector('[data-companion-field="origin"]')).value = 'https://example.org';
    /** @type {HTMLInputElement} */ (el.querySelector('[data-companion-field="code"]')).value = 'ABCD-EFGH';
    click(el, '[data-action="companion-pair"]');
    await settle();
    assert.equal(calls.length, 0);
    assert.match(el.querySelector('[data-companion-result]')?.textContent ?? '', /address on this computer/);
  });

  it('shows the link and unpairs only after asking', async () => {
    const { pairing, calls } = fakePairing({ paired: true });
    const el = host();
    let answer = false;
    view.mountCompanionSettings(el, services().value, { pairing, confirm: () => answer });
    assert.match(el.textContent ?? '', /http:\/\/127\.0\.0\.1:47821/);
    assert.match(el.textContent ?? '', /Owner/);
    click(el, '[data-action="companion-unpair"]');
    await settle();
    assert.equal(calls.includes('unpair'), false);
    answer = true;
    click(el, '[data-action="companion-unpair"]');
    await settle();
    assert.equal(calls.includes('unpair'), true);
    assert.match(el.textContent ?? '', /Not paired/);
  });

  it('asks for the code directly in a build the companion serves', () => {
    const { pairing } = fakePairing({ selfServed: true });
    const el = host();
    view.mountCompanionSettings(el, services().value, { pairing });
    assert.equal(el.querySelector('[data-companion-connect]'), null);
    assert.equal(el.querySelector('[data-companion-field="origin"]'), null);
    assert.ok(el.querySelector('[data-companion-field="code"]'));
  });
});

describe('audit rollback banner', () => {
  it('names both records and offers to check again and to accept', () => {
    const markup = String(view.auditBanner({ state: 'rollback', stored: { keyId: 'k', seq: 120, hash: 'a'.repeat(64), sig: '', at: '' }, reported: head('20') }));
    assert.match(markup, /data-companion-banner="rollback"/);
    assert.match(markup, /role="alert"/);
    assert.match(markup, /reports record 20, but this browser already saw record 120/);
    assert.match(markup, /companion-audit-check/);
    assert.match(markup, /companion-audit-accept/);
    assert.equal(view.auditBanner({ state: 'ok', stored: null, reported: null }), '');
    assert.doesNotMatch(String(view.auditBanner({ state: 'invalid', stored: null, reported: head('3') })), /companion-audit-accept/);
  });

  it('shows on the card while the check fails, and goes once the state is accepted', async () => {
    const { pairing, set, calls } = fakePairing({ paired: true });
    const el = host();
    view.mountCompanionSettings(el, services().value, { pairing, confirm: () => true });
    assert.equal(el.querySelector('[data-companion-banner]'), null);
    set({ audit: { state: 'fork', stored: { keyId: 'k', seq: 9, hash: 'a'.repeat(64), sig: '', at: '' }, reported: head('9') } });
    assert.ok(el.querySelector('[data-companion-banner="fork"]'));
    click(el, '[data-action="companion-audit-accept"]');
    await settle();
    assert.ok(calls.includes('accept'));
    assert.equal(el.querySelector('[data-companion-banner]'), null);
  });
});

describe('Companion tab', () => {
  const routes = {
    'GET /v1/status': { version: '2.1.0', profile: 'minimal', timeZone: 'Europe/Paris', startedAt: '2026-10-19T08:00:00Z', breaker: { level: 'steady' }, sessions: 1, egress: { guarded: true, allow: { brains: ['api.example.com:443'] } }, brains: [{ id: 'local', locality: 'local', model: 'small-model', resting: false }], audit: { head: { seq: 7, hash: 'd'.repeat(64) }, anchors: { count: 2 } } },
    'GET /v1/docs': { documents: [{ id: 'doc-1', name: 'guide.txt', dataClass: 'personal', status: 'indexed', bytes: 2048 }] },
    'GET /v1/memory/notes': { notes: [{ id: 'note-1', title: 'Parking', dataClass: 'public', pinned: true, updated: '2026-10-19T09:00:00Z' }] },
    'GET /v1/agenda': { timeZone: 'Europe/Paris', items: [{ id: 'agd-1', title: 'Water the plants', rule: { type: 'weekly', days: [1, 4], time: '09:00' }, nextLocal: '2026-10-20 09:00' }] },
  };

  it('asks the companion nothing while the tab is hidden, and loads the page when it opens', async () => {
    const { pairing, calls } = fakePairing({ paired: true, routes });
    const s = services();
    const el = host(true);
    view.mountCompanionTab(el, s.value, { pairing });
    await settle();
    assert.deepEqual(calls, []);
    el.classList.remove('hidden');
    s.tabHooks.get('companion')?.();
    await settle();
    assert.deepEqual(calls, ['GET /v1/status']);
    const text = el.textContent ?? '';
    assert.match(text, /Europe\/Paris/);
    assert.match(text, /api\.example\.com:443/);
    assert.match(text, /small-model/);
    assert.match(text, /#7/);
  });

  it('shows documents, notes and agenda from the companion', async () => {
    const { pairing } = fakePairing({ paired: true, routes });
    const el = host();
    view.mountCompanionTab(el, services().value, { pairing });
    await settle();
    click(el, '[data-action="companion-page"][data-arg="documents"]');
    await settle();
    assert.match(el.querySelector('[data-companion-list="documents"]')?.textContent ?? '', /guide\.txt.*Personal.*Ready.*2 KB/s);
    click(el, '[data-action="companion-page"][data-arg="notes"]');
    await settle();
    assert.match(el.querySelector('[data-companion-list="notes"]')?.textContent ?? '', /Parking.*Public/s);
    click(el, '[data-action="companion-page"][data-arg="agenda"]');
    await settle();
    assert.match(el.querySelector('[data-companion-list="agenda"]')?.textContent ?? '', /Water the plants.*Mon, Thu at 09:00.*next 2026-10-20 09:00/s);
  });

  it('hides the owner pages from a member and shows a failed page with its reason', async () => {
    const { pairing } = fakePairing({ paired: true, role: 'member', routes: {} });
    const el = host();
    view.mountCompanionTab(el, services().value, { pairing });
    await settle();
    assert.equal(el.querySelector('[data-arg="devices"]'), null);
    assert.equal(el.querySelector('[data-arg="setup"]'), null);
    assert.match(el.textContent ?? '', /The companion does not have this/);
    assert.ok(el.querySelector('[data-action="companion-reload"]'));
  });

  it('names the state of each MCP server in words, with a tone that fits', async () => {
    const connectors = {
      'GET /v1/connectors': { servers: [{ id: 'files', title: 'Files', url: 'http://127.0.0.1:8931/mcp', state: 'up', tools: [] }, { id: 'hours', title: 'Hours', url: 'http://127.0.0.1:8932/mcp', state: 'down', tools: [] }, { id: 'wiki', title: 'Wiki', url: 'http://127.0.0.1:8933/mcp', state: 'unknown', tools: [] }] },
      'GET /v1/connectors/approvals': { approvals: [] },
    };
    const { pairing } = fakePairing({ paired: true, routes: connectors });
    const el = host();
    view.mountCompanionTab(el, services().value, { pairing });
    await settle();
    click(el, '[data-action="companion-page"][data-arg="connectors"]');
    await settle();
    const chips = [...el.querySelectorAll('.chip')].map((c) => `${c.className.match(/chip-(\w+)/)?.[1]}:${c.textContent?.trim()}`);
    assert.ok(chips.includes('ok:reachable'), chips.join(', '));
    assert.ok(chips.includes('warn:not reachable'));
    assert.ok(chips.includes('neutral:not checked yet'));
    assert.doesNotMatch(el.textContent ?? '', /\b(up|down|unknown)\b/, 'no raw state');
    await i18n.setLocale('de');
    assert.match(String(view.connectorStateChip('down')), /nicht erreichbar/);
    assert.match(String(view.connectorStateChip('something else')), /noch nicht geprüft/);
  });

  it('explains the companion\u2019s new error codes instead of naming them', async () => {
    for (const code of ['conversation_busy', 'conversation_unknown', 'connector_down']) {
      const key = view.errorLabel(new client.CompanionError(code));
      assert.equal(key, `companion.error.${code}`);
      for (const locale of ['en', 'de', 'fr', 'es', 'it', 'tr']) {
        await i18n.setLocale(locale);
        assert.doesNotMatch(i18n.t(/** @type {string} */ (key)), new RegExp(`${code}|companion\\.error`), `${code} in ${locale}`);
      }
      await i18n.setLocale('en');
    }
  });

  it('sends an unpaired browser to Settings', () => {
    const { pairing } = fakePairing();
    const s = services();
    const el = host();
    view.mountCompanionTab(el, s.value, { pairing });
    assert.match(el.textContent ?? '', /No companion paired/);
    click(el, '[data-action="companion-to-settings"]');
    assert.deepEqual(s.switched, ['settings']);
  });

  it('speaks German', async () => {
    await i18n.setLocale('de');
    const { pairing } = fakePairing({ paired: true, routes });
    const el = host();
    view.mountCompanionTab(el, services().value, { pairing });
    await settle();
    const text = el.textContent ?? '';
    assert.match(text, /Lastschutz/);
    assert.match(text, /Internetzugang/);
    assert.match(text, /Protokoll in Ordnung/);
  });
});
